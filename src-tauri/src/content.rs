//! Optional document body index ("본문 검색"). Off by default: when the user
//! turns it on for chosen folders, document text is read once in the
//! background, deflate-compressed in memory and saved next to the file-name
//! index, then searched in parallel like file names. Encrypted and DRM files
//! are never read. Turning it off deletes the saved text.
//!
//! Formats: HWP, HWPX, DOCX, XLSX, PPTX, PDF and plain text. Office/HWPX
//! files are ZIP containers; a minimal reader below avoids a ZIP dependency
//! (flate2 is already linked through lopdf).

use rayon::prelude::*;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

const MAGIC: &[u8; 8] = b"DWSCNT01";
const FILE_NAME: &str = "content-v1.bin";
/// Larger files are skipped: they are rarely worth the read time.
const MAX_FILE_BYTES: u64 = 30 * 1024 * 1024;
/// Text kept per document; enough for a long report.
const MAX_TEXT_BYTES: usize = 512 * 1024;
const MAX_PDF_PAGES: u32 = 300;

const OFFICE_EXTENSIONS: &[&str] = &["hwp", "hwpx", "docx", "xlsx", "pptx", "pdf"];

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Text = 0,
    /// Password-protected or DRM: skipped on purpose.
    Protected = 1,
    /// Could not be read (damaged, unsupported variant, scanned PDF...).
    Failed = 2,
}

struct Doc {
    path: Box<str>,
    mtime: u64,
    size: u64,
    kind: Kind,
    /// Deflate-compressed UTF-8 text.
    text: Box<[u8]>,
    text_len: u32,
}

#[derive(Default)]
struct Store {
    docs: Vec<Doc>,
    by_path: HashMap<String, usize>,
    dirty: bool,
}

impl Store {
    fn key(path: &str) -> String {
        path.to_lowercase()
    }

    fn rebuild_map(&mut self) {
        self.by_path = self.docs.iter().enumerate().map(|(position, doc)| (Self::key(&doc.path), position)).collect();
    }

    fn get(&self, path: &str) -> Option<&Doc> {
        self.by_path.get(&Self::key(path)).map(|position| &self.docs[*position])
    }

    fn upsert(&mut self, doc: Doc) {
        let key = Self::key(&doc.path);
        match self.by_path.get(&key) {
            Some(position) => self.docs[*position] = doc,
            None => {
                self.by_path.insert(key, self.docs.len());
                self.docs.push(doc);
            }
        }
        self.dirty = true;
    }

    fn remove(&mut self, path: &str) {
        if let Some(position) = self.by_path.remove(&Self::key(path)) {
            self.docs.swap_remove(position);
            if position < self.docs.len() {
                let moved = Self::key(&self.docs[position].path);
                self.by_path.insert(moved, position);
            }
            self.dirty = true;
        }
    }
}

static STORE: Mutex<Option<Store>> = Mutex::new(None);
/// Bumped to cancel a running scan (new scan, settings change, turning off).
static GENERATION: AtomicU64 = AtomicU64::new(0);
static SCANNING: AtomicBool = AtomicBool::new(false);
static PENDING: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());
static PENDING_WORKER: AtomicBool = AtomicBool::new(false);
static PROGRESS: Mutex<Progress> = Mutex::new(Progress { seen: 0, processed: 0, total: 0 });

#[derive(Clone, Copy)]
struct Progress {
    seen: u64,
    processed: u64,
    total: u64,
}

// ---------------------------------------------------------------- settings

pub fn enabled(config: &Value) -> bool {
    config.pointer("/contentIndex/enabled").and_then(Value::as_bool).unwrap_or(false)
}

pub fn roots(config: &Value) -> Vec<PathBuf> {
    config
        .pointer("/contentIndex/roots")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).filter(|item| !item.trim().is_empty()).map(PathBuf::from).collect())
        .unwrap_or_default()
}

/// Desktop, Documents and Downloads: where most people keep documents.
pub fn default_roots() -> Vec<String> {
    let home = crate::home_dir();
    ["Desktop", "Documents", "Downloads"]
        .iter()
        .map(|name| home.join(name))
        .filter(|path| path.is_dir())
        .map(|path| path.to_string_lossy().to_string())
        .collect()
}

fn store_path(data_dir: &Path) -> PathBuf {
    data_dir.join(FILE_NAME)
}

pub fn supported_extension(extension: &str) -> bool {
    OFFICE_EXTENSIONS.contains(&extension) || crate::is_plain_text_extension(extension)
}

// -------------------------------------------------------------- extraction

enum Extracted {
    Text(String),
    Protected,
    Failed,
}

fn extract(path: &Path) -> Extracted {
    let extension = crate::file_extension(path);
    // A bad file must never take the indexer down with it.
    std::panic::catch_unwind(|| extract_inner(path, &extension)).unwrap_or(Extracted::Failed)
}

/// Office documents wrapped by DRM or encryption no longer start with their
/// own format's signature (ZIP, OLE, %PDF). Many companies wrap every
/// document this way (e.g. "\x9b DRMONE"), so such files count as protected.
fn looks_protected(head: &[u8], extension: &str) -> bool {
    const ZIP: &[u8] = b"PK\x03\x04";
    const OLE: &[u8] = &[0xd0, 0xcf, 0x11, 0xe0];
    if head.starts_with(&[0x9b, 0x20, 0x44, 0x52, 0x4d, 0x4f, 0x4e, 0x45]) || head.starts_with(b"SCDSA") {
        return true;
    }
    match extension {
        "hwp" => !head.starts_with(OLE),
        // A password-protected docx/xlsx/pptx/hwpx is an OLE container.
        "hwpx" | "docx" | "xlsx" | "pptx" => !head.starts_with(ZIP),
        "pdf" => !head.windows(5).any(|window| window == b"%PDF-"),
        _ => false,
    }
}

/// HWP 5 keeps its protection settings in the FileHeader stream: document
/// password (bit 1), distribution/read-only (bit 2), DRM (bit 4), certificate
/// encryption (bit 8) and certificate DRM (bit 10). The HWP library could
/// decrypt distribution documents, so they are refused before it runs.
pub fn hwp_is_protected(path: &Path) -> bool {
    let Ok(mut file) = cfb::open(path) else { return false };
    let Ok(mut stream) = file.open_stream("/FileHeader") else { return false };
    let mut header = [0u8; 40];
    if stream.read_exact(&mut header).is_err() {
        return false;
    }
    let flags = u32::from_le_bytes([header[36], header[37], header[38], header[39]]);
    flags & (1 << 1 | 1 << 2 | 1 << 4 | 1 << 8 | 1 << 10) != 0
}

