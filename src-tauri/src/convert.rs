// File conversions that run inside the app, so Windows needs no ImageMagick,
// Poppler or LibreOffice: images and PDFs are handled with `image`/`lopdf`,
// and Office/Hangul documents are exported by the Office or Hancom program
// already installed on the PC (COM automation through PowerShell).
use image::{DynamicImage, ImageFormat, ImageReader, Rgb, RgbImage};
use lopdf::{dictionary, Document, Object, ObjectId, Stream};
use std::collections::BTreeMap;
use std::fs;
use std::io::{BufReader, Cursor};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

pub const RASTER_IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "bmp", "webp", "tif", "tiff"];
pub const WINDOWS_OFFICE_EXTENSIONS: &[&str] = &["doc", "docx", "rtf", "odt", "xls", "xlsx", "ods", "ppt", "pptx", "odp", "hwp", "hwpx"];

pub fn extension(path: &Path) -> String {
    path.extension().map(|value| value.to_string_lossy().to_ascii_lowercase()).unwrap_or_default()
}

fn stem(path: &Path) -> String {
    path.file_stem().map(|value| value.to_string_lossy().into_owned()).unwrap_or_else(|| "변환".to_string())
}

/// Never overwrites: `name.pdf`, then `name (2).pdf`, `name (3).pdf`, …
pub fn unique_output(path: PathBuf) -> Result<PathBuf, String> {
    if !path.exists() {
        return Ok(path);
    }
    let directory = path.parent().map(Path::to_path_buf).unwrap_or_default();
    let base = stem(&path);
    let ext = extension(&path);
    (2..10000)
        .map(|index| directory.join(format!("{base} ({index}).{ext}")))
        .find(|candidate| !candidate.exists())
        .ok_or_else(|| "변환 결과 파일 이름을 만들 수 없습니다.".to_string())
}

fn multi_name(paths: &[PathBuf], ext: &str) -> String {
    if paths.len() == 1 {
        format!("{}.{ext}", stem(&paths[0]))
    } else {
        format!("{} 외 {}개.{ext}", stem(&paths[0]), paths.len() - 1)
    }
}

// ---------- images ----------

fn flatten_to_rgb(image: &DynamicImage) -> RgbImage {
    // Transparent pixels become white, like printing on paper.
    let rgba = image.to_rgba8();
    let mut rgb = RgbImage::new(rgba.width(), rgba.height());
    for (x, y, pixel) in rgba.enumerate_pixels() {
        let [r, g, b, a] = pixel.0;
        let alpha = u16::from(a);
        let blend = |channel: u8| ((u16::from(channel) * alpha + 255 * (255 - alpha)) / 255) as u8;
        rgb.put_pixel(x, y, Rgb([blend(r), blend(g), blend(b)]));
    }
    rgb
}

const DRM_MESSAGE: &str = "보안(DRM) 프로그램이 암호화한 파일이라 열 수 없습니다. 보안을 해제한 사본으로 다시 시도하세요.";

/// Document-security agents (e.g. DRMONE) wrap files in their own encrypted
/// container; only authorized programs can read them, so report that
/// plainly instead of a parse error.
fn is_drm_wrapped(path: &Path) -> bool {
    use std::io::Read;
    let mut header = [0u8; 16];
    fs::File::open(path)
        .and_then(|mut file| file.read(&mut header))
        .map(|read| header[..read].windows(6).any(|window| window == b"DRMONE"))
        .unwrap_or(false)
}

fn open_image(path: &Path) -> Result<DynamicImage, String> {
    if is_drm_wrapped(path) {
        return Err(DRM_MESSAGE.to_string());
    }
    ImageReader::open(path)
        .map_err(|error| format!("{}: {error}", path.display()))?
        .with_guessed_format()
        .map_err(|error| format!("{}: {error}", path.display()))?
        .decode()
        .map_err(|error| format!("이미지를 읽지 못했습니다 ({}): {error}", path.display()))
}

