#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use rfd::FileDialog;
use serde_json::{json, Value};
use std::fs;
use std::io::{Read, Write};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State, Window};
use walkdir::WalkDir;

struct AppState {
    config: Mutex<Value>,
    data_dir: PathBuf,
    local_index: Mutex<LocalIndex>,
}

#[derive(Default)]
struct LocalIndex {
    records: Vec<Value>,
    indexing: bool,
    ready: bool,
    total_files: usize,
    total_folders: usize,
}

fn home_dir() -> PathBuf {
    if cfg!(windows) {
        std::env::var_os("USERPROFILE")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."))
    } else {
        std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."))
    }
}

fn data_dir() -> PathBuf {
    home_dir().join(".dawith-search")
}

fn default_local_roots() -> Vec<String> {
    if cfg!(windows) {
        let mut roots = Vec::new();
        if let Ok(output) = Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Get-CimInstance Win32_LogicalDisk | Where-Object { $_.DriveType -eq 2 -or $_.DriveType -eq 3 } | Select-Object -ExpandProperty DeviceID",
            ])
            .output()
        {
            if output.status.success() {
                for line in String::from_utf8_lossy(&output.stdout).lines() {
                    let drive = line.trim();
                    if drive.len() == 2 && drive.ends_with(':') {
                        roots.push(format!("{drive}\\"));
                    }
                }
            }
            }
        }
        if !roots.is_empty() {
            return roots;
        }
        let fallback_drive = std::env::var_os("SystemDrive").or_else(|| {
            std::env::var_os("USERPROFILE").and_then(|profile| profile.to_string_lossy().get(..2).map(std::ffi::OsString::from))
        });
        if let Some(system_drive) = fallback_drive {
            let drive = system_drive.to_string_lossy();
            if drive.len() == 2 && drive.ends_with(':') {
                return vec![format!("{drive}\\")];
            }
        }
    }
    vec![home_dir().to_string_lossy().into_owned()]
}

fn default_config() -> Value {
    let local_roots = default_local_roots();
    json!({
        "roots": local_roots.clone(),
        "localRoots": local_roots,
        "autoLocalRoots": true,
        "excludeFolders": ["node_modules", ".git", ".cache", "AppData", "$Recycle.Bin", "System Volume Information", "__pycache__", "Temp", "Cache"],
        "excludeHidden": true,
        "maxDepth": 64,
        "autoStartWatcher": false,
        "searchBackend": "auto",
        "uiMode": null
    })
}

fn read_config(dir: &Path) -> Value {
    let file = dir.join("config.json");
    let mut config = fs::read_to_string(file)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_else(default_config);

    // Older Tauri builds persisted only the user profile (or an empty roots
    // array). Keep explicit external roots, but always restore the automatic
    // local-device scope when that option is enabled. This is what makes an
    // existing install find Desktop/Documents after an update.
    let auto_local = config.get("autoLocalRoots").and_then(Value::as_bool).unwrap_or(true);
    if auto_local {
        let local_roots = default_local_roots();
        if let Some(object) = config.as_object_mut() {
            let mut roots = object
                .get("roots")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            for root in &local_roots {
                if !roots.iter().any(|value| value.as_str() == Some(root)) {
                    roots.push(Value::String(root.clone()));
                }
            }
            object.insert("roots".to_string(), Value::Array(roots));
            object.insert(
                "localRoots".to_string(),
                Value::Array(local_roots.into_iter().map(Value::String).collect()),
            );
        }
    }
    config
}

fn atomic_write(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let temp = path.with_extension("json.tmp");
    let mut file = fs::File::create(&temp).map_err(|error| error.to_string())?;
    file.write_all(
        serde_json::to_vec_pretty(value)
            .map_err(|error| error.to_string())?
            .as_slice(),
    )
    .map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    fs::rename(temp, path).map_err(|error| error.to_string())
}

fn read_json(path: &Path, fallback: Value) -> Value {
    fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or(fallback)
}

fn storage_path(state: &AppState, name: &str) -> PathBuf {
    state.data_dir.join(name)
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn metadata_value(state: &AppState) -> Value {
    let value = read_json(&storage_path(state, "metadata.json"), json!({}));
    json!({
        "tags": value.get("tags").cloned().unwrap_or_else(|| json!({})),
        "starred": value.get("starred").cloned().unwrap_or_else(|| json!({}))
    })
}

fn save_metadata(state: &AppState, value: &Value) -> Result<(), String> {
    atomic_write(&storage_path(state, "metadata.json"), value)
}

fn hydrate_records(records: &mut [Value], metadata: &Value) {
    for record in records {
        let Some(path) = record.get("fullPath").and_then(Value::as_str) else {
            continue;
        };
        let tags = metadata
            .get("tags")
            .and_then(|value| value.get(path))
            .cloned()
            .unwrap_or_else(|| json!([]));
        let starred = metadata
            .get("starred")
            .and_then(|value| value.get(path))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if let Some(object) = record.as_object_mut() {
            object.insert("tags".to_string(), tags);
            object.insert("starred".to_string(), json!(starred));
        }
    }
}

fn config_roots(config: &Value) -> Vec<PathBuf> {
    config
        .get("roots")
        .and_then(Value::as_array)
        .map(|roots| {
            roots
                .iter()
                .filter_map(Value::as_str)
                .map(PathBuf::from)
                .collect()
        })
        .unwrap_or_default()
}

fn normalize_path(path: &Path) -> String {
    let text = path.to_string_lossy().replace('\\', "/");
    if cfg!(windows) {
        text.to_ascii_lowercase()
    } else {
        text
    }
}

fn is_allowed_path(path: &Path, config: &Value) -> bool {
    let candidate = normalize_path(path);
    config_roots(config).iter().any(|root| {
        let scope = normalize_path(root);
        let scope = if scope.len() > 1 {
            scope.trim_end_matches('/').to_string()
        } else {
            scope
        };
        candidate == scope || candidate.starts_with(&format!("{scope}/"))
    })
}

fn is_path_within(candidate: &Path, root: &Path) -> bool {
    let candidate = normalize_path(candidate);
    let scope = normalize_path(root);
    let scope = if scope.len() > 1 { scope.trim_end_matches('/').to_string() } else { scope };
    candidate == scope || candidate.starts_with(&format!("{scope}/"))
}

fn path_record(path: &Path) -> Option<Value> {
    let metadata = fs::metadata(path).ok()?;
    let name = path.file_name()?.to_string_lossy().into_owned();
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let is_dir = metadata.is_dir();
    let ext = if is_dir {
        String::new()
    } else {
        path.extension()
            .map(|value| value.to_string_lossy().to_ascii_lowercase())
            .unwrap_or_default()
    };
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);
    Some(json!({
        "name": name,
        "path": parent.to_string_lossy(),
        "fullPath": path.to_string_lossy(),
        "size": if is_dir { 0 } else { metadata.len() },
        "mtime": modified,
        "ctime": modified,
        "isDir": is_dir,
        "ext": ext,
        "tags": [],
        "starred": false
    }))
}

fn excluded_names(config: &Value) -> Vec<String> {
    config
        .get("excludeFolders")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(|value| value.to_ascii_lowercase())
                .collect()
        })
        .unwrap_or_default()
}

fn should_skip_entry(entry: &walkdir::DirEntry, config: &Value, excluded: &[String]) -> bool {
    let name = entry.file_name().to_string_lossy();
    if config.get("excludeHidden").and_then(Value::as_bool).unwrap_or(true) && name.starts_with('.') {
        return true;
    }
    excluded.iter().any(|item| item == &name.to_ascii_lowercase())
}