fn extract_inner(path: &Path, extension: &str) -> Extracted {
    if OFFICE_EXTENSIONS.contains(&extension) {
        let Ok(head) = read_head(path, 1024) else { return Extracted::Failed };
        if looks_protected(&head, extension) || (extension == "hwp" && hwp_is_protected(path)) {
            return Extracted::Protected;
        }
    }
    match extension {
        "hwp" => {
            match crate::extract_hwp_text(path) {
                Ok(text) => Extracted::Text(text),
                Err(_) => Extracted::Failed,
            }
        }
        "hwpx" | "docx" | "xlsx" | "pptx" => extract_zip_document(path, extension),
        "pdf" => extract_pdf(path),
        _ => match fs::read(path) {
            Ok(bytes) => Extracted::Text(decode_text(&bytes[..bytes.len().min(MAX_TEXT_BYTES * 2)])),
            Err(_) => Extracted::Failed,
        },
    }
}

fn read_head(path: &Path, length: usize) -> std::io::Result<Vec<u8>> {
    let mut buffer = vec![0u8; length];
    let mut file = fs::File::open(path)?;
    let read = file.read(&mut buffer)?;
    buffer.truncate(read);
    Ok(buffer)
}

/// UTF-8 (with or without BOM), UTF-16 with BOM, else Korean CP949.
fn decode_text(bytes: &[u8]) -> String {
    if let Some(rest) = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]) {
        return String::from_utf8_lossy(rest).into_owned();
    }
    if bytes.starts_with(&[0xff, 0xfe]) {
        return encoding_rs::UTF_16LE.decode(bytes).0.into_owned();
    }
    if bytes.starts_with(&[0xfe, 0xff]) {
        return encoding_rs::UTF_16BE.decode(bytes).0.into_owned();
    }
    match std::str::from_utf8(bytes) {
        Ok(text) => text.to_string(),
        // A cut in the middle of a UTF-8 character at the end is still UTF-8.
        Err(error) if error.error_len().is_none() => String::from_utf8_lossy(&bytes[..error.valid_up_to()]).into_owned(),
        Err(_) => encoding_rs::EUC_KR.decode(bytes).0.into_owned(),
    }
}

fn extract_pdf(path: &Path) -> Extracted {
    match lopdf::Document::load(path) {
        Ok(document) => pdf_document_text(&document),
        Err(_) => Extracted::Failed,
    }
}

fn pdf_document_text(document: &lopdf::Document) -> Extracted {
    if document.is_encrypted() {
        return Extracted::Protected;
    }
    // Page by page: one page with an unreadable font shouldn't lose the rest.
    let mut text = String::new();
    for (number, page_id) in document.get_pages().into_iter().take(MAX_PDF_PAGES as usize) {
        let mut page_text = pdf_page_text(document, page_id);
        // Fall back to lopdf's own reader for fonts without a ToUnicode map.
        if page_text.trim().is_empty() {
            page_text = document.extract_text(&[number]).unwrap_or_default();
        }
        text.push_str(&page_text);
        text.push('\n');
        if text.len() > MAX_TEXT_BYTES {
            break;
        }
    }
    // Scanned PDFs have pages but no text layer.
    if text.trim().is_empty() { Extracted::Failed } else { Extracted::Text(text) }
}

/// How a font's byte codes turn into text.
struct PdfFont {
    code_bytes: usize,
    map: HashMap<u32, String>,
}

fn pdf_deref<'a>(document: &'a lopdf::Document, object: &'a lopdf::Object) -> &'a lopdf::Object {
    document.dereference(object).map(|(_, object)| object).unwrap_or(object)
}

fn hex_value(bytes: &[u8]) -> u32 {
    bytes.iter().fold(0u32, |value, byte| (value << 8) | *byte as u32)
}

fn utf16_text(bytes: &[u8]) -> String {
    let units: Vec<u16> = bytes.chunks(2).map(|pair| ((pair[0] as u16) << 8) | *pair.get(1).unwrap_or(&0) as u16).collect();
    String::from_utf16_lossy(&units)
}

/// Reads the bfchar/bfrange entries of a ToUnicode CMap. Korean PDFs from
/// Hangul, Word and PowerPoint use CID fonts that only make sense through it.
fn parse_cmap(data: &[u8], font: &mut PdfFont) {
    enum Token {
        Hex(Vec<u8>),
        Word(String),
        Open,
        Close,
    }
    let mut tokens = Vec::new();
    let mut at = 0;
    while at < data.len() {
        match data[at] {
            b'<' => {
                let end = data[at + 1..].iter().position(|byte| *byte == b'>').map(|offset| at + 1 + offset).unwrap_or(data.len());
                let digits: Vec<u8> = data[at + 1..end].iter().copied().filter(u8::is_ascii_hexdigit).collect();
                let bytes = digits
                    .chunks(2)
                    .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap_or("0"), 16).unwrap_or(0) << if pair.len() == 1 { 4 } else { 0 })
                    .collect();
                tokens.push(Token::Hex(bytes));
                at = end + 1;
            }
            b'[' => { tokens.push(Token::Open); at += 1; }
            b']' => { tokens.push(Token::Close); at += 1; }
            byte if byte.is_ascii_alphabetic() => {
                let end = data[at..].iter().position(|byte| !byte.is_ascii_alphanumeric()).map(|offset| at + offset).unwrap_or(data.len());
                tokens.push(Token::Word(String::from_utf8_lossy(&data[at..end]).into_owned()));
                at = end;
            }
            _ => at += 1,
        }
    }
    let mut position = 0;
    let mut section = "";
    let mut code_bytes_seen = false;
    while position < tokens.len() {
        match &tokens[position] {
            Token::Word(word) => {
                section = match word.as_str() {
                    "begincodespacerange" => "space",
                    "beginbfchar" => "char",
                    "beginbfrange" => "range",
                    _ if word.starts_with("end") => "",
                    _ => section,
                };
                position += 1;
            }
            Token::Hex(low) if section == "space" => {
                if !code_bytes_seen && !low.is_empty() {
                    font.code_bytes = low.len();
                    code_bytes_seen = true;
                }
                position += 2;
            }
            Token::Hex(source) if section == "char" => {
                if let Some(Token::Hex(target)) = tokens.get(position + 1) {
                    font.map.insert(hex_value(source), utf16_text(target));
                }
                position += 2;
            }
            Token::Hex(low) if section == "range" => {
                let (Some(Token::Hex(high)), Some(target)) = (tokens.get(position + 1), tokens.get(position + 2)) else { break };
                let (start, end) = (hex_value(low), hex_value(high));
                if end < start || end - start > 65_535 {
                    position += 3;
                    continue;
                }
                match target {
                    Token::Hex(base) => {
                        let mut units: Vec<u16> = base.chunks(2).map(|pair| ((pair[0] as u16) << 8) | *pair.get(1).unwrap_or(&0) as u16).collect();
                        for code in start..=end {
                            font.map.insert(code, String::from_utf16_lossy(&units));
                            if let Some(last) = units.last_mut() {
                                *last = last.wrapping_add(1);
                            }
                        }
                        position += 3;
                    }
                    Token::Open => {
                        let mut code = start;
                        position += 3;
                        while let Some(Token::Hex(target)) = tokens.get(position) {
                            font.map.insert(code, utf16_text(target));
                            code += 1;
                            position += 1;
                        }
                        position += 1;
                    }
                    _ => position += 3,
                }
            }
            _ => position += 1,
        }
    }
}