/// Returns the image XObject stream and its pixel size. Baseline RGB or
/// grayscale JPEGs are embedded as-is (no quality loss, small files);
/// everything else is decoded and stored losslessly.
fn image_xobject(path: &Path) -> Result<(Stream, u32, u32), String> {
    if is_drm_wrapped(path) {
        return Err(DRM_MESSAGE.to_string());
    }
    let bytes = fs::read(path).map_err(|error| format!("{}: {error}", path.display()))?;
    let format = image::guess_format(&bytes).ok();
    if format == Some(ImageFormat::Jpeg) {
        let decoder = image::codecs::jpeg::JpegDecoder::new(Cursor::new(&bytes)).map_err(|error| error.to_string());
        if let Ok(decoder) = decoder {
            use image::ImageDecoder;
            let (width, height) = decoder.dimensions();
            let color_space = match decoder.color_type() {
                image::ColorType::Rgb8 => Some("DeviceRGB"),
                image::ColorType::L8 => Some("DeviceGray"),
                _ => None,
            };
            if let Some(color_space) = color_space {
                let dict = dictionary! {
                    "Type" => "XObject", "Subtype" => "Image",
                    "Width" => width as i64, "Height" => height as i64,
                    "ColorSpace" => color_space, "BitsPerComponent" => 8,
                    "Filter" => "DCTDecode",
                };
                return Ok((Stream::new(dict, bytes), width, height));
            }
        }
    }
    let image = open_image(path)?;
    let rgb = flatten_to_rgb(&image);
    let (width, height) = rgb.dimensions();
    let dict = dictionary! {
        "Type" => "XObject", "Subtype" => "Image",
        "Width" => width as i64, "Height" => height as i64,
        "ColorSpace" => "DeviceRGB", "BitsPerComponent" => 8,
    };
    let mut stream = Stream::new(dict, rgb.into_raw());
    stream.compress().map_err(|error| error.to_string())?;
    Ok((stream, width, height))
}

/// One PDF, one page per image, page size equal to the image in points.
pub fn images_to_pdf(paths: &[PathBuf], destination: &Path) -> Result<Vec<PathBuf>, String> {
    let mut doc = Document::with_version("1.5");
    let pages_id = doc.new_object_id();
    let mut kids = Vec::new();
    for path in paths {
        let (xobject, width, height) = image_xobject(path)?;
        let image_id = doc.add_object(xobject);
        let content = format!("q {width} 0 0 {height} 0 0 cm /Im0 Do Q");
        let content_id = doc.add_object(Stream::new(dictionary! {}, content.into_bytes()));
        let page_id = doc.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), (width as i64).into(), (height as i64).into()],
            "Resources" => dictionary! { "XObject" => dictionary! { "Im0" => image_id } },
            "Contents" => content_id,
        });
        kids.push(Object::Reference(page_id));
    }
    let count = kids.len() as i64;
    doc.objects.insert(pages_id, Object::Dictionary(dictionary! { "Type" => "Pages", "Kids" => kids, "Count" => count }));
    let catalog_id = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
    doc.trailer.set("Root", catalog_id);
    let output = unique_output(destination.join(multi_name(paths, "pdf")))?;
    doc.save(&output).map_err(|error| format!("PDF를 저장하지 못했습니다: {error}"))?;
    Ok(vec![output])
}

pub fn convert_image(path: &Path, target: &str, destination: &Path) -> Result<Vec<PathBuf>, String> {
    let image = open_image(path)?;
    let output = unique_output(destination.join(format!("{}.{target}", stem(path))))?;
    let result = if target == "jpg" {
        DynamicImage::ImageRgb8(flatten_to_rgb(&image)).save_with_format(&output, ImageFormat::Jpeg)
    } else {
        image.save_with_format(&output, ImageFormat::Png)
    };
    result.map_err(|error| format!("이미지를 저장하지 못했습니다: {error}"))?;
    Ok(vec![output])
}

// ---------- PDF ----------

fn load_pdf(path: &Path) -> Result<Document, String> {
    if is_drm_wrapped(path) {
        return Err(DRM_MESSAGE.to_string());
    }
    let doc = Document::load(path).map_err(|error| format!("PDF를 읽지 못했습니다 ({}): {error}", path.display()))?;
    if doc.is_encrypted() || doc.trailer.get(b"Encrypt").is_ok() {
        return Err("암호화되었거나 비밀번호가 필요한 PDF는 변환할 수 없습니다.".to_string());
    }
    Ok(doc)
}

