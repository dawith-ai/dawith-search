const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, execFileSync } = require('child_process');

let pdfDocumentModule = null;

function getPdfDocument() {
  if (!pdfDocumentModule) pdfDocumentModule = require('pdf-lib').PDFDocument;
  return pdfDocumentModule;
}

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg']);
const OFFICE_EXTENSIONS = new Set(['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf', 'hwp', 'hwpx']);
const WINDOWS_OFFICE_EXTENSIONS = new Set(['doc', 'docx', 'rtf', 'odt', 'xls', 'xlsx', 'ods', 'ppt', 'pptx', 'odp', 'hwp', 'hwpx']);
const commandCache = new Map();
const commandPromiseCache = new Map();

function extension(filePath) {
  return path.extname(filePath).replace(/^\./, '').toLowerCase();
}

function stem(filePath) {
  return path.basename(filePath, path.extname(filePath));
}

function uniqueOutput(filePath) {
  if (!fs.existsSync(filePath)) return filePath;
  const directory = path.dirname(filePath);
  const base = path.basename(filePath, path.extname(filePath));
  const ext = path.extname(filePath);
  for (let index = 2; index < 10000; index += 1) {
    const candidate = path.join(directory, `${base} (${index})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error('변환 결과 파일 이름을 만들 수 없습니다.');
}

function findCommand(names, platform = os.platform()) {
  const candidates = Array.isArray(names) ? names : [names];
  for (const name of candidates) {
    try {
      const command = platform === 'win32' ? 'where.exe' : 'which';
      const output = execFileSync(command, [name], { encoding: 'utf8', windowsHide: true, timeout: 3000 }).trim();
      if (output) return output.split(/\r?\n/)[0];
    } catch (error) {
      // Try the next supported converter.
    }
  }
  return null;
}

function commandCacheKey(names, platform) {
  const candidates = Array.isArray(names) ? names : [names];
  return `${platform}:${candidates.join('|')}`;
}

function findCommandAsync(names, platform = os.platform()) {
  const key = commandCacheKey(names, platform);
  if (commandCache.has(key)) return Promise.resolve(commandCache.get(key));
  if (commandPromiseCache.has(key)) return commandPromiseCache.get(key);
  const candidates = Array.isArray(names) ? names : [names];
  const command = platform === 'win32' ? 'where.exe' : 'which';
  const promise = (async () => {
    for (const name of candidates) {
      try {
        const output = await new Promise((resolve, reject) => {
          execFile(command, [name], { encoding: 'utf8', windowsHide: true, timeout: 1200 }, (error, stdout) => {
            if (error) reject(error);
            else resolve(String(stdout || '').trim());
          });
        });
        if (output) {
          const resolved = output.split(/\r?\n/)[0];
          commandCache.set(key, resolved);
          return resolved;
        }
      } catch (error) {
        // Try the next supported converter without blocking the renderer.
      }
    }
    commandCache.set(key, null);
    return null;
  })().finally(() => commandPromiseCache.delete(key));
  commandPromiseCache.set(key, promise);
  return promise;
}

function getAvailableImageTool(platform = os.platform(), commandFinder = findCommand) {
  if (platform === 'darwin') return commandFinder('sips', platform);
  if (platform === 'win32') return commandFinder(['magick.exe', 'convert.exe'], platform);
  return commandFinder(['magick', 'convert'], platform);
}

function getAvailableOfficeTool(platform = os.platform(), commandFinder = findCommand) {
  if (platform === 'win32') return commandFinder(['powershell.exe', 'pwsh.exe', 'soffice.exe', 'libreoffice.exe'], platform);
  return commandFinder(platform === 'win32'
    ? ['soffice.exe', 'libreoffice.exe']
    : ['soffice', 'libreoffice'], platform);
}

async function getAvailableImageToolAsync(platform = os.platform()) {
  if (platform === 'darwin') return '/usr/bin/sips';
  if (platform === 'win32') return findCommandAsync(['magick.exe', 'convert.exe'], platform);
  return findCommandAsync(['magick', 'convert'], platform);
}

async function getAvailableOfficeToolAsync(platform = os.platform()) {
  // PowerShell ships with supported Windows editions. The COM application is
  // checked only when conversion starts, so opening the menu stays instant.
  if (platform === 'win32') return 'powershell.exe';
  return findCommandAsync(['soffice', 'libreoffice'], platform);
}

function getConversionNotice(filePaths, runtime = {}) {
  const files = (Array.isArray(filePaths) ? filePaths : [filePaths]).filter(Boolean);
  const extensions = files.map(extension);
  const platform = runtime.platform || os.platform();
  const officeFile = extensions.find(item => OFFICE_EXTENSIONS.has(item));
  if (officeFile && platform === 'win32') {
    return 'Office·한글 파일은 Windows에 해당 프로그램이 설치되어 있어야 PDF로 변환할 수 있습니다. 암호로 보호된 파일은 암호를 해제한 뒤 다시 시도하세요.';
  }
  if (officeFile) {
    return '문서 파일은 LibreOffice가 설치되어 있을 때 PDF로 변환할 수 있습니다. 암호로 보호된 파일은 변환할 수 없습니다.';
  }
  return '이 형식은 현재 기본 변환 대상이 아닙니다. PDF·PNG·JPG 또는 지원 프로그램이 설치된 문서를 선택하세요.';
}

function getConversionOptions(filePaths, runtime = {}) {
  const files = (Array.isArray(filePaths) ? filePaths : [filePaths]).filter(Boolean);
  const extensions = files.map(extension);
  const platform = runtime.platform || os.platform();
  const options = [];
  const allImages = files.length > 0 && extensions.every(item => IMAGE_EXTENSIONS.has(item));
  const allPdfs = files.length > 0 && extensions.every(item => item === 'pdf');
  const commandFinder = runtime.commandFinder || findCommand;
  const imageTool = getAvailableImageTool(platform, commandFinder);
  const officeTool = getAvailableOfficeTool(platform, commandFinder);

  if (allImages) {
    options.push({ id: 'images-to-pdf', label: files.length > 1 ? '이미지를 PDF 하나로 묶기' : 'PDF로 변환', detail: '원본은 유지하고 같은 폴더에 새 파일을 만듭니다.' });
    if (files.length === 1 && imageTool) {
      options.push({ id: 'image-to-png', label: 'PNG로 변환', detail: '설치된 OS 이미지 변환 도구를 사용합니다.' });
      options.push({ id: 'image-to-jpg', label: 'JPG로 변환', detail: '설치된 OS 이미지 변환 도구를 사용합니다.' });
    }
  }

  if (allPdfs) {
    if (files.length > 1) options.push({ id: 'merge-pdf', label: 'PDF 하나로 합치기', detail: `${files.length}개 PDF를 선택 순서대로 합칩니다.` });
    if (files.length === 1) options.push({ id: 'split-pdf', label: 'PDF 페이지별로 나누기', detail: '페이지마다 별도 PDF를 만듭니다.' });
  }

  // Windows uses PowerShell COM automation so Word, Excel, PowerPoint and
  // Hancom Office can be used without bundling a second office suite.
  // The actual application check happens at conversion time and returns a
  // clear installation/password message instead of a generic unsupported error.
  const windowsOfficeFile = files.length === 1 && WINDOWS_OFFICE_EXTENSIONS.has(extensions[0]);
  if (windowsOfficeFile && platform === 'win32' && officeTool) {
    options.push({ id: 'office-to-pdf', label: 'PDF로 변환', detail: '설치된 Word·Excel·PowerPoint·한글을 사용합니다. 암호 파일은 제외됩니다.' });
  } else if (files.length === 1 && OFFICE_EXTENSIONS.has(extensions[0]) && officeTool) {
    options.push({ id: 'office-to-pdf', label: 'PDF로 변환', detail: '설치된 LibreOffice/지원 변환기를 사용합니다.' });
  }

  return options;
}

async function getConversionOptionsAsync(filePaths, runtime = {}) {
  const files = (Array.isArray(filePaths) ? filePaths : [filePaths]).filter(Boolean);
  const extensions = files.map(extension);
  const platform = runtime.platform || os.platform();
  const options = [];
  const allImages = files.length > 0 && extensions.every(item => IMAGE_EXTENSIONS.has(item));
  const allPdfs = files.length > 0 && extensions.every(item => item === 'pdf');
  const imageTool = await getAvailableImageToolAsync(platform);
  const officeTool = await getAvailableOfficeToolAsync(platform);

  if (allImages) {
    options.push({ id: 'images-to-pdf', label: files.length > 1 ? '이미지를 PDF 하나로 묶기' : 'PDF로 변환', detail: '원본은 유지하고 같은 폴더에 새 파일을 만듭니다.' });
    if (files.length === 1 && imageTool) {
      options.push({ id: 'image-to-png', label: 'PNG로 변환', detail: '설치된 OS 이미지 변환 도구를 사용합니다.' });
      options.push({ id: 'image-to-jpg', label: 'JPG로 변환', detail: '설치된 OS 이미지 변환 도구를 사용합니다.' });
    }
  }
  if (allPdfs) {
    if (files.length > 1) options.push({ id: 'merge-pdf', label: 'PDF 하나로 합치기', detail: `${files.length}개 PDF를 선택 순서대로 합칩니다.` });
    if (files.length === 1) options.push({ id: 'split-pdf', label: 'PDF 페이지별로 나누기', detail: '페이지마다 별도 PDF를 만듭니다.' });
  }
  const windowsOfficeFile = files.length === 1 && WINDOWS_OFFICE_EXTENSIONS.has(extensions[0]);
  if (windowsOfficeFile && platform === 'win32' && officeTool) {
    options.push({ id: 'office-to-pdf', label: 'PDF로 변환', detail: '설치된 Word·Excel·PowerPoint·한글을 사용합니다. 암호 파일은 제외됩니다.' });
  } else if (files.length === 1 && OFFICE_EXTENSIONS.has(extensions[0]) && officeTool) {
    options.push({ id: 'office-to-pdf', label: 'PDF로 변환', detail: '설치된 LibreOffice/지원 변환기를 사용합니다.' });
  }
  return options;
}

async function imageToPdf(filePaths, destinationDir) {
  const PDFDocument = getPdfDocument();
  const document = await PDFDocument.create();
  for (const filePath of filePaths) {
    const bytes = await fs.promises.readFile(filePath);
    const ext = extension(filePath);
    const image = ext === 'png' ? await document.embedPng(bytes) : await document.embedJpg(bytes);
    const page = document.addPage([image.width, image.height]);
    page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
  }
  const outputName = filePaths.length === 1 ? `${stem(filePaths[0])}.pdf` : `${stem(filePaths[0])} 외 ${filePaths.length - 1}개.pdf`;
  const outputPath = uniqueOutput(path.join(destinationDir, outputName));
  await fs.promises.writeFile(outputPath, await document.save());
  return [outputPath];
}

async function mergePdfs(filePaths, destinationDir) {
  const PDFDocument = getPdfDocument();
  const output = await PDFDocument.create();
  for (const filePath of filePaths) {
    const source = await PDFDocument.load(await fs.promises.readFile(filePath));
    const pages = await output.copyPages(source, source.getPageIndices());
    pages.forEach(page => output.addPage(page));
  }
  const outputPath = uniqueOutput(path.join(destinationDir, `${stem(filePaths[0])} 외 ${filePaths.length - 1}개.pdf`));
  await fs.promises.writeFile(outputPath, await output.save());
  return [outputPath];
}

async function splitPdf(filePath, destinationDir) {
  const PDFDocument = getPdfDocument();
  const source = await PDFDocument.load(await fs.promises.readFile(filePath));
  const outputs = [];
  for (const [index, sourceIndex] of source.getPageIndices().entries()) {
    const pageDocument = await PDFDocument.create();
    const [page] = await pageDocument.copyPages(source, [sourceIndex]);
    pageDocument.addPage(page);
    const outputPath = uniqueOutput(path.join(destinationDir, `${stem(filePath)}-${String(index + 1).padStart(2, '0')}.pdf`));
    await fs.promises.writeFile(outputPath, await pageDocument.save());
    outputs.push(outputPath);
  }
  return outputs;
}

async function convertImage(filePath, targetExtension, destinationDir) {
  const tool = await getAvailableImageToolAsync();
  if (!tool) throw new Error('이미지 변환 도구를 찾지 못했습니다.');
  const outputPath = uniqueOutput(path.join(destinationDir, `${stem(filePath)}.${targetExtension}`));
  const args = os.platform() === 'darwin'
    ? ['-s', 'format', targetExtension === 'jpg' ? 'jpeg' : targetExtension, filePath, '--out', outputPath]
    : [filePath, outputPath];
  return new Promise((resolve, reject) => {
    execFile(tool, args, { windowsHide: true, timeout: 120000 }, error => {
      if (error) reject(new Error(`이미지 변환에 실패했습니다: ${error.message}`));
      else resolve([outputPath]);
    });
  });
}

function isEncryptedConversionError(error) {
  const message = String(error && (error.stderr || error.message) || error || '');
  return /DAWITH_ENCRYPTED_FILE|encrypted|password|protected|암호|비밀번호|암호화/i.test(message);
}

function convertWindowsOfficeToPdf(filePath, destinationDir, tool) {
  const outputPath = uniqueOutput(path.join(destinationDir, `${stem(filePath)}.pdf`));
  const input64 = Buffer.from(filePath, 'utf8').toString('base64');
  const output64 = Buffer.from(outputPath, 'utf8').toString('base64');
  const script = `
$ErrorActionPreference = 'Stop'
$inputPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${input64}'))
$outputPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${output64}'))
$ext = [IO.Path]::GetExtension($inputPath).ToLowerInvariant()
$app = $null
$document = $null
try {
  if ($ext -in @('.doc', '.docx', '.rtf', '.odt')) {
    try { $app = New-Object -ComObject Word.Application } catch { throw 'WORD_NOT_INSTALLED' }
    $app.Visible = $false
    $document = $app.Documents.Open($inputPath, $false, $true)
    $document.ExportAsFixedFormat($outputPath, 17)
  } elseif ($ext -in @('.xls', '.xlsx', '.ods')) {
    try { $app = New-Object -ComObject Excel.Application } catch { throw 'EXCEL_NOT_INSTALLED' }
    $app.Visible = $false
    $document = $app.Workbooks.Open($inputPath, 0, $true)
    $document.ExportAsFixedFormat(0, $outputPath)
  } elseif ($ext -in @('.ppt', '.pptx', '.odp')) {
    try { $app = New-Object -ComObject PowerPoint.Application } catch { throw 'POWERPOINT_NOT_INSTALLED' }
    $document = $app.Presentations.Open($inputPath, $true, $true, $false)
    $document.ExportAsFixedFormat($outputPath, 2)
  } elseif ($ext -in @('.hwp', '.hwpx')) {
    try { $app = New-Object -ComObject HwpFrame.HwpObject } catch { throw 'HWP_NOT_INSTALLED' }
    $app.XHwpWindows.Item(0).Visible = $false
    $document = $app
    $app.Open($inputPath)
    $app.SaveAs($outputPath, 'PDF')
  } else {
    throw 'UNSUPPORTED_OFFICE_TYPE'
  }
} catch {
  $message = [string]$_.Exception.Message
  if ($message -match '(?i)WORD_NOT_INSTALLED|EXCEL_NOT_INSTALLED|POWERPOINT_NOT_INSTALLED|HWP_NOT_INSTALLED') {
    [Console]::Error.WriteLine('DAWITH_MISSING_OFFICE|' + $message)
    exit 11
  }
  if ($message -match '(?i)password|encrypted|protected|암호|비밀번호') {
    [Console]::Error.WriteLine('DAWITH_ENCRYPTED_FILE|' + $message)
    exit 10
  }
  [Console]::Error.WriteLine($message)
  exit 1
} finally {
  if ($document -and $ext -notin @('.hwp', '.hwpx')) { try { $document.Close($false) } catch {} }
  if ($app -and $ext -notin @('.hwp', '.hwpx')) { try { $app.Quit() } catch {} }
}
if (-not (Test-Path -LiteralPath $outputPath)) { [Console]::Error.WriteLine('PDF 결과를 찾지 못했습니다.'); exit 1 }
`;
  const encodedScript = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    execFile(tool, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodedScript], {
      windowsHide: true,
      timeout: 180000,
      maxBuffer: 1024 * 1024
    }, (error, stdout, stderr) => {
      if (error) {
        if (String(stderr).includes('DAWITH_ENCRYPTED_FILE')) {
          reject(new Error('암호로 보호된 파일은 변환할 수 없습니다. 암호를 해제한 뒤 다시 시도하세요.'));
          return;
        }
        if (String(stderr).includes('DAWITH_MISSING_OFFICE')) {
          reject(new Error('이 파일을 변환하려면 해당 Windows 프로그램(Word·Excel·PowerPoint·한글)이 설치되어 있어야 합니다.'));
          return;
        }
        reject(new Error(`Windows 문서 변환에 실패했습니다: ${String(stderr || error.message).trim()}`));
        return;
      }
      if (!fs.existsSync(outputPath)) {
        reject(new Error('변환기는 실행됐지만 PDF 결과를 찾지 못했습니다.'));
        return;
      }
      resolve([outputPath]);
    });
  });
}

async function convertOfficeToPdf(filePath, destinationDir) {
  const tool = await getAvailableOfficeToolAsync();
  if (!tool) throw new Error('LibreOffice 또는 호환 Office 변환기를 찾지 못했습니다.');
  if (os.platform() === 'win32' && /powershell|pwsh/i.test(path.basename(tool))) {
    return convertWindowsOfficeToPdf(filePath, destinationDir, tool);
  }
  return new Promise((resolve, reject) => {
    execFile(tool, ['--headless', '--convert-to', 'pdf', '--outdir', destinationDir, filePath], {
      windowsHide: true,
      timeout: 180000
    }, error => {
      if (error) {
        reject(new Error(isEncryptedConversionError(error)
          ? '암호로 보호된 파일은 변환할 수 없습니다. 암호를 해제한 뒤 다시 시도하세요.'
          : `문서 변환에 실패했습니다: ${error.message}`));
        return;
      }
      const outputPath = path.join(destinationDir, `${stem(filePath)}.pdf`);
      if (!fs.existsSync(outputPath)) {
        reject(new Error('변환기는 실행됐지만 PDF 결과를 찾지 못했습니다.'));
        return;
      }
      resolve([outputPath]);
    });
  });
}

async function convertFiles(filePaths, operation, destinationDir) {
  const files = (Array.isArray(filePaths) ? filePaths : [filePaths]).filter(Boolean);
  if (!files.length) throw new Error('변환할 파일이 없습니다.');
  const targetDir = destinationDir || path.dirname(files[0]);
  await fs.promises.mkdir(targetDir, { recursive: false }).catch(error => {
    if (error.code !== 'EEXIST') throw error;
  });

  if (operation === 'images-to-pdf') return imageToPdf(files, targetDir);
  if (operation === 'merge-pdf') return mergePdfs(files, targetDir);
  if (operation === 'split-pdf') return splitPdf(files[0], targetDir);
  if (operation === 'image-to-png') return convertImage(files[0], 'png', targetDir);
  if (operation === 'image-to-jpg') return convertImage(files[0], 'jpg', targetDir);
  if (operation === 'office-to-pdf') return convertOfficeToPdf(files[0], targetDir);
  throw new Error('지원하지 않는 변환 작업입니다.');
}

module.exports = {
  IMAGE_EXTENSIONS,
  getConversionNotice,
  getConversionOptions,
  getConversionOptionsAsync,
  convertFiles,
  isEncryptedConversionError
};