fn pdf_fonts(document: &lopdf::Document, page_id: lopdf::ObjectId) -> HashMap<Vec<u8>, PdfFont> {
    let mut fonts = HashMap::new();
    let Ok(page_fonts) = document.get_page_fonts(page_id) else { return fonts };
    for (name, dictionary) in page_fonts {
        let composite = dictionary.get(b"Subtype").and_then(lopdf::Object::as_name).map(|subtype| subtype == b"Type0").unwrap_or(false);
        let mut font = PdfFont { code_bytes: if composite { 2 } else { 1 }, map: HashMap::new() };
        if let Ok(stream) = dictionary.get_deref(b"ToUnicode", document).and_then(lopdf::Object::as_stream) {
            let data = stream.decompressed_content().unwrap_or_else(|_| stream.content.clone());
            parse_cmap(&data, &mut font);
        }
        fonts.insert(name, font);
    }
    fonts
}

fn pdf_decode(bytes: &[u8], font: Option<&PdfFont>, out: &mut String) {
    match font {
        Some(font) if !font.map.is_empty() => {
            for code in bytes.chunks(font.code_bytes.max(1)) {
                if let Some(text) = font.map.get(&hex_value(code)) {
                    out.push_str(text);
                }
            }
        }
        // Two-byte codes without a map can't be read.
        Some(font) if font.code_bytes > 1 => {}
        // Simple fonts: close enough to Latin-1 for searching.
        _ => out.extend(bytes.iter().map(|byte| *byte as char)),
    }
}

fn pdf_page_text(document: &lopdf::Document, page_id: lopdf::ObjectId) -> String {
    let mut out = String::new();
    let Ok(content) = document.get_and_decode_page_content(page_id) else { return out };
    let fonts = pdf_fonts(document, page_id);
    let mut current: Option<&PdfFont> = None;
    for operation in &content.operations {
        let operands = &operation.operands;
        match operation.operator.as_str() {
            "Tf" => current = operands.first().and_then(|name| name.as_name().ok()).and_then(|name| fonts.get(name)),
            "Tj" | "'" | "\"" => {
                if matches!(operation.operator.as_str(), "'" | "\"") {
                    out.push('\n');
                }
                if let Some(Ok(bytes)) = operands.last().map(|object| pdf_deref(document, object).as_str()) {
                    pdf_decode(bytes, current, &mut out);
                }
            }
            "TJ" => {
                for item in operands.first().and_then(|array| array.as_array().ok()).into_iter().flatten() {
                    match item {
                        lopdf::Object::String(bytes, _) => pdf_decode(bytes, current, &mut out),
                        // A large negative kern is how many PDFs draw a space.
                        number => {
                            if number.as_float().map(|value| value < -250.0).unwrap_or(false) {
                                out.push(' ');
                            }
                        }
                    }
                }
            }
            "T*" | "ET" => out.push('\n'),
            "Td" | "TD" => {
                let moves_line = operands.get(1).and_then(|value| value.as_float().ok()).map(|y| y.abs() > 0.01).unwrap_or(false);
                if moves_line {
                    out.push('\n');
                }
            }
            _ => {}
        }
    }
    out
}

struct ZipEntry {
    name: String,
    method: u16,
    encrypted: bool,
    compressed_size: u64,
    uncompressed_size: u64,
    local_offset: u64,
}

fn le16(data: &[u8], at: usize) -> Option<u16> {
    data.get(at..at + 2).map(|bytes| u16::from_le_bytes([bytes[0], bytes[1]]))
}