/// Pages can inherit MediaBox/Resources/etc. from their parent Pages node.
/// Copy those onto each page before moving it under a different parent.
fn pin_inherited_attributes(doc: &mut Document, page_id: ObjectId) {
    const INHERITABLE: [&[u8]; 4] = [b"Resources", b"MediaBox", b"CropBox", b"Rotate"];
    let mut found: Vec<(&[u8], Object)> = Vec::new();
    let mut parent = doc.get_dictionary(page_id).ok().and_then(|page| page.get(b"Parent").ok()).and_then(|value| value.as_reference().ok());
    let mut guard = 0;
    while let Some(parent_id) = parent {
        guard += 1;
        if guard > 64 { break; }
        let Ok(node) = doc.get_dictionary(parent_id) else { break };
        for key in INHERITABLE {
            if !found.iter().any(|(existing, _)| *existing == key) {
                if let Ok(value) = node.get(key) {
                    found.push((key, value.clone()));
                }
            }
        }
        parent = node.get(b"Parent").ok().and_then(|value| value.as_reference().ok());
    }
    if let Ok(page) = doc.get_dictionary_mut(page_id) {
        for (key, value) in found {
            if !page.has(key) {
                page.set(key, value);
            }
        }
    }
}

/// Merges PDFs in the given order (based on lopdf's merge example, keeping
/// page order and inherited page attributes).
pub fn merge_pdfs(paths: &[PathBuf], destination: &Path) -> Result<Vec<PathBuf>, String> {
    let mut max_id = 1;
    let mut pages: Vec<(ObjectId, Object)> = Vec::new();
    let mut objects: BTreeMap<ObjectId, Object> = BTreeMap::new();
    for path in paths {
        let mut doc = load_pdf(path)?;
        doc.renumber_objects_with(max_id);
        max_id = doc.max_id + 1;
        let page_ids = doc.get_pages().into_values().collect::<Vec<_>>();
        for page_id in &page_ids {
            pin_inherited_attributes(&mut doc, *page_id);
        }
        for page_id in page_ids {
            let page = doc.get_object(page_id).map_err(|error| error.to_string())?.clone();
            pages.push((page_id, page));
        }
        objects.extend(doc.objects);
    }

    let mut merged = Document::with_version("1.5");
    let mut catalog: Option<(ObjectId, Object)> = None;
    let mut pages_root: Option<ObjectId> = None;
    for (object_id, object) in &objects {
        match object.type_name().unwrap_or("") {
            "Catalog" => { catalog.get_or_insert((*object_id, object.clone())); }
            "Pages" => { pages_root.get_or_insert(*object_id); }
            "Page" | "Outlines" | "Outline" => {}
            _ => { merged.objects.insert(*object_id, object.clone()); }
        }
    }
    let pages_root = pages_root.ok_or("PDF 페이지 구조를 찾지 못했습니다.")?;
    let (catalog_id, catalog_object) = catalog.ok_or("PDF 문서 정보를 찾지 못했습니다.")?;
    let mut kids = Vec::new();
    for (page_id, page) in &pages {
        if let Ok(dictionary) = page.as_dict() {
            let mut dictionary = dictionary.clone();
            dictionary.set("Parent", pages_root);
            merged.objects.insert(*page_id, Object::Dictionary(dictionary));
            kids.push(Object::Reference(*page_id));
        }
    }
    let count = kids.len() as i64;
    merged.objects.insert(pages_root, Object::Dictionary(dictionary! { "Type" => "Pages", "Kids" => kids, "Count" => count }));
    let mut catalog_dictionary = catalog_object.as_dict().map_err(|error| error.to_string())?.clone();
    catalog_dictionary.set("Pages", pages_root);
    for key in [&b"Outlines"[..], b"AcroForm", b"Names", b"Dests", b"StructTreeRoot", b"PageLabels"] {
        catalog_dictionary.remove(key);
    }
    merged.objects.insert(catalog_id, Object::Dictionary(catalog_dictionary));
    merged.trailer.set("Root", catalog_id);
    merged.max_id = merged.objects.keys().map(|id| id.0).max().unwrap_or(1);
    merged.renumber_objects();
    merged.compress();
    let output = unique_output(destination.join(multi_name(paths, "pdf")))?;
    merged.save(&output).map_err(|error| format!("PDF를 저장하지 못했습니다: {error}"))?;
    Ok(vec![output])
}