fn local_index_roots(config: &Value) -> Vec<PathBuf> {
    let configured = config_roots(config);
    let mut roots = Vec::new();
    let mut seen = HashSet::new();

    // Scan the user profile first. Desktop/Documents become searchable while
    // the rest of a large Windows volume continues in the background.
    if cfg!(windows) {
        let home = home_dir();
        if configured.iter().any(|root| is_allowed_path(&home, config)) {
            let key = normalize_path(&home);
            seen.insert(key);
            roots.push(home);
        }
    }
    for root in configured {
        let key = normalize_path(&root);
        if seen.insert(key) {
            roots.push(root);
        }
    }
    roots
}

fn publish_index_snapshot(
    app: &AppHandle,
    records: &[Value],
    total_files: usize,
    total_folders: usize,
    root: &Path,
    root_index: usize,
    total_roots: usize,
    started_at: u128,
) {
    if let Ok(mut index) = app.state::<AppState>().local_index.lock() {
        index.records = records.to_vec();
        index.ready = !records.is_empty();
        index.total_files = total_files;
        index.total_folders = total_folders;
    }
    let _ = app.emit(
        "index-status",
        json!({
            "status": "indexing-progress",
            "stats": {
                "totalFiles": total_files,
                "totalFolders": total_folders,
                "root": root.to_string_lossy(),
                "rootIndex": root_index,
                "totalRoots": total_roots,
                "elapsedMs": now_millis().saturating_sub(started_at as u64)
            }
        }),
    );
}

fn start_local_indexing(app: &AppHandle) -> Result<bool, String> {
    if cfg!(windows) && everything_ipc_ready(app).map(|(_, ready)| ready).unwrap_or(false) {
        let _ = app.emit("index-status", json!({ "status": "idle", "stats": { "native": true } }));
        return Ok(false);
    }
    let state = app.state::<AppState>();
    let config = state.config.lock().map_err(|_| "설정 잠금에 실패했습니다.")?.clone();
    {
        let mut index = state.local_index.lock().map_err(|_| "로컬 색인 잠금에 실패했습니다.")?;
        if index.indexing {
            return Ok(false);
        }
        index.indexing = true;
        index.ready = false;
        index.records.clear();
        index.total_files = 0;
        index.total_folders = 0;
    }
    let started_at = now_millis();
    let _ = app.emit(
        "index-status",
        json!({ "status": "indexing", "stats": { "totalFiles": 0, "totalFolders": 0 } }),
    );

    let worker_app = app.clone();
    std::thread::spawn(move || {
        let roots = local_index_roots(&config)
            .into_iter()
            .filter(|root| root.exists())
            .collect::<Vec<_>>();
        let excluded = excluded_names(&config);
        let max_depth = config
            .get("maxDepth")
            .and_then(Value::as_u64)
            .unwrap_or(64)
            .clamp(1, 256) as usize;
        let mut records = Vec::new();
        let mut seen = HashSet::new();
        let mut total_files = 0usize;
        let mut total_folders = 0usize;

        for (root_index, root) in roots.iter().enumerate() {
            let walker = WalkDir::new(root)
                .follow_links(false)
                .max_depth(max_depth + 1)
                .into_iter()
                .filter_entry(|entry| !should_skip_entry(entry, &config, &excluded));
            for entry in walker.filter_map(Result::ok) {
                let path = entry.path();
                if !is_allowed_path(path, &config) || !seen.insert(normalize_path(path)) {
                    continue;
                }
                if let Some(record) = path_record(path) {
                    if record.get("isDir").and_then(Value::as_bool).unwrap_or(false) {
                        total_folders += 1;
                    } else {
                        total_files += 1;
                    }
                    records.push(record);
                }
                if records.len() % 2000 == 0 {
                    publish_index_snapshot(
                        &worker_app,
                        &records,
                        total_files,
                        total_folders,
                        root,
                        root_index,
                        roots.len(),
                        started_at as u128,
                    );
                }
            }
            publish_index_snapshot(
                &worker_app,
                &records,
                total_files,
                total_folders,
                root,
                root_index,
                roots.len(),
                started_at as u128,
            );
        }

        if let Ok(mut index) = worker_app.state::<AppState>().local_index.lock() {
            index.records = records;
            index.ready = true;
            index.indexing = false;
            index.total_files = total_files;
            index.total_folders = total_folders;
        }
        let _ = worker_app.emit(
            "index-status",
            json!({
                "status": "idle",
                "stats": {
                    "totalFiles": total_files,
                    "totalFolders": total_folders,
                    "elapsedMs": now_millis().saturating_sub(started_at)
                }
            }),
        );
    });
    Ok(true)
}

fn native_record(item: &Value) -> Option<Value> {
    let full_path = item.get("path")?.as_str()?;
    let path = PathBuf::from(full_path);
    if let Some(record) = path_record(&path) {
        return Some(record);
    }
    let is_dir = item.get("is_dir").and_then(Value::as_bool).unwrap_or(false);
    let name = path.file_name()?.to_string_lossy().into_owned();
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let ext = if is_dir {
        String::new()
    } else {
        path.extension()
            .map(|value| value.to_string_lossy().to_ascii_lowercase())
            .unwrap_or_default()
    };
    Some(json!({
        "name": name,
        "path": parent.to_string_lossy(),
        "fullPath": full_path,
        "size": item.get("size").and_then(Value::as_u64).unwrap_or(0),
        "mtime": item.get("date_modified").and_then(Value::as_u64).unwrap_or(0),
        "ctime": item.get("date_modified").and_then(Value::as_u64).unwrap_or(0),
        "isDir": is_dir,
        "ext": ext,
        "tags": [],
        "starred": false
    }))
}

fn query_terms(query: &str) -> Vec<String> {
    query
        .split_whitespace()
        .filter(|part| {
            !part.contains(':')
                && !part.starts_with('-')
                && !part.starts_with('!')
                && !part.contains('|')
        })
        .map(|part| part.trim_matches('"').to_string())
        .filter(|part| !part.is_empty())
        .collect()
}

fn translate_natural_query(raw: &str) -> String {
    let mut query = raw.trim().to_string();
    let replacements = [
        ("지난 주에", "dm:lastweek "),
        ("지난주에", "dm:lastweek "),
        ("지난 주", "dm:lastweek "),
        ("지난주", "dm:lastweek "),
        ("어제", "dm:yesterday "),
        ("오늘", "dm:today "),
        ("큰 파일", "size:huge "),
        ("대용량 파일", "size:huge "),
        ("중복 파일", "dupe:name "),
        ("동영상", "video: "),
        ("비디오", "video: "),
        ("사진", "pic: "),
        ("이미지", "pic: "),
        ("문서", "doc: "),
        ("엑셀", "ext:xlsx,xls "),
        ("스프레드시트", "ext:xlsx,xls "),
        ("PDF", "ext:pdf "),
        ("폴더만", "folder: "),
    ];
    for (from, to) in replacements {
        query = query.replace(from, to);
    }
    let tokens = query.split_whitespace().collect::<Vec<_>>();
    let mut expanded = Vec::new();
    let mut index = 0;
    while index < tokens.len() {
        let token = tokens[index];
        let lower_token = token.to_ascii_lowercase();
        if index + 1 < tokens.len()
            && tokens[index + 1].starts_with("이상")
            && ["kb", "mb", "gb", "tb"].iter().any(|unit| lower_token.ends_with(unit))
        {
            expanded.push(format!("size:>{token}"));
            index += 2;
            continue;
        }
        expanded.push(token.to_string());
        index += 1;
    }
    expanded.join(" ")
}