fn le32(data: &[u8], at: usize) -> Option<u32> {
    data.get(at..at + 4).map(|bytes| u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
}

fn zip_entries(data: &[u8]) -> Option<Vec<ZipEntry>> {
    // End of central directory: the last record, possibly followed by a comment.
    let search_from = data.len().saturating_sub(22 + 65535);
    let eocd = (search_from..data.len().saturating_sub(21)).rev().find(|at| le32(data, *at) == Some(0x0605_4b50))?;
    let count = le16(data, eocd + 10)? as usize;
    let mut at = le32(data, eocd + 16)? as usize;
    let mut entries = Vec::with_capacity(count);
    for _ in 0..count {
        if le32(data, at)? != 0x0201_4b50 {
            return None;
        }
        let flags = le16(data, at + 8)?;
        let name_len = le16(data, at + 28)? as usize;
        let extra_len = le16(data, at + 30)? as usize;
        let comment_len = le16(data, at + 32)? as usize;
        let name = String::from_utf8_lossy(data.get(at + 46..at + 46 + name_len)?).into_owned();
        entries.push(ZipEntry {
            name,
            method: le16(data, at + 10)?,
            encrypted: flags & 1 != 0,
            compressed_size: le32(data, at + 20)? as u64,
            uncompressed_size: le32(data, at + 24)? as u64,
            local_offset: le32(data, at + 42)? as u64,
        });
        at += 46 + name_len + extra_len + comment_len;
    }
    Some(entries)
}

fn zip_read(data: &[u8], entry: &ZipEntry) -> Option<String> {
    let at = entry.local_offset as usize;
    if le32(data, at)? != 0x0403_4b50 {
        return None;
    }
    let start = at + 30 + le16(data, at + 26)? as usize + le16(data, at + 28)? as usize;
    let raw = data.get(start..start.checked_add(entry.compressed_size as usize)?)?;
    let limit = entry.uncompressed_size.min(64 * 1024 * 1024);
    let bytes = match entry.method {
        0 => raw.to_vec(),
        8 => {
            let mut out = Vec::with_capacity(limit as usize);
            flate2::read::DeflateDecoder::new(raw).take(limit).read_to_end(&mut out).ok()?;
            out
        }
        _ => return None,
    };
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

/// Number inside names like `ppt/slides/slide12.xml`, for reading order.
fn part_number(name: &str) -> u32 {
    let stem = name.rsplit('/').next().unwrap_or(name);
    stem.chars().filter(char::is_ascii_digit).collect::<String>().parse().unwrap_or(0)
}

fn extract_zip_document(path: &Path, extension: &str) -> Extracted {
    let Ok(data) = fs::read(path) else { return Extracted::Failed };
    let Some(entries) = zip_entries(&data) else { return Extracted::Failed };
    let mut parts: Vec<&ZipEntry> = entries
        .iter()
        .filter(|entry| match extension {
            "docx" => entry.name == "word/document.xml",
            "xlsx" => entry.name == "xl/sharedStrings.xml",
            "pptx" => entry.name.starts_with("ppt/slides/slide") && entry.name.ends_with(".xml"),
            _ => entry.name.starts_with("Contents/section") && entry.name.ends_with(".xml"),
        })
        .collect();
    if parts.iter().any(|entry| entry.encrypted) || (extension == "hwpx" && entries.iter().any(|entry| entry.name.ends_with("manifest.xml") && entry.encrypted)) {
        return Extracted::Protected;
    }
    if parts.is_empty() {
        // An xlsx with only numbers has no shared strings: nothing to search.
        return if extension == "xlsx" { Extracted::Text(String::new()) } else { Extracted::Failed };
    }
    parts.sort_by_key(|entry| part_number(&entry.name));
    let mut text = String::new();
    for part in parts {
        let Some(xml) = zip_read(&data, part) else { return Extracted::Failed };
        // HWPX encryption keeps the ZIP readable but scrambles the sections.
        if extension == "hwpx" && !xml.trim_start().starts_with('<') {
            return Extracted::Protected;
        }
        xml_text(&xml, &mut text);
        if text.len() > MAX_TEXT_BYTES {
            break;
        }
    }
    Extracted::Text(text)
}

/// Collects the text of `<…:t>` elements (w:t, a:t, t, hp:t) with a line
/// break after each paragraph (`</…:p>`) and a space for tabs.
fn xml_text(xml: &str, out: &mut String) {
    let local = |tag: &str| -> String {
        let name = tag.trim_start_matches('/').split(|c: char| c.is_whitespace() || c == '/').next().unwrap_or("");
        name.rsplit(':').next().unwrap_or(name).to_string()
    };
    let mut rest = xml;
    let mut in_text = false;
    while let Some(open) = rest.find('<') {
        if in_text {
            decode_entities(&rest[..open], out);
        }
        let Some(close) = rest[open..].find('>') else { break };
        let tag = &rest[open + 1..open + close];
        rest = &rest[open + close + 1..];
        if tag.starts_with('?') || tag.starts_with('!') {
            continue;
        }
        let name = local(tag);
        let is_end = tag.starts_with('/');
        let self_closing = tag.ends_with('/');
        match name.as_str() {
            "t" if !is_end && !self_closing => in_text = true,
            "t" if is_end => in_text = false,
            "p" if is_end => out.push('\n'),
            // Spreadsheet strings and table cells are separate pieces of text.
            "si" | "tc" if is_end => out.push('\n'),
            "tab" => out.push(' '),
            "br" | "lineBreak" => out.push('\n'),
            _ => {}
        }
    }
}

fn decode_entities(text: &str, out: &mut String) {
    let mut rest = text;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        let after = &rest[amp + 1..];
        let Some(semi) = after.find(';').filter(|semi| *semi <= 10) else {
            out.push('&');
            rest = after;
            continue;
        };
        let entity = &after[..semi];
        let decoded = match entity {
            "lt" => Some('<'),
            "gt" => Some('>'),
            "amp" => Some('&'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            _ if entity.starts_with("#x") => u32::from_str_radix(&entity[2..], 16).ok().and_then(char::from_u32),
            _ if entity.starts_with('#') => entity[1..].parse().ok().and_then(char::from_u32),
            _ => None,
        };
        match decoded {
            Some(character) => out.push(character),
            None => {
                out.push('&');
                out.push_str(entity);
                out.push(';');
            }
        }
        rest = &after[semi + 1..];
    }
    out.push_str(rest);
}

fn compress(text: &str) -> Box<[u8]> {
    let mut encoder = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::fast());
    let _ = encoder.write_all(text.as_bytes());
    encoder.finish().unwrap_or_default().into_boxed_slice()
}

fn decompress(doc: &Doc) -> String {
    let mut out = String::with_capacity(doc.text_len as usize);
    let _ = flate2::read::DeflateDecoder::new(&doc.text[..]).read_to_string(&mut out);
    out
}

fn make_doc(path: &str, mtime: u64, size: u64, extracted: Extracted) -> Doc {
    let (kind, text) = match extracted {
        Extracted::Text(mut text) => {
            // Collapse runs of blank space so the stored text stays small.
            let mut compact = String::with_capacity(text.len().min(MAX_TEXT_BYTES));
            let mut last_space = true;
            for character in text.drain(..) {
                if character.is_whitespace() || character == '\0' {
                    if !last_space {
                        compact.push(if character == '\n' { '\n' } else { ' ' });
                    }
                    last_space = true;
                } else {
                    compact.push(character);
                    last_space = false;
                }
                if compact.len() >= MAX_TEXT_BYTES {
                    break;
                }
            }
            (Kind::Text, compact)
        }
        Extracted::Protected => (Kind::Protected, String::new()),
        Extracted::Failed => (Kind::Failed, String::new()),
    };
    Doc { path: path.into(), mtime, size, kind, text_len: text.len() as u32, text: compress(&text) }
}

// ------------------------------------------------------------- persistence

fn write_bytes(out: &mut impl Write, bytes: &[u8]) -> std::io::Result<()> {
    out.write_all(&(bytes.len() as u32).to_le_bytes())?;
    out.write_all(bytes)
}

fn read_exact_vec(input: &mut impl Read, length: usize) -> std::io::Result<Vec<u8>> {
    let mut buffer = vec![0u8; length];
    input.read_exact(&mut buffer)?;
    Ok(buffer)
}

fn read_u32(input: &mut impl Read) -> std::io::Result<u32> {
    let mut bytes = [0u8; 4];
    input.read_exact(&mut bytes)?;
    Ok(u32::from_le_bytes(bytes))
}

fn read_u64(input: &mut impl Read) -> std::io::Result<u64> {
    let mut bytes = [0u8; 8];
    input.read_exact(&mut bytes)?;
    Ok(u64::from_le_bytes(bytes))
}

fn save(store: &mut Store, data_dir: &Path) -> std::io::Result<()> {
    let path = store_path(data_dir);
    let temporary = path.with_extension("tmp");
    {
        let mut out = std::io::BufWriter::new(fs::File::create(&temporary)?);
        out.write_all(MAGIC)?;
        out.write_all(&(store.docs.len() as u32).to_le_bytes())?;
        for doc in &store.docs {
            write_bytes(&mut out, doc.path.as_bytes())?;
            out.write_all(&doc.mtime.to_le_bytes())?;
            out.write_all(&doc.size.to_le_bytes())?;
            out.write_all(&[doc.kind as u8])?;
            out.write_all(&doc.text_len.to_le_bytes())?;
            write_bytes(&mut out, &doc.text)?;
        }
        out.flush()?;
    }
    fs::rename(&temporary, &path)?;
    store.dirty = false;
    Ok(())
}

fn load(data_dir: &Path) -> Store {
    let read = || -> std::io::Result<Store> {
        let mut input = std::io::BufReader::new(fs::File::open(store_path(data_dir))?);
        let mut magic = [0u8; 8];
        input.read_exact(&mut magic)?;
        if &magic != MAGIC {
            return Err(std::io::Error::other("unknown content index format"));
        }
        let count = read_u32(&mut input)? as usize;
        let mut docs = Vec::with_capacity(count.min(1_000_000));
        for _ in 0..count {
            let path_len = read_u32(&mut input)? as usize;
            let path = String::from_utf8(read_exact_vec(&mut input, path_len)?).map_err(std::io::Error::other)?;
            let mtime = read_u64(&mut input)?;
            let size = read_u64(&mut input)?;
            let mut kind = [0u8; 1];
            input.read_exact(&mut kind)?;
            let text_len = read_u32(&mut input)?;
            let compressed_len = read_u32(&mut input)? as usize;
            let text = read_exact_vec(&mut input, compressed_len)?.into_boxed_slice();
            let kind = match kind[0] {
                0 => Kind::Text,
                1 => Kind::Protected,
                _ => Kind::Failed,
            };
            docs.push(Doc { path: path.into(), mtime, size, kind, text, text_len });
        }
        let mut store = Store { docs, ..Default::default() };
        store.rebuild_map();
        Ok(store)
    };
    read().unwrap_or_default()
}

fn with_store<T>(data_dir: &Path, action: impl FnOnce(&mut Store) -> T) -> Option<T> {
    let mut slot = STORE.lock().ok()?;
    if slot.is_none() {
        *slot = Some(load(data_dir));
    }
    slot.as_mut().map(action)
}

/// Turning the feature off removes every stored word from disk and memory.
pub fn clear(data_dir: &Path) {
    GENERATION.fetch_add(1, Ordering::SeqCst);
    if let Ok(mut slot) = STORE.lock() {
        *slot = Some(Store::default());
    }
    if let Ok(mut pending) = PENDING.lock() {
        pending.clear();
    }
    let _ = fs::remove_file(store_path(data_dir));
    let _ = fs::remove_file(store_path(data_dir).with_extension("tmp"));
}

// ------------------------------------------------------------------ status

fn file_mtime(meta: &fs::Metadata) -> u64 {
    meta.modified().ok().and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok()).map(|value| value.as_millis() as u64).unwrap_or(0)
}