/// One file per page: `name-01.pdf`, `name-02.pdf`, …
pub fn split_pdf(path: &Path, destination: &Path) -> Result<Vec<PathBuf>, String> {
    let source = load_pdf(path)?;
    let page_numbers = source.get_pages().into_keys().collect::<Vec<_>>();
    let width = page_numbers.len().to_string().len().max(2);
    let mut outputs = Vec::new();
    for (index, keep) in page_numbers.iter().enumerate() {
        let mut doc = source.clone();
        let remove = page_numbers.iter().copied().filter(|number| number != keep).collect::<Vec<_>>();
        doc.delete_pages(&remove);
        doc.prune_objects();
        doc.compress();
        let output = unique_output(destination.join(format!("{}-{:0width$}.pdf", stem(path), index + 1)))?;
        doc.save(&output).map_err(|error| format!("PDF를 저장하지 못했습니다: {error}"))?;
        outputs.push(output);
    }
    Ok(outputs)
}

// ---------- Office / Hangul through installed programs ----------

fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16) | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8) | u32::from(*chunk.get(2).unwrap_or(&0));
        for (i, shift) in [18, 12, 6, 0].iter().enumerate() {
            if i <= chunk.len() {
                out.push(TABLE[((n >> shift) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

const OFFICE_SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$inputPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__INPUT__'))
$outputPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__OUTPUT__'))
$ext = [IO.Path]::GetExtension($inputPath).ToLowerInvariant()
$app = $null
$document = $null
$started = Get-Date
$exitCode = 0
$failure = ''
$ProgressPreference = 'SilentlyContinue'
try {
  if (-not (Test-Path -LiteralPath $inputPath)) { throw 'INPUT_NOT_FOUND' }
  if ($ext -in @('.doc', '.docx', '.rtf', '.odt')) {
    try { $app = New-Object -ComObject Word.Application } catch { throw 'WORD_NOT_INSTALLED' }
    $app.Visible = $false
    $app.DisplayAlerts = 0
    $document = $app.Documents.Open($inputPath, $false, $true, $false, 'DAWITH_NO_PASSWORD')
    $document.ExportAsFixedFormat($outputPath, 17)
  } elseif ($ext -in @('.xls', '.xlsx', '.ods')) {
    try { $app = New-Object -ComObject Excel.Application } catch { throw 'EXCEL_NOT_INSTALLED' }
    $app.Visible = $false
    $app.DisplayAlerts = $false
    $document = $app.Workbooks.Open($inputPath, 0, $true, 5, 'DAWITH_NO_PASSWORD')
    $document.ExportAsFixedFormat(0, $outputPath)
  } elseif ($ext -in @('.ppt', '.pptx', '.odp')) {
    try { $app = New-Object -ComObject PowerPoint.Application } catch { throw 'POWERPOINT_NOT_INSTALLED' }
    $document = $app.Presentations.Open($inputPath + '::DAWITH_NO_PASSWORD', $true, $true, $false)
    # ExportAsFixedFormat cannot be bound from PowerShell; SaveAs 32 = PDF.
    $document.SaveAs($outputPath, 32)
  } elseif ($ext -in @('.hwp', '.hwpx')) {
    try { $app = New-Object -ComObject HwpFrame.HwpObject } catch { throw 'HWP_NOT_INSTALLED' }
    try { [void]$app.RegisterModule('FilePathCheckDLL', 'FilePathCheckerModule') } catch {}
    $app.XHwpWindows.Item(0).Visible = $false
    $format = if ($ext -eq '.hwpx') { 'HWPX' } else { 'HWP' }
    if (-not $app.Open($inputPath, $format, 'forceopen:true;suspendpassword:true;versionwarning:false')) { throw 'HWP_OPEN_FAILED' }
    if (-not $app.SaveAs($outputPath, 'PDF', '')) { throw 'HWP_SAVE_FAILED' }
  } else {
    throw 'UNSUPPORTED_OFFICE_TYPE'
  }
} catch {
  $message = [string]$_.Exception.Message
  if ($message -match '(?i)WORD_NOT_INSTALLED|EXCEL_NOT_INSTALLED|POWERPOINT_NOT_INSTALLED|HWP_NOT_INSTALLED') {
    $failure = 'DAWITH_MISSING_OFFICE|' + $message; $exitCode = 11
  } elseif ($message -match 'INPUT_NOT_FOUND') {
    $failure = 'DAWITH_INPUT_NOT_FOUND|' + $message; $exitCode = 12
  } elseif ($message -match '(?i)password|encrypted|protected|암호|비밀번호|HWP_OPEN_FAILED') {
    $failure = 'DAWITH_ENCRYPTED_FILE|' + $message; $exitCode = 10
  } else {
    $failure = $message; $exitCode = 1
  }
} finally {
  if ($ext -in @('.hwp', '.hwpx')) {
    if ($app) { try { $app.Clear(1) } catch {}; try { $app.Quit() } catch {} }
  } elseif ($ext -in @('.ppt', '.pptx', '.odp')) {
    if ($document) { try { $document.Close() } catch {} }
    if ($app) { try { $app.Quit() } catch {} }
  } else {
    if ($document) { try { $document.Close($false) } catch {} }
    if ($app) { try { $app.Quit() } catch {} }
  }
  foreach ($com in @($document, $app)) { if ($com) { try { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($com) } catch {} } }
  $document = $null; $app = $null
  [GC]::Collect(); [GC]::WaitForPendingFinalizers()
  # Office sometimes stays resident after Quit(). End only automation
  # instances started by this conversion; windows the user opened are not
  # automation instances and are never touched.
  Start-Sleep -Milliseconds 300
  Get-CimInstance Win32_Process -Filter "Name='WINWORD.EXE' or Name='EXCEL.EXE' or Name='POWERPNT.EXE' or Name='Hwp.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match '(?i)(/|-)automation|-embedding' -and $_.CreationDate -ge $started } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}
if ($exitCode -ne 0) { [Console]::Error.WriteLine($failure); exit $exitCode }
if (-not (Test-Path -LiteralPath $outputPath)) { [Console]::Error.WriteLine('PDF 결과를 찾지 못했습니다.'); exit 1 }
"#;

pub fn office_to_pdf(path: &Path, destination: &Path, command: impl Fn(&str) -> std::process::Command) -> Result<Vec<PathBuf>, String> {
    let output = unique_output(destination.join(format!("{}.pdf", stem(path))))?;
    let script = OFFICE_SCRIPT
        .replace("__INPUT__", &base64(path.to_string_lossy().as_bytes()))
        .replace("__OUTPUT__", &base64(output.to_string_lossy().as_bytes()));
    let utf16 = script.encode_utf16().flat_map(u16::to_le_bytes).collect::<Vec<_>>();
    let mut child = command("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", &base64(&utf16)])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|error| format!("PowerShell을 실행하지 못했습니다: {error}"))?;
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
            break status;
        }
        if started.elapsed() > Duration::from_secs(180) {
            let _ = child.kill();
            return Err("문서 변환이 3분 안에 끝나지 않아 중단했습니다. 해당 프로그램에 열린 대화상자가 있는지 확인하세요.".to_string());
        }
        std::thread::sleep(Duration::from_millis(200));
    };
    let mut stderr_bytes = Vec::new();
    if let Some(pipe) = child.stderr.take() {
        use std::io::Read;
        let _ = BufReader::new(pipe).read_to_end(&mut stderr_bytes);
    }
    let stderr = String::from_utf8_lossy(&stderr_bytes);
    if status.success() && output.exists() {
        return Ok(vec![output]);
    }
    if stderr.contains("DAWITH_ENCRYPTED_FILE") {
        return Err("암호로 보호되었거나 보안(DRM)이 걸린 문서는 변환할 수 없습니다. 암호나 보안을 해제한 뒤 다시 시도하세요.".to_string());
    }
    if stderr.contains("DAWITH_INPUT_NOT_FOUND") {
        return Err("변환할 파일을 찾지 못했습니다. 파일이 이동되었거나 삭제되었는지 확인하세요.".to_string());
    }
    if stderr.contains("DAWITH_MISSING_OFFICE") {
        return Err("이 파일을 변환하려면 해당 Windows 프로그램(Word·Excel·PowerPoint·한글)이 설치되어 있어야 합니다.".to_string());
    }
    Err(format!("문서 변환에 실패했습니다: {}", stderr.lines().map(str::trim).filter(|line| !line.is_empty() && !line.starts_with("#<") && !line.starts_with("<Objs")).last().unwrap_or("알 수 없는 오류")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("dawith-convert-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_png(path: &Path, color: [u8; 4], size: (u32, u32)) {
        let image = image::RgbaImage::from_pixel(size.0, size.1, image::Rgba(color));
        image.save(path).unwrap();
    }

    #[test]
    fn drm_wrapped_files_get_a_clear_message() {
        let dir = temp_dir("drm");
        let file = dir.join("보안.pdf");
        fs::write(&file, [&[0x9b, b' '][..], b"DRMONE encrypted"].concat()).unwrap();
        assert_eq!(merge_pdfs(&[file.clone(), file.clone()], &dir).unwrap_err(), DRM_MESSAGE);
        assert_eq!(split_pdf(&file, &dir).unwrap_err(), DRM_MESSAGE);
        let image = dir.join("보안.png");
        fs::write(&image, [&[0x9b, b' '][..], b"DRMONE encrypted"].concat()).unwrap();
        assert_eq!(images_to_pdf(&[image], &dir).unwrap_err(), DRM_MESSAGE);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn base64_matches_reference() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64("한글".as_bytes()), "7ZWc6riA");
    }

    #[test]
    fn images_merge_split_round_trip() {
        let dir = temp_dir("roundtrip");
        let a = dir.join("가.png");
        let b = dir.join("나.png");
        write_png(&a, [255, 0, 0, 255], (40, 30));
        write_png(&b, [0, 0, 255, 128], (20, 50));
        let jpg = convert_image(&a, "jpg", &dir).unwrap().remove(0);
        assert_eq!(extension(&jpg), "jpg");

        let single = images_to_pdf(&[jpg.clone()], &dir).unwrap().remove(0);
        assert_eq!(single.file_name().unwrap().to_string_lossy(), "가.pdf");
        let both = images_to_pdf(&[a.clone(), b.clone()], &dir).unwrap().remove(0);
        assert_eq!(both.file_name().unwrap().to_string_lossy(), "가 외 1개.pdf");
        assert_eq!(Document::load(&both).unwrap().get_pages().len(), 2);

        let merged = merge_pdfs(&[both.clone(), single.clone()], &dir).unwrap().remove(0);
        let merged_doc = Document::load(&merged).unwrap();
        assert_eq!(merged_doc.get_pages().len(), 3);
        // Page order and sizes survive the merge: 40x30, 20x50, then the JPEG page.
        let sizes = merged_doc.get_pages().values().map(|id| {
            let page = merged_doc.get_dictionary(*id).unwrap();
            let media = page.get(b"MediaBox").unwrap().as_array().unwrap();
            (media[2].as_i64().unwrap(), media[3].as_i64().unwrap())
        }).collect::<Vec<_>>();
        assert_eq!(sizes, vec![(40, 30), (20, 50), (40, 30)]);

        let parts = split_pdf(&merged, &dir).unwrap();
        assert_eq!(parts.len(), 3);
        assert!(parts[0].to_string_lossy().ends_with("-01.pdf"));
        for part in &parts {
            assert_eq!(Document::load(part).unwrap().get_pages().len(), 1);
        }
        // A second run never overwrites earlier results.
        let again = images_to_pdf(&[a.clone()], &dir).unwrap().remove(0);
        assert_eq!(again.file_name().unwrap().to_string_lossy(), "가 (2).pdf");
        let _ = fs::remove_dir_all(&dir);
    }
}