fn category_extensions(category: &str) -> &'static [&'static str] {
    match category {
        "doc" | "document" => &["doc", "docx", "pdf", "xls", "xlsx", "ppt", "pptx", "txt", "hwp", "hwpx", "csv", "rtf", "odt", "ods", "odp", "md"],
        "pic" | "picture" | "image" => &["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "tiff", "heic", "raw", "psd", "ai"],
        "video" => &["mp4", "mkv", "avi", "mov", "wmv", "flv", "webm", "m4v", "3gp", "ts", "mts"],
        "audio" => &["mp3", "wav", "flac", "aac", "ogg", "m4a", "wma", "opus", "alac", "mid", "midi"],
        "zip" | "compressed" => &["zip", "7z", "rar", "tar", "gz", "bz2", "xz", "iso", "tgz", "cab", "jar"],
        "exe" | "executable" => &["exe", "msi", "bat", "cmd", "ps1", "sh", "com", "vbs", "reg", "app"],
        _ => &[],
    }
}

fn translate_native_query(query: &str) -> String {
    let mut tokens = Vec::new();
    for token in query.split_whitespace() {
        let lower = token.to_ascii_lowercase();
        if let Some(category) = lower.strip_suffix(':') {
            let extensions = category_extensions(category);
            if !extensions.is_empty() {
                tokens.push(format!("ext:{}", extensions.join(";")));
                continue;
            }
        }
        tokens.push(token.to_string());
    }
    tokens.join(" ")
}

fn parse_size_bytes(value: &str) -> Option<(char, u64)> {
    let value = value.trim().to_ascii_lowercase();
    let (operator, number) = if let Some(value) = value.strip_prefix(">=") { ('G', value) }
        else if let Some(value) = value.strip_prefix("<=") { ('L', value) }
        else if let Some(value) = value.strip_prefix('>') { ('>', value) }
        else if let Some(value) = value.strip_prefix('<') { ('<', value) }
        else { ('=', value.as_str()) };
    let mut digits = number.trim();
    let unit = if digits.ends_with("tb") { digits = &digits[..digits.len() - 2]; 1024u64.pow(4) }
        else if digits.ends_with("gb") { digits = &digits[..digits.len() - 2]; 1024u64.pow(3) }
        else if digits.ends_with("mb") { digits = &digits[..digits.len() - 2]; 1024u64.pow(2) }
        else if digits.ends_with("kb") { digits = &digits[..digits.len() - 2]; 1024u64 }
        else { 1 };
    let numeric = digits.trim().parse::<f64>().ok()?;
    Some((operator, (numeric * unit as f64) as u64))
}

fn query_matches(record: &Value, raw_query: &str, use_natural_language: bool) -> bool {
    let query = if use_natural_language { translate_natural_query(raw_query) } else { raw_query.to_string() };
    if query.trim().is_empty() {
        return true;
    }
    let name = record.get("name").and_then(Value::as_str).unwrap_or("").to_ascii_lowercase();
    let full_path = record.get("fullPath").and_then(Value::as_str).unwrap_or("").to_ascii_lowercase();
    let extension = record.get("ext").and_then(Value::as_str).unwrap_or("").to_ascii_lowercase();
    let is_dir = record.get("isDir").and_then(Value::as_bool).unwrap_or(false);
    let size = record.get("size").and_then(Value::as_u64).unwrap_or(0);
    let mtime = record.get("mtime").and_then(Value::as_u64).unwrap_or(0);
    let mut target = name.as_str();
    let mut required_extensions = Vec::new();
    let mut required_type: Option<bool> = None;
    let mut terms: Vec<Vec<(String, bool)>> = Vec::new();

    for token in query.split_whitespace() {
        let clean = token.trim_matches(|character| character == '"' || character == '\'' || character == '(' || character == ')');
        let lower = clean.to_ascii_lowercase();
        if lower.ends_with(':') {
            let category = lower.trim_end_matches(':');
            if category == "folder" || category == "directory" { required_type = Some(true); continue; }
            if category == "file" { required_type = Some(false); continue; }
            let extensions = category_extensions(category);
            if !extensions.is_empty() { required_extensions.extend(extensions.iter().map(|value| (*value).to_string())); continue; }
        }
        if let Some(value) = lower.strip_prefix("ext:") {
            required_extensions.extend(value.split(&[',', ';'][..]).filter(|item| !item.is_empty()).map(|item| item.trim_start_matches('.').to_string()));
            continue;
        }
        if let Some(value) = lower.strip_prefix("path:").or_else(|| lower.strip_prefix("p:")) {
            target = full_path.as_str();
            if !value.is_empty() { terms.push(vec![(value.to_string(), false)]); }
            continue;
        }
        if let Some(value) = lower.strip_prefix("size:") {
            if value == "huge" && size < 16 * 1024 * 1024 { return false; }
            if let Some((operator, bytes)) = parse_size_bytes(value) {
                let matched = match operator { 'G' => size >= bytes, 'L' => size <= bytes, '>' => size > bytes, '<' => size < bytes, _ => size == bytes };
                if !matched { return false; }
            }
            continue;
        }
        if let Some(value) = lower.strip_prefix("dm:") {
            let seconds: u64 = if value == "today" || value == "yesterday" { 86_400 } else if value == "lastweek" { 7 * 86_400 } else { 0 };
            if seconds > 0 && mtime < now_millis().saturating_sub(seconds * 1000) { return false; }
            continue;
        }
        if lower == "starred:" || lower == "star:" {
            if !record.get("starred").and_then(Value::as_bool).unwrap_or(false) { return false; }
            continue;
        }
        if let Some(tag) = lower.strip_prefix("tag:") {
            let has_tag = record
                .get("tags")
                .and_then(Value::as_array)
                .map(|tags| tags.iter().filter_map(Value::as_str).any(|value| value.eq_ignore_ascii_case(tag)))
                .unwrap_or(false);
            if !has_tag { return false; }
            continue;
        }
        if lower.starts_with("content:") || lower.starts_with("dupe:") { continue; }
        let clauses = clean.split('|').filter(|item| !item.is_empty()).map(|item| {
            let (negated, value) = if let Some(value) = item.strip_prefix('!').or_else(|| item.strip_prefix('-')) { (true, value) } else { (false, item) };
            (value.to_ascii_lowercase(), negated)
        }).collect::<Vec<_>>();
        if !clauses.is_empty() { terms.push(clauses); }
    }

    if required_type.is_some_and(|expected| expected != is_dir) { return false; }
    if !required_extensions.is_empty() && (!required_extensions.iter().any(|value| value == &extension) || is_dir) { return false; }
    terms.iter().all(|clauses| clauses.iter().any(|(term, negated)| {
        let matched = target.contains(term);
        if *negated { !matched } else { matched }
    }))
}

fn mac_spotlight_expression(query: &str) -> String {
    let mut clauses = Vec::new();
    let lower = query.to_ascii_lowercase();
    let category_extensions: Option<Vec<&str>> = if lower.contains("doc:") {
        Some(vec!["doc", "docx", "pdf", "xls", "xlsx", "ppt", "pptx", "txt", "hwp", "hwpx", "csv", "rtf", "odt", "ods", "odp", "md"])
    } else if lower.contains("pic:") || lower.contains("image:") {
        Some(vec!["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "heic"])
    } else if lower.contains("video:") {
        Some(vec!["mp4", "mkv", "avi", "mov", "wmv", "webm"])
    } else if lower.contains("audio:") {
        Some(vec!["mp3", "wav", "flac", "aac", "ogg", "m4a"])
    } else {
        None
    };
    for term in query_terms(query) {
        let escaped = term.replace('"', "\\\"");
        clauses.push(format!("kMDItemFSName == \"*{escaped}*\"cd"));
    }
    if let Some(extensions) = category_extensions {
        let ext = extensions
            .iter()
            .map(|value| format!("kMDItemFSName == \"*.{value}\"cd"))
            .collect::<Vec<_>>();
        clauses.push(format!("({})", ext.join(" || ")));
    }
    if clauses.is_empty() {
        "kMDItemFSName == \"*\"cd".to_string()
    } else if clauses.len() == 1 {
        clauses.remove(0)
    } else {
        format!("({})", clauses.join(" && "))
    }
}

fn search_spotlight(query: &str, roots: &[PathBuf], limit: usize) -> Result<Vec<Value>, String> {
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }
    let expression = mac_spotlight_expression(query);
    let mut records = Vec::new();
    for root in roots {
        if records.len() >= limit {
            break;
        }
        let output = Command::new("mdfind")
            .arg("-onlyin")
            .arg(root)
            .arg(&expression)
            .output()
            .map_err(|error| error.to_string())?;
        for path in String::from_utf8_lossy(&output.stdout).lines() {
            if records.len() >= limit {
                break;
            }
            let candidate = PathBuf::from(path.trim());
            if let Some(record) = path_record(&candidate) {
                records.push(record);
            }
        }
    }
    Ok(records)
}

fn helper_path(app: &AppHandle) -> Option<PathBuf> {
    let resource_dir = app.path().resource_dir().ok()?;
    let arch = if cfg!(target_arch = "aarch64") { "arm64" } else { "x64" };
    let path = resource_dir
        .join("bin")
        .join("native")
        .join("windows")
        .join(arch)
        .join("everything-ipc.exe");
    path.exists().then_some(path)
}

fn search_everything(app: &AppHandle, query: &str, limit: usize) -> Option<Result<Value, String>> {
    if !cfg!(windows) {
        return None;
    }
    let helper = helper_path(app)?;
    let output = Command::new(helper)
        .arg("--json")
        .arg("-n")
        .arg(limit.to_string())
        .arg(query)
        .output();
    Some(match output {
        Ok(output) if output.status.success() || !output.stdout.is_empty() => {
            serde_json::from_slice::<Value>(&output.stdout).map_err(|error| error.to_string())
        }
        Ok(output) => Err(String::from_utf8_lossy(&output.stderr).trim().to_string()),
        Err(error) => Err(error.to_string()),
    })
}

fn everything_ipc_ready(app: &AppHandle) -> Option<(PathBuf, bool)> {
    let helper = helper_path(app)?;
    let ready = Command::new(&helper)
        .arg("--status")
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false);
    Some((helper, ready))
}

fn command_available(command: &str) -> bool {
    Command::new(command)
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn file_extension(path: &Path) -> String {
    path.extension()
        .map(|value| value.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default()
}

fn is_image_extension(extension: &str) -> bool {
    matches!(extension, "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "tif" | "tiff" | "heic")
}

fn is_office_extension(extension: &str) -> bool {
    matches!(extension, "doc" | "docx" | "xls" | "xlsx" | "ppt" | "pptx" | "odt" | "ods" | "odp" | "hwp" | "hwpx")
}

fn conversion_options(paths: &[PathBuf]) -> Value {
    if paths.is_empty() {
        return json!([]);
    }
    let extensions = paths.iter().map(|path| file_extension(path)).collect::<Vec<_>>();
    let mut options = Vec::new();
    let can_convert_images = cfg!(target_os = "macos") || command_available("magick");
    if extensions.iter().all(|extension| is_image_extension(extension)) && can_convert_images {
        options.push(json!({
            "id": "images-to-pdf",
            "label": "이미지 → PDF",
            "detail": "설치된 OS 이미지 변환 도구를 사용합니다."
        }));
    }
    if extensions.iter().all(|extension| is_office_extension(extension)) && command_available("soffice") {
        options.push(json!({
            "id": "office-to-pdf",
            "label": "문서 → PDF",
            "detail": "설치된 LibreOffice를 사용합니다. 암호화 문서는 변환하지 않습니다."
        }));
    }
    if extensions.iter().all(|extension| extension == "pdf") && extensions.len() > 1 && command_available("pdfunite") {
        options.push(json!({
            "id": "merge-pdf",
            "label": "PDF 병합",
            "detail": "설치된 Poppler pdfunite를 사용합니다."
        }));
    }
    Value::Array(options)
}

fn search_local_index(
    state: &AppState,
    config: &Value,
    query: &str,
    options: &Value,
    metadata: &Value,
    limit: usize,
) -> Result<(Vec<Value>, usize, usize, bool), String> {
    let scope = options.get("scopeRoot").and_then(Value::as_str).map(PathBuf::from);
    let use_natural_language = options.get("useAI").and_then(Value::as_bool).unwrap_or(false);
    let index = state.local_index.lock().map_err(|_| "로컬 색인 잠금에 실패했습니다.")?;
    let total_indexed = index.records.len();
    let duplicate_by_size = query.to_ascii_lowercase().contains("dupe:size");
    let duplicate_by_name = query.to_ascii_lowercase().contains("dupe:name") || query.to_ascii_lowercase().contains("dupe:");
    let mut duplicate_counts = HashMap::<String, usize>::new();
    if duplicate_by_size || duplicate_by_name {
        for record in &index.records {
            let key = if duplicate_by_size {
                record.get("size").and_then(Value::as_u64).unwrap_or(0).to_string()
            } else {
                record.get("name").and_then(Value::as_str).unwrap_or("").to_ascii_lowercase()
            };
            if !key.is_empty() && key != "0" { *duplicate_counts.entry(key).or_insert(0) += 1; }
        }
    }
    let mut total_matches = 0usize;
    let mut results = Vec::new();
    for record in &index.records {
        let full_path = record.get("fullPath").and_then(Value::as_str).unwrap_or("");
        if let Some(scope) = &scope {
            if !is_path_within(Path::new(full_path), scope) { continue; }
        } else if !is_allowed_path(Path::new(full_path), config) {
            continue;
        }
        let duplicate_key = if duplicate_by_size {
            record.get("size").and_then(Value::as_u64).unwrap_or(0).to_string()
        } else {
            record.get("name").and_then(Value::as_str).unwrap_or("").to_ascii_lowercase()
        };
        if (duplicate_by_size || duplicate_by_name) && duplicate_counts.get(&duplicate_key).copied().unwrap_or(0) < 2 { continue; }
        let mut hydrated = record.clone();
        hydrate_records(std::slice::from_mut(&mut hydrated), metadata);
        if !query_matches(&hydrated, query, use_natural_language) { continue; }
        total_matches += 1;
        if results.len() < limit { results.push(hydrated); }
    }
    hydrate_records(&mut results, metadata);
    Ok((results, total_matches, total_indexed, index.indexing))
}

fn fallback_walk(query: &str, roots: &[PathBuf], config: &Value, limit: usize) -> Vec<Value> {
    let terms = query_terms(query)
        .iter()
        .map(|value| value.to_lowercase())
        .collect::<Vec<_>>();
    let excluded = config
        .get("excludeFolders")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(|value| value.to_lowercase())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let mut results = Vec::new();
    for root in roots {
        for entry in WalkDir::new(root)
            .follow_links(false)
            .into_iter()
            .filter_map(Result::ok)
        {
            if results.len() >= limit {
                return results;
            }
            let path = entry.path();
            if !is_allowed_path(path, config) {
                continue;
            }
            if path
                .components()
                .any(|component| excluded.iter().any(|name| name == &component.as_os_str().to_string_lossy().to_lowercase()))
            {
                continue;
            }
            let name = path.file_name().map(|value| value.to_string_lossy().to_lowercase()).unwrap_or_default();
            if terms.iter().all(|term| name.contains(term)) {
                if let Some(record) = path_record(path) {
                    results.push(record);
                }
            }
        }
    }
    results
}

fn effective_roots(config: &Value, options: &Value) -> Result<Vec<PathBuf>, String> {
    if let Some(scope) = options.get("scopeRoot").and_then(Value::as_str) {
        let path = PathBuf::from(scope);
        if !is_allowed_path(&path, config) {
            return Err("선택한 검색 범위가 허용된 검색 경로 밖에 있습니다.".to_string());
        }
        if !path.is_dir() {
            return Err("선택한 검색 범위 폴더에 연결할 수 없습니다.".to_string());
        }
        return Ok(vec![path]);
    }
    Ok(config_roots(config))
}

fn query_with_scope(query: &str, options: &Value) -> String {
    let Some(scope) = options.get("scopeRoot").and_then(Value::as_str) else {
        return query.to_string();
    };
    if query.trim().is_empty() {
        return format!("path:\"{}\"", scope.replace('"', "\\\""));
    }
    format!("({}) path:\"{}\"", query, scope.replace('"', "\\\""))
}

#[tauri::command]
async fn search(app: AppHandle, state: State<'_, AppState>, query: String, options: Option<Value>) -> Result<Value, String> {
    let started = std::time::Instant::now();
    let options = options.unwrap_or_else(|| json!({}));
    let limit = options
        .get("limit")
        .and_then(Value::as_u64)
        .unwrap_or(200)
        .clamp(1, 5000) as usize;
    let config = state.config.lock().map_err(|_| "설정 잠금에 실패했습니다.")?.clone();
    let metadata = metadata_value(&state);
    let roots = effective_roots(&config, &options)?;
    let use_natural_language = options.get("useAI").and_then(Value::as_bool).unwrap_or(false);
    let normalized_query = if use_natural_language { translate_natural_query(&query) } else { query.clone() };
    let native_query = query_with_scope(&translate_native_query(&normalized_query), &options);
    let native_can_handle_query = !normalized_query.to_ascii_lowercase().split_whitespace().any(|token| {
        token.starts_with("content:") || token.starts_with("tag:") || token == "starred:" || token == "star:" || token.starts_with("dupe:")
    });
    if native_can_handle_query {
        if let Some(native) = search_everything(&app, &native_query, limit) {
        if let Ok(payload) = native {
            let items = payload
                .get("items")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(native_record)
                        .filter(|item| {
                            let in_configured_root = item
                                .get("fullPath")
                                .and_then(Value::as_str)
                                .map(|path| is_allowed_path(Path::new(path), &config))
                                .unwrap_or(false);
                            in_configured_root && query_matches(item, &normalized_query, false)
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let total = if options.get("scopeRoot").is_some() {
                json!(items.len())
            } else {
                payload.get("total").cloned().unwrap_or_else(|| json!(items.len()))
            };
            if items.is_empty() && (!query.trim().is_empty() || options.get("scopeRoot").is_some()) {
                let (local_results, local_total, indexed, indexing) = search_local_index(&state, &config, &normalized_query, &options, &metadata, limit)?;
                if local_total > 0 || indexed > 0 {
                    return Ok(json!({
                        "results": local_results,
                        "totalMatches": local_total,
                        "totalIndexed": indexed,
                        "elapsedMs": started.elapsed().as_millis(),
                        "backend": if indexing { "local-indexing" } else { "local-index" },
                        "indexing": indexing,
                        "warning": if indexing { "첫 색인이 진행 중이라 현재까지 발견된 파일만 표시합니다." } else { "Everything IPC 결과가 없어 내장 로컬 색인을 사용했습니다." }
                    }));
                }
            }
            let mut items = items;
            hydrate_records(&mut items, &metadata);
            let total_indexed = total.clone();
            return Ok(json!({
                "results": items,
                "totalMatches": total,
                "totalIndexed": total_indexed,
                "elapsedMs": started.elapsed().as_millis(),
                "backend": "everything-ipc"
            }));
        }
    }
    }
    if cfg!(target_os = "macos") {
        let results = search_spotlight(&normalized_query, &roots, limit)?;
        let mut results = results;
        hydrate_records(&mut results, &metadata);
        let total_matches = results.len();
        return Ok(json!({
            "results": results,
            "totalMatches": total_matches,
            "totalIndexed": 0,
            "elapsedMs": started.elapsed().as_millis(),
            "backend": "spotlight"
        }));
    }

    let (results, total_matches, total_indexed, indexing) = search_local_index(&state, &config, &normalized_query, &options, &metadata, limit)?;
    Ok(json!({
        "results": results,
        "totalMatches": total_matches,
        "totalIndexed": total_indexed,
        "elapsedMs": started.elapsed().as_millis(),
        "backend": if indexing { "local-indexing" } else { "local-index" },
        "indexing": indexing,
        "warning": if indexing { Value::String("첫 색인이 진행 중이라 현재까지 발견된 파일만 표시합니다.".to_string()) } else { Value::Null }
    }))
}

#[tauri::command]
fn get_config(state: State<'_, AppState>) -> Result<Value, String> {
    state.config.lock().map(|config| config.clone()).map_err(|_| "설정 잠금에 실패했습니다.".to_string())
}

#[tauri::command]
fn save_config(state: State<'_, AppState>, config: Value) -> Result<Value, String> {
    let mut current = state.config.lock().map_err(|_| "설정 잠금에 실패했습니다.".to_string())?;
    if let (Some(current_map), Some(new_map)) = (current.as_object_mut(), config.as_object()) {
        for (key, value) in new_map {
            current_map.insert(key.clone(), value.clone());
        }
    }
    atomic_write(&state.data_dir.join("config.json"), &current)?;
    Ok(json!({ "success": true }))
}

#[tauri::command]
fn list_bookmarks(state: State<'_, AppState>) -> Result<Value, String> {
    let value = read_json(&storage_path(&state, "bookmarks.json"), json!({ "items": [] }));
    let mut items = value
        .get("items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    items.sort_by_key(|item| std::cmp::Reverse(item.get("lastUsedAt").and_then(Value::as_u64).unwrap_or(0)));
    Ok(Value::Array(items))
}

#[tauri::command]
fn add_bookmark(state: State<'_, AppState>, bookmark: Value) -> Result<Value, String> {
    let name = bookmark.get("name").and_then(Value::as_str).unwrap_or("").trim().chars().take(80).collect::<String>();
    let query = bookmark.get("query").and_then(Value::as_str).unwrap_or("").trim().chars().take(512).collect::<String>();
    let scope_root = bookmark.get("scopeRoot").and_then(Value::as_str).unwrap_or("").to_string();
    if name.is_empty() || (query.is_empty() && scope_root.is_empty()) {
        return Ok(json!({ "success": false, "error": "검색어나 검색 범위를 입력하세요." }));
    }
    if !scope_root.is_empty() {
        let config = state.config.lock().map_err(|_| "설정 잠금에 실패했습니다.".to_string())?;
        if !is_allowed_path(Path::new(&scope_root), &config) {
            return Ok(json!({ "success": false, "error": "허용된 검색 경로 안에서만 저장할 수 있습니다." }));
        }
    }
    let file = storage_path(&state, "bookmarks.json");
    let mut value = read_json(&file, json!({ "version": 1, "items": [] }));
    let items = value.as_object_mut().ok_or_else(|| "저장 검색 데이터가 올바르지 않습니다.".to_string())?
        .entry("items".to_string()).or_insert_with(|| json!([]));
    let items = items.as_array_mut().ok_or_else(|| "저장 검색 목록이 올바르지 않습니다.".to_string())?;
    let now = now_millis();
    let existing = items.iter_mut().find(|item| {
        item.get("query").and_then(Value::as_str).unwrap_or("") == query
            && item.get("scopeRoot").and_then(Value::as_str).unwrap_or("") == scope_root
    });
    let item = if let Some(existing) = existing {
        let object = existing.as_object_mut().ok_or_else(|| "저장 검색 항목이 올바르지 않습니다.".to_string())?;
        object.insert("name".to_string(), json!(name));
        object.insert("lastUsedAt".to_string(), json!(now));
        existing.clone()
    } else {
        let item = json!({
            "id": format!("{}-{}", now, std::process::id()),
            "name": name,
            "query": query,
            "scopeRoot": scope_root,
            "sortBy": bookmark.get("sortBy").and_then(Value::as_str).unwrap_or("name"),
            "sortOrder": bookmark.get("sortOrder").and_then(Value::as_str).unwrap_or("asc"),
            "createdAt": now,
            "lastUsedAt": now
        });
        items.insert(0, item.clone());
        if items.len() > 100 { items.truncate(100); }
        item
    };
    atomic_write(&file, &value)?;
    Ok(json!({ "success": true, "bookmark": item }))
}

#[tauri::command]
fn touch_bookmark(state: State<'_, AppState>, id: String) -> Result<Value, String> {
    let file = storage_path(&state, "bookmarks.json");
    let mut value = read_json(&file, json!({ "version": 1, "items": [] }));
    let items = value.get_mut("items").and_then(Value::as_array_mut).ok_or_else(|| "저장 검색 목록이 올바르지 않습니다.".to_string())?;
    let mut found = false;
    for item in items {
        if item.get("id").and_then(Value::as_str) == Some(id.as_str()) {
            item.as_object_mut().map(|object| { object.insert("lastUsedAt".to_string(), json!(now_millis())); });
            found = true;
            break;
        }
    }
    if found { atomic_write(&file, &value)?; }
    Ok(json!({ "success": found }))
}

#[tauri::command]
fn remove_bookmark(state: State<'_, AppState>, id: String) -> Result<Value, String> {
    let file = storage_path(&state, "bookmarks.json");
    let mut value = read_json(&file, json!({ "version": 1, "items": [] }));
    let items = value.get_mut("items").and_then(Value::as_array_mut).ok_or_else(|| "저장 검색 목록이 올바르지 않습니다.".to_string())?;
    let before = items.len();
    items.retain(|item| item.get("id").and_then(Value::as_str) != Some(id.as_str()));
    let removed = items.len() != before;
    if removed { atomic_write(&file, &value)?; }
    Ok(json!({ "success": removed }))
}

#[tauri::command]
fn list_search_history(state: State<'_, AppState>) -> Result<Value, String> {
    let value = read_json(&storage_path(&state, "search-history.json"), json!({ "items": [] }));
    let mut items = value.get("items").and_then(Value::as_array).cloned().unwrap_or_default();
    items.sort_by_key(|item| std::cmp::Reverse(item.get("lastUsedAt").and_then(Value::as_u64).unwrap_or(0)));
    Ok(Value::Array(items))
}

#[tauri::command]
fn add_search_history(state: State<'_, AppState>, query: String) -> Result<Value, String> {
    let query = query.trim().chars().take(512).collect::<String>();
    if query.is_empty() { return Ok(json!({ "success": false })); }
    let file = storage_path(&state, "search-history.json");
    let mut value = read_json(&file, json!({ "version": 1, "items": [] }));
    let items = value.get_mut("items").and_then(Value::as_array_mut).ok_or_else(|| "검색 기록이 올바르지 않습니다.".to_string())?;
    let now = now_millis();
    if let Some(item) = items.iter_mut().find(|item| item.get("query").and_then(Value::as_str) == Some(query.as_str())) {
        if let Some(object) = item.as_object_mut() {
            object.insert("lastUsedAt".to_string(), json!(now));
            let count = object.get("count").and_then(Value::as_u64).unwrap_or(1) + 1;
            object.insert("count".to_string(), json!(count));
        }
    } else {
        items.push(json!({ "query": query, "lastUsedAt": now, "count": 1 }));
    }
    items.sort_by_key(|item| std::cmp::Reverse(item.get("lastUsedAt").and_then(Value::as_u64).unwrap_or(0)));
    if items.len() > 40 { items.truncate(40); }
    atomic_write(&file, &value)?;
    Ok(json!({ "success": true }))
}

#[tauri::command]
fn clear_search_history(state: State<'_, AppState>) -> Result<Value, String> {
    atomic_write(&storage_path(&state, "search-history.json"), &json!({ "version": 1, "items": [] }))?;
    Ok(json!({ "success": true }))
}

#[tauri::command]
fn add_tag(state: State<'_, AppState>, file_path: String, tag: String) -> Result<Value, String> {
    let path = PathBuf::from(&file_path);
    let config = state.config.lock().map_err(|_| "설정 잠금에 실패했습니다.")?;
    if !is_allowed_path(&path, &config) { return Ok(json!({ "success": false, "error": "허용된 검색 경로가 아닙니다." })); }
    drop(config);
    let clean_tag = tag.trim().trim_start_matches('#').chars().take(40).collect::<String>();
    if clean_tag.is_empty() { return Ok(json!({ "success": false, "error": "태그를 입력하세요." })); }
    let mut metadata = metadata_value(&state);
    let tags = metadata.get_mut("tags").and_then(Value::as_object_mut).ok_or_else(|| "태그 데이터가 올바르지 않습니다.".to_string())?;
    let list = tags.entry(file_path).or_insert_with(|| json!([]));
    let list = list.as_array_mut().ok_or_else(|| "태그 목록이 올바르지 않습니다.".to_string())?;
    if !list.iter().any(|item| item.as_str() == Some(clean_tag.as_str())) { list.push(json!(clean_tag)); }
    let output = list.clone();
    save_metadata(&state, &metadata)?;
    Ok(json!({ "success": true, "tags": output }))
}

#[tauri::command]
fn remove_tag(state: State<'_, AppState>, file_path: String, tag: String) -> Result<Value, String> {
    let mut metadata = metadata_value(&state);
    let tags = metadata.get_mut("tags").and_then(Value::as_object_mut).ok_or_else(|| "태그 데이터가 올바르지 않습니다.".to_string())?;
    let clean_tag = tag.trim().trim_start_matches('#');
    let output = {
        let list = tags.entry(file_path.clone()).or_insert_with(|| json!([]));
        if let Some(items) = list.as_array_mut() { items.retain(|item| item.as_str() != Some(clean_tag)); }
        list.as_array().cloned().unwrap_or_default()
    };
    if output.is_empty() { tags.remove(&file_path); }
    save_metadata(&state, &metadata)?;
    Ok(json!({ "success": true, "tags": output }))
}

#[tauri::command]
fn toggle_star(state: State<'_, AppState>, file_path: String) -> Result<Value, String> {
    let mut metadata = metadata_value(&state);
    let starred = metadata.get_mut("starred").and_then(Value::as_object_mut).ok_or_else(|| "별표 데이터가 올바르지 않습니다.".to_string())?;
    let next = !starred.get(&file_path).and_then(Value::as_bool).unwrap_or(false);
    if next { starred.insert(file_path, json!(true)); } else { starred.remove(&file_path); }
    save_metadata(&state, &metadata)?;
    Ok(json!({ "success": true, "starred": next }))
}

#[tauri::command]
fn get_all_tags(state: State<'_, AppState>) -> Result<Value, String> {
    let metadata = metadata_value(&state);
    let mut values = std::collections::BTreeSet::new();
    if let Some(tags) = metadata.get("tags").and_then(Value::as_object) {
        for list in tags.values().filter_map(Value::as_array) {
            for tag in list.iter().filter_map(Value::as_str) { values.insert(tag.to_string()); }
        }
    }
    Ok(Value::Array(values.into_iter().map(Value::String).collect()))
}

#[tauri::command]
fn get_file_content(file_path: String, state: State<'_, AppState>) -> Result<Value, String> {
    let path = PathBuf::from(&file_path);
    let config = state.config.lock().map_err(|_| "설정 잠금에 실패했습니다.")?;
    if !is_allowed_path(&path, &config) { return Ok(json!({ "success": false, "error": "허용된 검색 경로가 아닙니다." })); }
    let metadata = fs::metadata(&path).map_err(|error| error.to_string())?;
    if metadata.is_dir() { return Ok(json!({ "success": false, "error": "폴더는 미리보기할 수 없습니다." })); }
    let limit = 2 * 1024 * 1024;
    let truncated = metadata.len() > limit as u64;
    let mut bytes = Vec::with_capacity(metadata.len().min(limit as u64) as usize);
    fs::File::open(&path)
        .map_err(|error| error.to_string())?
        .take(limit as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    let content = String::from_utf8_lossy(&bytes).into_owned();
    Ok(json!({ "success": true, "size": metadata.len(), "mtime": metadata.modified().ok().and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok()).map(|value| value.as_millis()).unwrap_or(0), "content": content, "truncated": truncated }))
}

#[tauri::command]
fn get_file_url(file_path: String, state: State<'_, AppState>) -> Result<Value, String> {
    let path = PathBuf::from(&file_path);
    let config = state.config.lock().map_err(|_| "설정 잠금에 실패했습니다.")?;
    if !is_allowed_path(&path, &config) || !path.is_file() { return Ok(json!({ "success": false, "error": "허용된 검색 경로의 파일만 미리볼 수 있습니다." })); }
    Ok(json!({ "success": true, "url": path.to_string_lossy() }))
}

#[tauri::command]
fn delete_file(file_path: String, state: State<'_, AppState>) -> Result<Value, String> {
    let path = PathBuf::from(&file_path);
    let config = state.config.lock().map_err(|_| "설정 잠금에 실패했습니다.")?;
    if !is_allowed_path(&path, &config) { return Ok(json!({ "success": false, "error": "허용된 검색 경로의 파일만 삭제할 수 있습니다." })); }
    trash::delete(&path).map_err(|error| error.to_string())?;
    Ok(json!({ "success": true }))
}

#[tauri::command]
fn rename_file(old_path: String, new_path: String, state: State<'_, AppState>) -> Result<Value, String> {
    let old = PathBuf::from(&old_path);
    let new = PathBuf::from(&new_path);
    let config = state.config.lock().map_err(|_| "설정 잠금에 실패했습니다.")?;
    if !is_allowed_path(&old, &config) || !is_allowed_path(&new, &config) { return Ok(json!({ "success": false, "error": "허용된 검색 경로 안에서만 이름을 바꿀 수 있습니다." })); }
    if normalize_path(old.parent().unwrap_or_else(|| Path::new("."))) != normalize_path(new.parent().unwrap_or_else(|| Path::new("."))) {
        return Ok(json!({ "success": false, "error": "다른 폴더로 이동하는 이름 변경은 지원하지 않습니다." }));
    }
    fs::rename(old, new).map_err(|error| error.to_string())?;
    Ok(json!({ "success": true }))
}

#[tauri::command]
fn get_conversion_options(file_paths: Vec<String>, state: State<'_, AppState>) -> Result<Value, String> {
    let paths = file_paths.into_iter().map(PathBuf::from).collect::<Vec<_>>();
    let config = state.config.lock().map_err(|_| "설정 잠금에 실패했습니다.")?;
    if paths.iter().any(|path| !is_allowed_path(path, &config)) { return Ok(json!({ "success": false, "error": "허용된 검색 경로의 파일만 변환할 수 있습니다." })); }
    if paths.iter().any(|path| path.is_dir()) { return Ok(json!({ "success": false, "error": "폴더 자체는 변환할 수 없습니다." })); }
    let options = conversion_options(&paths);
    let notice = if options.as_array().map(|items| items.is_empty()).unwrap_or(true) { "이 환경에서 사용할 수 있는 변환 도구가 없습니다. LibreOffice, Poppler 또는 ImageMagick을 설치해 주세요." } else { "" };
    Ok(json!({ "success": true, "options": options, "notice": notice }))
}

fn encrypted_pdf(path: &Path) -> bool {
    fs::read(path).map(|bytes| bytes.windows(8).any(|window| window == b"/Encrypt")).unwrap_or(false)
}

#[tauri::command]
fn convert_files(file_paths: Vec<String>, operation: String, destination_dir: Option<String>, state: State<'_, AppState>) -> Result<Value, String> {
    let paths = file_paths.into_iter().map(PathBuf::from).collect::<Vec<_>>();
    if paths.is_empty() { return Ok(json!({ "success": false, "error": "변환할 파일을 선택하세요." })); }
    let config = state.config.lock().map_err(|_| "설정 잠금에 실패했습니다.")?;
    if paths.iter().any(|path| !is_allowed_path(path, &config)) { return Ok(json!({ "success": false, "error": "허용된 검색 경로의 파일만 변환할 수 있습니다." })); }
    let destination = destination_dir.map(PathBuf::from).unwrap_or_else(|| paths[0].parent().unwrap_or_else(|| Path::new(".")).to_path_buf());
    if !is_allowed_path(&destination, &config) || !destination.is_dir() { return Ok(json!({ "success": false, "error": "변환 대상 폴더가 허용된 검색 경로가 아닙니다." })); }
    if paths.iter().any(|path| path.extension().map(|value| value.to_string_lossy().eq_ignore_ascii_case("pdf")).unwrap_or(false) && encrypted_pdf(path)) {
        return Ok(json!({ "success": false, "error": "암호화되었거나 비밀번호가 필요한 PDF는 변환할 수 없습니다." }));
    }
    let mut outputs = Vec::new();
    match operation.as_str() {
        "images-to-pdf" => {
            for path in &paths {
                let output = destination.join(format!("{}.pdf", path.file_stem().unwrap_or_default().to_string_lossy()));
                let status = if cfg!(target_os = "macos") {
                    Command::new("sips").args(["-s", "format", "pdf"]).arg(path).arg("--out").arg(&output).status()
                } else {
                    Command::new("magick").arg(path).arg(&output).status()
                }.map_err(|error| error.to_string())?;
                if !status.success() { return Ok(json!({ "success": false, "error": "이미지를 PDF로 변환하지 못했습니다." })); }
                outputs.push(output.to_string_lossy().into_owned());
            }
        }
        "office-to-pdf" => {
            for path in &paths {
                let status = Command::new("soffice").args(["--headless", "--convert-to", "pdf", "--outdir"]).arg(&destination).arg(path).status().map_err(|error| error.to_string())?;
                if !status.success() { return Ok(json!({ "success": false, "error": "Office 문서를 PDF로 변환하지 못했습니다. 암호화 문서인지 확인하세요." })); }
                outputs.push(destination.join(format!("{}.pdf", path.file_stem().unwrap_or_default().to_string_lossy())).to_string_lossy().into_owned());
            }
        }
        "merge-pdf" => {
            let output = destination.join(format!("dawith-merged-{}.pdf", now_millis()));
            let mut command = Command::new("pdfunite");
            for path in &paths { command.arg(path); }
            let status = command.arg(&output).status().map_err(|error| error.to_string())?;
            if !status.success() { return Ok(json!({ "success": false, "error": "PDF를 병합하지 못했습니다." })); }
            outputs.push(output.to_string_lossy().into_owned());
        }
        _ => return Ok(json!({ "success": false, "error": "현재 Tauri 경량 버전에서 지원하지 않는 변환입니다." })),
    }
    Ok(json!({ "success": true, "outputs": outputs }))
}

#[tauri::command]
fn choose_root() -> Value {
    match FileDialog::new().set_title("검색할 폴더 선택").pick_folder() {
        Some(path) => json!({ "canceled": false, "path": path }),
        None => json!({ "canceled": true, "path": null }),
    }
}

#[tauri::command]
fn inspect_root(root_path: String) -> Value {
    let path = PathBuf::from(&root_path);
    match fs::metadata(&path) {
        Ok(metadata) if metadata.is_dir() => json!({ "success": true, "path": root_path, "reachable": true }),
        Ok(_) => json!({ "success": false, "path": root_path, "error": "선택한 경로가 폴더가 아닙니다." }),
        Err(error) => json!({ "success": false, "path": root_path, "error": format!("폴더에 연결할 수 없습니다. ({})", error) }),
    }
}

#[tauri::command]
fn get_backend_status(app: AppHandle) -> Value {
    if cfg!(windows) {
        if let Some((_helper, true)) = everything_ipc_ready(&app) {
            return json!({ "backend": "everything-ipc", "label": "Everything IPC 연결됨", "available": true, "detail": "실행 중인 Everything DB에 공식 SDK IPC로 연결했습니다." });
        }
        if let Ok(index) = app.state::<AppState>().local_index.lock() {
            if index.indexing {
                return json!({ "backend": "local-indexing", "label": "내장 로컬 색인 중", "available": true, "detail": format!("{}개 파일을 읽는 중입니다. Desktop을 포함한 로컬 전체를 순서대로 색인합니다.", index.total_files) });
            }
            if index.ready {
                return json!({ "backend": "local-index", "label": "내장 로컬 색인 준비됨", "available": true, "detail": format!("{}개 파일을 읽었습니다. Everything 없이도 즉시 검색합니다.", index.total_files) });
            }
        }
        return json!({
            "backend": "local-native",
            "label": "내장 로컬 색인 준비 중",
            "available": true,
            "detail": "Everything이 실행 중이 아니어서 내장 로컬 색인을 준비합니다."
        });
    }
    if cfg!(target_os = "macos") {
        return json!({ "backend": "spotlight", "label": "Spotlight 연동", "available": true, "detail": "macOS 시스템 색인을 사용합니다." });
    }
    json!({ "backend": "local-native", "label": "내장 로컬 검색", "available": true, "detail": "Rust fallback 검색을 사용합니다." })
}

#[tauri::command]
fn get_file_stats(file_path: String, state: State<'_, AppState>) -> Option<Value> {
    let path = PathBuf::from(&file_path);
    let config = state.config.lock().ok()?;
    if !is_allowed_path(&path, &config) {
        return None;
    }
    path_record(&path)
}

fn run_open(path: &Path) -> Result<(), String> {
    let path_text = path.to_string_lossy().into_owned();
    let result = if cfg!(target_os = "macos") {
        Command::new("open").arg(path).status()
    } else if cfg!(windows) {
        Command::new("cmd").args(["/C", "start", "", &path_text]).status()
    } else {
        Command::new("xdg-open").arg(path).status()
    };
    result.map_err(|error| error.to_string()).and_then(|status| {
        status.success().then_some(()).ok_or_else(|| "파일을 열지 못했습니다.".to_string())
    })
}

#[tauri::command]
fn open_file(file_path: String, state: State<'_, AppState>) -> Result<Value, String> {
    let path = PathBuf::from(&file_path);
    let config = state.config.lock().map_err(|_| "설정 잠금에 실패했습니다.")?;
    if !is_allowed_path(&path, &config) || !path.is_file() {
        return Err("허용된 검색 경로의 파일만 열 수 있습니다.".to_string());
    }
    run_open(&path)?;
    Ok(json!({ "success": true }))
}

#[tauri::command]
fn open_folder(file_path: String, state: State<'_, AppState>) -> Result<Value, String> {
    let path = PathBuf::from(&file_path);
    let config = state.config.lock().map_err(|_| "설정 잠금에 실패했습니다.")?;
    if !is_allowed_path(&path, &config) {
        return Err("허용된 검색 경로의 폴더만 열 수 있습니다.".to_string());
    }
    let folder = if path.is_dir() { path } else { path.parent().unwrap_or(Path::new(".")).to_path_buf() };
    run_open(&folder)?;
    Ok(json!({ "success": true }))
}

#[tauri::command]
fn copy_path(file_path: String) -> Result<Value, String> {
    let mut child = if cfg!(target_os = "macos") {
        Command::new("pbcopy").stdin(Stdio::piped()).spawn().map_err(|error| error.to_string())?
    } else if cfg!(windows) {
        Command::new("powershell.exe").args(["-NoProfile", "-NonInteractive", "-Command", "Set-Clipboard"]).stdin(Stdio::piped()).spawn().map_err(|error| error.to_string())?
    } else {
        return Ok(json!({ "success": false, "error": "이 운영체제에서는 클립보드 연동을 지원하지 않습니다." }));
    };
    if let Some(stdin) = child.stdin.as_mut() {
        stdin.write_all(file_path.as_bytes()).map_err(|error| error.to_string())?;
    }
    child.wait().map_err(|error| error.to_string())?;
    Ok(json!({ "success": true }))
}

#[tauri::command]
fn reindex(app: AppHandle) -> Result<Value, String> {
    let started = start_local_indexing(&app)?;
    Ok(json!({ "success": true, "started": started }))
}

#[tauri::command]
fn window_minimize(window: Window) -> Result<(), String> {
    window.minimize().map_err(|error| error.to_string())
}

#[tauri::command]
fn window_maximize(window: Window) -> Result<Value, String> {
    if window.is_maximized().map_err(|error| error.to_string())? {
        window.unmaximize().map_err(|error| error.to_string())?;
    } else {
        window.maximize().map_err(|error| error.to_string())?;
    }
    Ok(json!({ "success": true, "maximized": window.is_maximized().unwrap_or(false) }))
}

#[tauri::command]
fn window_close(window: Window) -> Result<(), String> {
    window.close().map_err(|error| error.to_string())
}

#[tauri::command]
fn open_guide() -> Value {
    let _ = run_open(Path::new("https://www.voidtools.com/ko-kr/"));
    json!({ "success": true })
}

#[tauri::command]
fn stub_success() -> Value {
    json!({ "success": false, "supported": false, "error": "이 기능은 경량 Tauri 핵심 버전에서 준비 중입니다." })
}

fn main() {
    let data_dir = data_dir();
    let config = read_config(&data_dir);
    tauri::Builder::default()
        .manage(AppState { config: Mutex::new(config), data_dir, local_index: Mutex::new(LocalIndex::default()) })
        .setup(|app| {
            start_local_indexing(&app.handle()).map_err(std::io::Error::other)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            search,
            get_config,
            save_config,
            list_bookmarks,
            add_bookmark,
            touch_bookmark,
            remove_bookmark,
            list_search_history,
            add_search_history,
            clear_search_history,
            add_tag,
            remove_tag,
            toggle_star,
            get_all_tags,
            choose_root,
            inspect_root,
            get_backend_status,
            get_file_stats,
            get_file_content,
            get_file_url,
            open_file,
            open_folder,
            copy_path,
            delete_file,
            rename_file,
            get_conversion_options,
            convert_files,
            reindex,
            window_minimize,
            window_maximize,
            window_close,
            open_guide,
            stub_success
        ])
        .run(tauri::generate_context!())
        .expect("error while running Dawith Search Tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn root_scope_allows_children() {
        let config = json!({ "roots": ["/"] });
        assert!(is_allowed_path(Path::new("/Users/dawith/Desktop/report.pdf"), &config));
    }

    #[test]
    fn scope_boundary_does_not_match_sibling() {
        let config = json!({ "roots": ["/Users/dawith"] });
        assert!(is_allowed_path(Path::new("/Users/dawith/Desktop/report.pdf"), &config));
        assert!(!is_allowed_path(Path::new("/Users/dawith-other/report.pdf"), &config));
    }

    #[test]
    fn category_and_natural_queries_match_local_records() {
        let record = json!({
            "name": "2026 사례관리 보고서.pdf",
            "fullPath": "C:/Users/dawith/Desktop/2026 사례관리 보고서.pdf",
            "ext": "pdf",
            "size": 2 * 1024 * 1024,
            "mtime": now_millis(),
            "isDir": false
        });
        assert!(query_matches(&record, "doc:", false));
        assert!(!query_matches(&record, "pic:", false));
        assert!(query_matches(&record, "사례관리 문서", true));
    }

    #[test]
    fn native_category_query_expands_to_extensions() {
        let query = translate_native_query("doc: 계약서");
        assert!(query.contains("ext:doc;docx"));
        assert!(query.contains("계약서"));
    }
}