pub fn status(config: &Value, data_dir: &Path) -> Value {
    let summary = if enabled(config) {
        with_store(data_dir, |store| {
            let mut counts = [0u64; 3];
            let (mut text_bytes, mut stored_bytes) = (0u64, 0u64);
            for doc in &store.docs {
                counts[doc.kind as usize] += 1;
                text_bytes += doc.text_len as u64;
                stored_bytes += doc.text.len() as u64;
            }
            (counts, text_bytes, stored_bytes)
        })
        .unwrap_or(([0; 3], 0, 0))
    } else {
        ([0; 3], 0, 0)
    };
    let progress = PROGRESS.lock().map(|progress| *progress).unwrap_or(Progress { seen: 0, processed: 0, total: 0 });
    json!({
        "enabled": enabled(config),
        "roots": roots(config).iter().map(|root| root.to_string_lossy().to_string()).collect::<Vec<_>>(),
        "defaultRoots": default_roots(),
        "running": SCANNING.load(Ordering::SeqCst) || PENDING_WORKER.load(Ordering::SeqCst),
        "seen": progress.seen,
        "processed": progress.processed,
        "total": progress.total,
        "documents": summary.0[Kind::Text as usize],
        "protected": summary.0[Kind::Protected as usize],
        "failed": summary.0[Kind::Failed as usize],
        "textBytes": summary.1,
        "storedBytes": summary.2,
        "file": store_path(data_dir).to_string_lossy()
    })
}

fn emit_status(app: &AppHandle) {
    let state = app.state::<crate::AppState>();
    let config = state.config.lock().map(|config| config.clone()).unwrap_or_default();
    let _ = app.emit("content-index-status", status(&config, &state.data_dir));
}

// -------------------------------------------------------------------- scan

/// Reads every supported document under the chosen folders, skipping files
/// whose size and modified time haven't changed since the last run.
pub fn start_scan(app: &AppHandle) {
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let app = app.clone();
    std::thread::spawn(move || {
        // Wait for a scan that is being cancelled to let go.
        while SCANNING.swap(true, Ordering::SeqCst) {
            std::thread::sleep(std::time::Duration::from_millis(50));
            if GENERATION.load(Ordering::SeqCst) != generation {
                return;
            }
        }
        scan(&app, generation);
        SCANNING.store(false, Ordering::SeqCst);
        emit_status(&app);
    });
}

fn scan(app: &AppHandle, generation: u64) {
    let cancelled = || GENERATION.load(Ordering::SeqCst) != generation;
    let state = app.state::<crate::AppState>();
    let config = match state.config.lock() {
        Ok(config) => config.clone(),
        Err(_) => return,
    };
    if !enabled(&config) {
        return;
    }
    let data_dir = state.data_dir.clone();
    let roots = roots(&config);
    let excluded = crate::excluded_names(&config);
    let skip_hidden = config.get("excludeHidden").and_then(Value::as_bool).unwrap_or(true);
    if let Ok(mut progress) = PROGRESS.lock() {
        *progress = Progress { seen: 0, processed: 0, total: 0 };
    }

    // 1. List candidate files (cheap: name, size and time from the folder listing).
    let mut files: Vec<(String, u64, u64)> = Vec::new();
    let mut stack: Vec<PathBuf> = roots.clone();
    let mut last_emit = std::time::Instant::now();
    while let Some(dir) = stack.pop() {
        if cancelled() {
            return;
        }
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if (skip_hidden && name.starts_with('.')) || name.starts_with("~$") || excluded.iter().any(|item| item.eq_ignore_ascii_case(&name)) {
                continue;
            }
            let Ok(file_type) = entry.file_type() else { continue };
            if file_type.is_dir() {
                stack.push(entry.path());
            } else if file_type.is_file() {
                let path = entry.path();
                if !supported_extension(&crate::file_extension(&path)) {
                    continue;
                }
                let Ok(meta) = entry.metadata() else { continue };
                if meta.len() == 0 || meta.len() > MAX_FILE_BYTES {
                    continue;
                }
                files.push((path.to_string_lossy().to_string(), file_mtime(&meta), meta.len()));
            }
        }
        if let Ok(mut progress) = PROGRESS.lock() {
            progress.seen = files.len() as u64;
        }
        if last_emit.elapsed() > std::time::Duration::from_secs(1) {
            emit_status(app);
            last_emit = std::time::Instant::now();
        }
    }

    // 2. Drop documents that are gone or no longer under a chosen folder.
    let wanted: std::collections::HashSet<String> = files.iter().map(|(path, _, _)| Store::key(path)).collect();
    let _ = with_store(&data_dir, |store| {
        let stale: Vec<String> = store.docs.iter().filter(|doc| !wanted.contains(&Store::key(&doc.path))).map(|doc| doc.path.to_string()).collect();
        for path in stale {
            store.remove(&path);
        }
    });

    // 3. Read new and changed documents, one at a time to stay light.
    let changed: Vec<(String, u64, u64)> = with_store(&data_dir, |store| {
        files.iter().filter(|(path, mtime, size)| store.get(path).map(|doc| doc.mtime != *mtime || doc.size != *size).unwrap_or(true)).cloned().collect()
    })
    .unwrap_or_default();
    if let Ok(mut progress) = PROGRESS.lock() {
        progress.total = changed.len() as u64;
    }
    let mut last_save = std::time::Instant::now();
    for (position, (path, mtime, size)) in changed.into_iter().enumerate() {
        if cancelled() {
            break;
        }
        let doc = make_doc(&path, mtime, size, extract(Path::new(&path)));
        let _ = with_store(&data_dir, |store| store.upsert(doc));
        if let Ok(mut progress) = PROGRESS.lock() {
            progress.processed = position as u64 + 1;
        }
        if last_emit.elapsed() > std::time::Duration::from_secs(1) {
            emit_status(app);
            last_emit = std::time::Instant::now();
        }
        if last_save.elapsed() > std::time::Duration::from_secs(60) {
            let _ = with_store(&data_dir, |store| save(store, &data_dir));
            last_save = std::time::Instant::now();
        }
    }
    if cancelled() || !current_enabled(app) {
        return;
    }
    let _ = with_store(&data_dir, |store| if store.dirty { save(store, &data_dir) } else { Ok(()) });
}

fn current_enabled(app: &AppHandle) -> bool {
    app.state::<crate::AppState>().config.lock().map(|config| enabled(&config)).unwrap_or(false)
}

/// Called by the file watcher: re-reads changed documents under the chosen
/// folders (or forgets deleted ones) without a full rescan.
pub fn files_changed(app: &AppHandle, paths: &[PathBuf]) {
    let state = app.state::<crate::AppState>();
    let Ok(config) = state.config.lock().map(|config| config.clone()) else { return };
    if !enabled(&config) {
        return;
    }
    let roots = roots(&config);
    let relevant: Vec<PathBuf> = paths
        .iter()
        .filter(|path| supported_extension(&crate::file_extension(path)) && roots.iter().any(|root| crate::is_path_within(path, root)))
        .cloned()
        .collect();
    if relevant.is_empty() {
        return;
    }
    if let Ok(mut pending) = PENDING.lock() {
        pending.extend(relevant);
    }
    if PENDING_WORKER.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let data_dir = app.state::<crate::AppState>().data_dir.clone();
        loop {
            // Saving an Office file touches it several times; let it settle.
            std::thread::sleep(std::time::Duration::from_secs(2));
            let batch: Vec<PathBuf> = match PENDING.lock() {
                Ok(mut pending) => {
                    let mut batch: Vec<PathBuf> = pending.drain(..).collect();
                    batch.sort();
                    batch.dedup();
                    batch
                }
                Err(_) => break,
            };
            if batch.is_empty() {
                break;
            }
            for path in batch {
                if !current_enabled(&app) {
                    break;
                }
                let text = path.to_string_lossy().to_string();
                match fs::metadata(&path) {
                    Ok(meta) if meta.is_file() && meta.len() > 0 && meta.len() <= MAX_FILE_BYTES => {
                        let (mtime, size) = (file_mtime(&meta), meta.len());
                        let unchanged = with_store(&data_dir, |store| store.get(&text).map(|doc| doc.mtime == mtime && doc.size == size).unwrap_or(false)).unwrap_or(false);
                        if !unchanged {
                            let doc = make_doc(&text, mtime, size, extract(&path));
                            let _ = with_store(&data_dir, |store| store.upsert(doc));
                        }
                    }
                    _ => {
                        let _ = with_store(&data_dir, |store| store.remove(&text));
                    }
                }
            }
            if current_enabled(&app) {
                let _ = with_store(&data_dir, |store| if store.dirty { save(store, &data_dir) } else { Ok(()) });
            }
        }
        PENDING_WORKER.store(false, Ordering::SeqCst);
        emit_status(&app);
    });
}

// ------------------------------------------------------------------ search

pub struct Query {
    /// Words that must all appear in the body (lowercase).
    pub body: Vec<String>,
    /// Words that must all appear in the file name (lowercase).
    pub name: Vec<String>,
    pub extensions: Vec<String>,
    pub scope: Option<PathBuf>,
}

/// Splits a query for the body index: in body mode (`body:` token) plain
/// words search the text; `content:word` always does. `ext:` filters apply.
pub fn parse_query(query: &str, body_mode: bool, scope: Option<PathBuf>) -> Query {
    let mut parsed = Query { body: Vec::new(), name: Vec::new(), extensions: Vec::new(), scope };
    for token in query.split_whitespace() {
        let token = token.trim_matches(|c| c == '"' || c == '\'');
        let lower = token.to_lowercase();
        if lower == "body:" || lower.is_empty() {
            continue;
        }
        if let Some(value) = lower.strip_prefix("content:") {
            if !value.is_empty() {
                parsed.body.push(value.to_string());
            }
        } else if let Some(value) = lower.strip_prefix("ext:") {
            parsed.extensions.extend(value.split([';', ',']).filter(|item| !item.is_empty()).map(|item| item.trim_start_matches('.').to_string()));
        } else if lower.contains(':') || lower.starts_with(['!', '-']) || lower == "|" {
            continue;
        } else if body_mode {
            parsed.body.push(lower);
        } else {
            parsed.name.push(lower);
        }
    }
    parsed
}

/// About 90 characters around the first match, on one line.
fn snippet(text: &str, lower: &str, terms: &[String]) -> String {
    let Some(position) = terms.iter().filter_map(|term| lower.find(term.as_str())).min() else {
        return String::new();
    };
    let mut start = position.saturating_sub(60);
    while !text.is_char_boundary(start) {
        start -= 1;
    }
    let mut end = (position + 120).min(text.len());
    while !text.is_char_boundary(end) {
        end += 1;
    }
    let mut piece: String = text[start..end].split_whitespace().collect::<Vec<_>>().join(" ");
    if start > 0 {
        piece.insert(0, '…');
    }
    if end < text.len() {
        piece.push('…');
    }
    piece
}

pub fn search(data_dir: &Path, query: &Query, limit: usize) -> (Vec<Value>, usize) {
    if query.body.is_empty() {
        return (Vec::new(), 0);
    }
    with_store(data_dir, |store| {
        let mut hits: Vec<(bool, u64, Value)> = store
            .docs
            .par_iter()
            .filter(|doc| doc.kind == Kind::Text)
            .filter(|doc| query.scope.as_ref().map(|root| crate::is_path_within(Path::new(doc.path.as_ref()), root)).unwrap_or(true))
            .filter_map(|doc| {
                let path = Path::new(doc.path.as_ref());
                let name = path.file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_default();
                let extension = crate::file_extension(path);
                if !query.extensions.is_empty() && !query.extensions.iter().any(|item| *item == extension) {
                    return None;
                }
                let lower_name = name.to_lowercase();
                if !query.name.iter().all(|term| lower_name.contains(term.as_str())) {
                    return None;
                }
                let text = decompress(doc);
                let lower = text.to_ascii_lowercase();
                if !query.body.iter().all(|term| lower.contains(term.as_str())) {
                    return None;
                }
                let folder = path.parent().map(|parent| parent.to_string_lossy().to_string()).unwrap_or_default();
                // A document whose name also has the word is the better match.
                let name_hit = query.body.iter().any(|term| lower_name.contains(term.as_str()));
                Some((name_hit, doc.mtime, json!({
                    "name": name,
                    "path": folder,
                    "fullPath": doc.path.as_ref(),
                    "size": doc.size,
                    "mtime": doc.mtime,
                    "ctime": doc.mtime,
                    "isDir": false,
                    "ext": extension,
                    "tags": [],
                    "starred": false,
                    "snippet": snippet(&text, &lower, &query.body)
                })))
            })
            .collect();
        let total = hits.len();
        // Name matches first, then the most recently changed documents.
        hits.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.cmp(&a.1)));
        (hits.into_iter().take(limit).map(|(_, _, record)| record).collect(), total)
    })
    .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn xml_text_reads_runs_and_paragraphs() {
        let mut out = String::new();
        xml_text(r#"<?xml version="1.0"?><w:document><w:p><w:r><w:t xml:space="preserve">개인정보 </w:t></w:r><w:r><w:t>처리&amp;보관</w:t></w:r></w:p><w:p><w:r><w:tab/><w:t>둘째</w:t></w:r></w:p></w:document>"#, &mut out);
        assert_eq!(out, "개인정보 처리&보관\n 둘째\n");
        let mut cells = String::new();
        xml_text("<sst><si><t>후원금 정산</t></si><si><t>예산</t></si></sst>", &mut cells);
        assert_eq!(cells, "후원금 정산\n예산\n");
    }

    #[test]
    fn decodes_cp949_text() {
        let (bytes, _, _) = encoding_rs::EUC_KR.encode("계약서 본문");
        assert_eq!(decode_text(&bytes), "계약서 본문");
        assert_eq!(decode_text("utf8 계약".as_bytes()), "utf8 계약");
    }

    #[test]
    fn query_split_and_snippet() {
        let query = parse_query("body: 개인정보 ext:hwp;docx !draft", true, None);
        assert_eq!(query.body, vec!["개인정보"]);
        assert_eq!(query.extensions, vec!["hwp", "docx"]);
        let mixed = parse_query("보고서 content:예산", false, None);
        assert_eq!((mixed.name, mixed.body), (vec!["보고서".to_string()], vec!["예산".to_string()]));
        let text = "앞부분 내용입니다. 개인정보 처리방침에 따라 보관합니다.";
        let piece = snippet(text, &text.to_ascii_lowercase(), &["개인정보".to_string()]);
        assert!(piece.contains("개인정보 처리방침"));
    }

    #[test]
    fn reads_korean_pdf_through_tounicode() {
        // Built in memory like Edge/Hangul output: a Type0 (CID) font whose
        // two-byte codes only decode through its ToUnicode map.
        use lopdf::{dictionary, Object, Stream};
        let mut document = lopdf::Document::with_version("1.7");
        let cmap = b"/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n1 begincodespacerange <0000> <FFFF> endcodespacerange\n5 beginbfchar\n<0001> <AC1C>\n<0002> <C778>\n<0003> <C815>\n<0004> <BCF4>\n<0005> <0020>\nendbfchar\n1 beginbfrange\n<0006> <0008> <0041>\nendbfrange\nendcmap end end\n".to_vec();
        let to_unicode = document.add_object(Stream::new(dictionary! {}, cmap));
        let font = document.add_object(dictionary! {
            "Type" => "Font", "Subtype" => "Type0", "BaseFont" => "MalgunGothic", "Encoding" => "Identity-H",
            "ToUnicode" => Object::Reference(to_unicode),
        });
        let content = b"BT /F1 12 Tf <0001000200030004> Tj 0 -20 Td [<0006> -400 <00070008>] TJ ET".to_vec();
        let content_id = document.add_object(Stream::new(dictionary! {}, content));
        let pages_id = document.new_object_id();
        let page_id = document.add_object(dictionary! {
            "Type" => "Page", "Parent" => Object::Reference(pages_id), "Contents" => Object::Reference(content_id),
            "Resources" => dictionary! { "Font" => dictionary! { "F1" => Object::Reference(font) } },
            "MediaBox" => vec![0.into(), 0.into(), 595.into(), 842.into()],
        });
        document.objects.insert(pages_id, Object::Dictionary(dictionary! {
            "Type" => "Pages", "Kids" => vec![Object::Reference(page_id)], "Count" => 1,
        }));
        let catalog = document.add_object(dictionary! { "Type" => "Catalog", "Pages" => Object::Reference(pages_id) });
        document.trailer.set("Root", catalog);
        let mut bytes = Vec::new();
        document.save_to(&mut bytes).unwrap();
        let loaded = lopdf::Document::load_mem(&bytes).unwrap();
        match pdf_document_text(&loaded) {
            Extracted::Text(text) => {
                let flat: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
                assert_eq!(flat, "개인정보 A BC");
            }
            _ => panic!("pdf text was not read"),
        }
    }

    #[test]
    fn indexes_office_zip_and_skips_protected() {
        let dir = std::env::temp_dir().join(format!("dawith-content-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        // A real (deflated) docx-like ZIP written with the same flate2 crate.
        let xml = "<w:document><w:body><w:p><w:r><w:t>분기 예산 보고</w:t></w:r></w:p></w:body></w:document>";
        let mut encoder = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(xml.as_bytes()).unwrap();
        let compressed = encoder.finish().unwrap();
        let name = b"word/document.xml";
        let mut zip = Vec::new();
        zip.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
        zip.extend_from_slice(&[20, 0, 0, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        zip.extend_from_slice(&(compressed.len() as u32).to_le_bytes());
        zip.extend_from_slice(&(xml.len() as u32).to_le_bytes());
        zip.extend_from_slice(&(name.len() as u16).to_le_bytes());
        zip.extend_from_slice(&0u16.to_le_bytes());
        zip.extend_from_slice(name);
        zip.extend_from_slice(&compressed);
        let central = zip.len();
        zip.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
        zip.extend_from_slice(&[20, 0, 20, 0, 0, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        zip.extend_from_slice(&(compressed.len() as u32).to_le_bytes());
        zip.extend_from_slice(&(xml.len() as u32).to_le_bytes());
        zip.extend_from_slice(&(name.len() as u16).to_le_bytes());
        zip.extend_from_slice(&[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        zip.extend_from_slice(name);
        let central_len = zip.len() - central;
        zip.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
        zip.extend_from_slice(&[0, 0, 0, 0, 1, 0, 1, 0]);
        zip.extend_from_slice(&(central_len as u32).to_le_bytes());
        zip.extend_from_slice(&(central as u32).to_le_bytes());
        zip.extend_from_slice(&0u16.to_le_bytes());
        fs::write(dir.join("report.docx"), &zip).unwrap();
        fs::write(dir.join("locked.docx"), [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).unwrap();

        match extract(&dir.join("report.docx")) {
            Extracted::Text(text) => assert!(text.contains("분기 예산 보고"), "{text}"),
            _ => panic!("docx was not read"),
        }
        assert!(matches!(extract(&dir.join("locked.docx")), Extracted::Protected));
        // Company DRM wraps every format behind its own header.
        let mut wrapped = vec![0x9b, 0x20, 0x44, 0x52, 0x4d, 0x4f, 0x4e, 0x45];
        wrapped.extend_from_slice(b"  This Document is protected");
        for name in ["drm.hwp", "drm.hwpx", "drm.pdf", "drm.xlsx"] {
            fs::write(dir.join(name), &wrapped).unwrap();
            assert!(matches!(extract(&dir.join(name)), Extracted::Protected), "{name}");
        }
        // HWP whose FileHeader marks it password-protected or distribution-only.
        for (name, flags) in [("password.hwp", 1u32 << 1), ("distribution.hwp", 1u32 << 2), ("plain.hwp", 1u32)] {
            let mut file = cfb::create(dir.join(name)).unwrap();
            let mut header = vec![0u8; 256];
            header[..17].copy_from_slice(b"HWP Document File");
            header[36..40].copy_from_slice(&flags.to_le_bytes());
            file.create_stream("/FileHeader").unwrap().write_all(&header).unwrap();
            file.flush().unwrap();
            drop(file);
            assert_eq!(hwp_is_protected(&dir.join(name)), name != "plain.hwp", "{name}");
        }
        assert!(matches!(extract(&dir.join("distribution.hwp")), Extracted::Protected));

        // Round trip through the saved file and search it.
        let mut store = Store::default();
        store.upsert(make_doc(&dir.join("report.docx").to_string_lossy(), 5, zip.len() as u64, extract(&dir.join("report.docx"))));
        store.upsert(make_doc(&dir.join("locked.docx").to_string_lossy(), 6, 8, Extracted::Protected));
        save(&mut store, &dir).unwrap();
        let loaded = load(&dir);
        assert_eq!(loaded.docs.len(), 2);
        *STORE.lock().unwrap() = Some(loaded);
        let (hits, total) = search(&dir, &parse_query("body: 예산", true, None), 10);
        assert_eq!(total, 1);
        assert_eq!(hits[0]["name"], "report.docx");
        assert!(hits[0]["snippet"].as_str().unwrap().contains("예산"));
        clear(&dir);
        assert!(!store_path(&dir).exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
