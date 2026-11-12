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

mod convert;
mod fastindex;

struct AppState {
    config: Mutex<Value>,
    data_dir: PathBuf,
    local_index: Mutex<LocalIndex>,
}

#[derive(Default)]
struct LocalIndex {
    index: fastindex::FastIndex,
    indexing: bool,
    ready: bool,
    total_files: usize,
    total_folders: usize,
}

// The release build uses the Windows GUI subsystem, so every console child
// (everything-ipc, goz, powershell, cmd) would otherwise open its own window.
fn hidden_command<S: AsRef<std::ffi::OsStr>>(program: S) -> Command {
    #[allow(unused_mut)]
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
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
    // DAWITH_DATA_DIR runs the app with a separate config and index (demo
    // recordings, portable use) without touching the user's own.
    if let Some(dir) = std::env::var_os("DAWITH_DATA_DIR").filter(|dir| !dir.is_empty()) {
        return PathBuf::from(dir);
    }
    home_dir().join(".dawith-search")
}

fn default_local_roots() -> Vec<String> {
    if cfg!(windows) {
        let mut roots = Vec::new();
        if let Ok(output) = hidden_command("powershell.exe")
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
        "useEverything": false,
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
        apply_local_roots(&mut config, default_local_roots());
    }
    config
}

fn same_root(a: &str, b: &str) -> bool {
    if cfg!(windows) { a.eq_ignore_ascii_case(b) } else { a == b }
}

// Adds the detected local drives to the search roots, except the ones the
// user removed in settings (excludedLocalRoots), which stay out.
fn apply_local_roots(config: &mut Value, detected: Vec<String>) {
    let excluded: Vec<String> = config
        .get("excludedLocalRoots")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default();
    let is_excluded = |root: &str| excluded.iter().any(|item| same_root(item, root));
    let local_roots: Vec<String> = detected.into_iter().filter(|root| !is_excluded(root)).collect();
    let Some(object) = config.as_object_mut() else { return };
    let mut roots: Vec<Value> = object
        .get("roots")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|value| value.as_str().map_or(true, |root| !is_excluded(root)))
        .collect();
    for root in &local_roots {
        if !roots.iter().any(|value| value.as_str().is_some_and(|item| same_root(item, root))) {
            roots.push(Value::String(root.clone()));
        }
    }
    object.insert("roots".to_string(), Value::Array(roots));
    object.insert(
        "localRoots".to_string(),
        Value::Array(local_roots.into_iter().map(Value::String).collect()),
    );
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

fn use_everything(config: &Value) -> bool {
    // Dawith Search runs on its own index. Everything is used only when the
    // user explicitly turns it on in the config.
    config.get("useEverything").and_then(Value::as_bool).unwrap_or(false)
}

fn index_cache_path(state: &AppState) -> PathBuf {
    state.data_dir.join("index-v2.bin")
}

fn emit_index_progress(app: &AppHandle, index: &fastindex::FastIndex, root: &Path, root_index: usize, total_roots: usize, started_at: u64) {
    let folders = index.entries.iter().filter(|entry| entry.is_dir).count();
    let _ = app.emit(
        "index-status",
        json!({
            "status": "indexing-progress",
            "stats": {
                "totalFiles": index.entries.len() - folders,
                "totalFolders": folders,
                "root": root.to_string_lossy(),
                "rootIndex": root_index,
                "totalRoots": total_roots,
                "elapsedMs": now_millis().saturating_sub(started_at)
            }
        }),
    );
}

type DirBatch = (PathBuf, usize, Vec<(String, u64, u64, bool)>);

/// Reads one directory and recurses into its subfolders on all cores. On
/// Windows the size and modified time come from the directory listing, so
/// there is no extra system call per file.
fn walk_dir_parallel(dir: &Path, depth: usize, max_depth: usize, root_index: usize, excluded: &[String], skip_hidden: bool, sender: &std::sync::mpsc::Sender<DirBatch>) {
    use rayon::prelude::*;
    let Ok(read) = fs::read_dir(dir) else { return };
    let mut children = Vec::new();
    let mut subdirs = Vec::new();
    for entry in read.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if skip_hidden && name.starts_with('.') { continue; }
        if excluded.iter().any(|item| item.eq_ignore_ascii_case(&name)) { continue; }
        let Ok(meta) = entry.metadata() else { continue };
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            const HIDDEN: u32 = 0x2;
            const SYSTEM: u32 = 0x4;
            if skip_hidden && meta.file_attributes() & (HIDDEN | SYSTEM) != 0 { continue; }
        }
        let is_dir = meta.is_dir();
        let mtime = meta.modified().ok().and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok()).map(|value| value.as_millis() as u64).unwrap_or(0);
        if is_dir && !meta.file_type().is_symlink() && depth < max_depth {
            subdirs.push(entry.path());
        }
        children.push((name, if is_dir { 0 } else { meta.len() }, mtime, is_dir));
    }
    let _ = sender.send((dir.to_path_buf(), root_index, children));
    subdirs.par_iter().for_each(|sub| walk_dir_parallel(sub, depth + 1, max_depth, root_index, excluded, skip_hidden, sender));
}

fn start_local_indexing(app: &AppHandle) -> Result<bool, String> {
    let state = app.state::<AppState>();
    let config = state.config.lock().map_err(|_| "설정 잠금에 실패했습니다.")?.clone();
    if use_everything(&config) && cfg!(windows) && everything_ipc_ready(app).map(|(_, ready)| ready).unwrap_or(false) {
        // Start the resident helper now so the first search does not pay
        // for launching it.
        if let Some(helper) = helper_path(app) {
            std::thread::spawn(move || { let _ = resident_query(&helper, "", 1, true); });
        }
    }
    let cache_path = index_cache_path(&state);
    let live_build;
    {
        let mut index = state.local_index.lock().map_err(|_| "로컬 색인 잠금에 실패했습니다.")?;
        if index.indexing {
            return Ok(false);
        }
        index.indexing = true;
        // The saved index from the last run makes search available right
        // away; a fresh scan replaces it in the background when it finishes.
        if index.index.entries.is_empty() {
            if let Ok(cached) = fastindex::FastIndex::load(&cache_path) {
                index.total_folders = cached.entries.iter().filter(|entry| entry.is_dir).count();
                index.total_files = cached.entries.len() - index.total_folders;
                index.index = cached;
            }
        }
        index.ready = !index.index.entries.is_empty();
        // With nothing saved yet, results are shown as the first scan finds them.
        live_build = !index.ready;
    }
    let started_at = now_millis();
    let _ = app.emit("index-status", json!({ "status": "indexing", "stats": { "totalFiles": 0, "totalFolders": 0 } }));

    let worker_app = app.clone();
    std::thread::spawn(move || {
        let mut roots: Vec<PathBuf> = Vec::new();
        for root in config_roots(&config).into_iter().filter(|root| root.exists()) {
            // Skip a root that sits inside one already listed.
            if roots.iter().any(|known| is_path_within(&root, known)) { continue; }
            roots.retain(|known| !is_path_within(known, &root));
            roots.push(root);
        }
        let excluded = excluded_names(&config);
        let skip_hidden = config.get("excludeHidden").and_then(Value::as_bool).unwrap_or(true);
        let max_depth = config.get("maxDepth").and_then(Value::as_u64).unwrap_or(64).clamp(1, 256) as usize;
        let total_roots = roots.len();

        let (sender, receiver) = std::sync::mpsc::channel::<DirBatch>();
        let walk_roots = roots.clone();
        let watch_excluded = excluded.clone();
        if !live_build {
            // A saved index is already being searched; keep it current while
            // the background rescan runs.
            start_index_watcher(worker_app.clone(), roots.clone(), watch_excluded.clone(), skip_hidden);
        }
        let walker = std::thread::spawn(move || {
            // The walk blocks on disk and network I/O, so it gets its own
            // threads; searches keep the global pool to themselves and stay
            // fast while indexing runs.
            let pool = rayon::ThreadPoolBuilder::new()
                .num_threads(6)
                .thread_name(|n| format!("dawith-index-{n}"))
                .build();
            let walk = || {
                for (root_index, root) in walk_roots.iter().enumerate() {
                    walk_dir_parallel(root, 1, max_depth, root_index, &excluded, skip_hidden, &sender);
                }
            };
            match pool {
                Ok(pool) => pool.install(walk),
                Err(_) => walk(),
            }
        });

        let mut built = fastindex::FastIndex::default();
        let mut published_dirs = 0usize;
        let mut published_entries = 0usize;
        let mut current_root = 0usize;
        let mut last_report = std::time::Instant::now();
        let mut publish = |built: &fastindex::FastIndex, current_root: usize| {
            if live_build {
                if let Ok(mut index) = worker_app.state::<AppState>().local_index.lock() {
                    index.index.dirs.extend(built.dirs[published_dirs..].iter().cloned());
                    index.index.entries.extend(built.entries[published_entries..].iter().cloned());
                    index.ready = !index.index.entries.is_empty();
                }
                published_dirs = built.dirs.len();
                published_entries = built.entries.len();
            }
            if let Some(root) = roots.get(current_root) {
                emit_index_progress(&worker_app, built, root, current_root, total_roots, started_at);
            }
        };
        loop {
            match receiver.recv_timeout(std::time::Duration::from_millis(500)) {
                Ok((dir, root_index, children)) => {
                    // On the first build, save each finished location right away
                    // so closing the app mid-scan does not lose the work.
                    if live_build && root_index > current_root {
                        let _ = built.save(&cache_path);
                    }
                    current_root = root_index;
                    let dir_id = built.add_dir(&dir.to_string_lossy());
                    for (name, size, mtime, is_dir) in children {
                        built.push(dir_id, &name, size, mtime, is_dir);
                    }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            }
            if last_report.elapsed() >= std::time::Duration::from_secs(1) {
                last_report = std::time::Instant::now();
                publish(&built, current_root);
            }
        }
        let _ = walker.join();
        publish(&built, current_root);

        let total_folders = built.entries.iter().filter(|entry| entry.is_dir).count();
        let total_files = built.entries.len() - total_folders;
        let state = worker_app.state::<AppState>();
        let _ = built.save(&index_cache_path(&state));
        if let Ok(mut index) = state.local_index.lock() {
            index.index = built;
            index.ready = true;
            index.indexing = false;
            index.total_files = total_files;
            index.total_folders = total_folders;
        }
        let _ = worker_app.emit(
            "index-status",
            json!({
                "status": "idle",
                "stats": { "totalFiles": total_files, "totalFolders": total_folders, "elapsedMs": now_millis().saturating_sub(started_at) }
            }),
        );
        start_index_watcher(worker_app.clone(), roots, watch_excluded, skip_hidden);
    });
    Ok(true)
}

static INDEX_WATCHER: Mutex<Option<notify::RecommendedWatcher>> = Mutex::new(None);

/// Keeps the index current like Everything does: the OS reports created,
/// deleted and renamed files, and the index is updated in place. Changes are
/// applied in small batches and the window is told to refresh its results.
fn start_index_watcher(app: AppHandle, roots: Vec<PathBuf>, excluded: Vec<String>, skip_hidden: bool) {
    use notify::Watcher;
    let Ok(mut slot) = INDEX_WATCHER.lock() else { return };
    if slot.is_some() {
        return;
    }
    let (sender, receiver) = std::sync::mpsc::channel::<notify::Result<notify::Event>>();
    let Ok(mut watcher) = notify::recommended_watcher(move |event| { let _ = sender.send(event); }) else { return };
    for root in &roots {
        let _ = watcher.watch(root, notify::RecursiveMode::Recursive);
    }
    *slot = Some(watcher);
    drop(slot);

    std::thread::spawn(move || {
        let skip = |path: &Path| {
            path.components().any(|part| {
                let name = part.as_os_str().to_string_lossy();
                (skip_hidden && name.starts_with('.')) || excluded.iter().any(|item| item.eq_ignore_ascii_case(&name))
            })
        };
        let mut last_notice = std::time::Instant::now() - std::time::Duration::from_secs(10);
        let mut pending_notice = false;
        loop {
            // Wait for the first change, then gather whatever follows within 300 ms.
            let first = match receiver.recv_timeout(std::time::Duration::from_secs(2)) {
                Ok(event) => Some(event),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => None,
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            };
            let mut paths: Vec<PathBuf> = Vec::new();
            if let Some(event) = first {
                let deadline = std::time::Instant::now() + std::time::Duration::from_millis(300);
                let mut push = |event: notify::Result<notify::Event>| {
                    if let Ok(event) = event { paths.extend(event.paths); }
                };
                push(event);
                while let Some(wait) = deadline.checked_duration_since(std::time::Instant::now()) {
                    match receiver.recv_timeout(wait) {
                        Ok(event) => push(event),
                        Err(_) => break,
                    }
                }
            }
            paths.sort();
            paths.dedup();
            paths.retain(|path| !skip(path));
            if !paths.is_empty() {
                if let Ok(mut index) = app.state::<AppState>().local_index.lock() {
                    for path in &paths {
                        let (Some(parent), Some(name)) = (path.parent(), path.file_name()) else { continue };
                        let folder = parent.to_string_lossy();
                        let name = name.to_string_lossy();
                        match fs::symlink_metadata(path) {
                            Ok(meta) => {
                                let mtime = meta.modified().ok().and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok()).map(|value| value.as_millis() as u64).unwrap_or(0);
                                index.index.upsert(&folder, &name, if meta.is_dir() { 0 } else { meta.len() }, mtime, meta.is_dir());
                            }
                            Err(_) => index.index.remove(&folder, &name),
                        }
                    }
                }
                pending_notice = true;
            }
            // Tell the window at most every 1.5 s so busy folders don't flood it.
            if pending_notice && last_notice.elapsed() >= std::time::Duration::from_millis(1500) {
                let _ = app.emit("index-status", json!({ "status": "updated" }));
                last_notice = std::time::Instant::now();
                pending_notice = false;
            }
        }
    });
}

fn local_roots(config: &Value) -> Vec<PathBuf> {
    config
        .get("localRoots")
        .and_then(Value::as_array)
        .map(|roots| roots.iter().filter_map(Value::as_str).map(PathBuf::from).collect())
        .unwrap_or_default()
}

// Builds a result row from a native backend item. Metadata the backend already
// returned is used as is; when it was not requested (--path-only), only paths
// on local disks are stat'ed so network shares never add per-result round trips.
fn native_record(item: &Value, local_roots: &[PathBuf]) -> Option<Value> {
    let full_path = item
        .get("path")
        .or_else(|| item.get("filename"))?
        .as_str()?;
    let path = PathBuf::from(full_path);
    let metadata_missing = item.get("size").map_or(true, Value::is_null);
    if metadata_missing {
        let is_local = !full_path.starts_with("\\\\") && local_roots.iter().any(|root| is_path_within(&path, root));
        if is_local {
            if let Some(record) = path_record(&path) {
                return Some(record);
            }
        }
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
        "starred": false,
        "metaUnknown": metadata_missing
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
        let output = hidden_command("mdfind")
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

// Older installers bundled `../bin/native/**` under `_up_/bin/native`, so
// check both the mapped `bin/native` layout and that legacy location.
fn bundled_native_path(resource_dir: &Path, name: &str) -> Option<PathBuf> {
    let arch = if cfg!(target_arch = "aarch64") { "arm64" } else { "x64" };
    [resource_dir.to_path_buf(), resource_dir.join("_up_")]
        .into_iter()
        .map(|base| base.join("bin").join("native").join("windows").join(arch).join(name))
        .find(|path| path.exists())
}

fn helper_path(app: &AppHandle) -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("DAWITH_EVERYTHING_IPC_PATH") {
        let path = PathBuf::from(path);
        if path.exists() {
            return Some(path);
        }
    }
    let resource_dir = app.path().resource_dir().ok()?;
    bundled_native_path(&resource_dir, "everything-ipc.exe")
}

fn native_binary_path(app: &AppHandle, name: &str) -> Option<PathBuf> {
    if !cfg!(windows) {
        return None;
    }
    if let Some(path) = std::env::var_os(match name {
        "goz.exe" => "DAWITH_GOZ_PATH",
        "gozd.exe" => "DAWITH_GOZD_PATH",
        _ => "DAWITH_NATIVE_PATH",
    }) {
        let path = PathBuf::from(path);
        if path.exists() {
            return Some(path);
        }
    }
    let resource_dir = app.path().resource_dir().ok()?;
    bundled_native_path(&resource_dir, name)
}

fn goz_path(app: &AppHandle) -> Option<PathBuf> {
    native_binary_path(app, "goz.exe")
}

fn gozd_path(app: &AppHandle) -> Option<PathBuf> {
    native_binary_path(app, "gozd.exe")
}

fn goz_ready(app: &AppHandle) -> Option<(PathBuf, bool)> {
    let client = goz_path(app)?;
    let ready = hidden_command(&client)
        .arg("--server-version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false);
    Some((client, ready))
}

// Size/date filters need Everything to return metadata; everything else asks
// for paths only, which stays fast for network folder indexes.
fn query_needs_native_metadata(query: &str) -> bool {
    query.split_whitespace().any(|token| {
        let lower = token.trim_start_matches(['!', '-', '(']).to_ascii_lowercase();
        ["size:", "dm:", "dc:", "da:", "datemodified:", "datecreated:", "dateaccessed:"].iter().any(|prefix| lower.starts_with(prefix))
    })
}

// One everything-ipc process kept alive for the whole session. Launching a
// helper per search cost 0.4-2.5 s on PCs whose security software inspects
// every new process; a resident helper answers in ~0.2 s.
struct ResidentHelper {
    child: std::process::Child,
    stdin: std::process::ChildStdin,
    stdout: std::io::BufReader<std::process::ChildStdout>,
}

static RESIDENT_HELPER: Mutex<Option<ResidentHelper>> = Mutex::new(None);

fn start_resident_helper(helper: &Path) -> Result<ResidentHelper, String> {
    let mut child = hidden_command(helper)
        .arg("--serve")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| error.to_string())?;
    let stdin = child.stdin.take().ok_or("helper stdin unavailable")?;
    let stdout = std::io::BufReader::new(child.stdout.take().ok_or("helper stdout unavailable")?);
    Ok(ResidentHelper { child, stdin, stdout })
}

fn resident_query(helper: &Path, query: &str, limit: usize, path_only: bool) -> Result<Value, String> {
    use std::io::BufRead;
    // The protocol is one line per request, so tabs and newlines in the
    // query itself become spaces.
    let clean = query.replace(['\t', '\r', '\n'], " ");
    let request = format!("{limit}\t{}\t{clean}\n", if path_only { 1 } else { 0 });
    let mut slot = RESIDENT_HELPER.lock().map_err(|_| "helper lock poisoned")?;
    for attempt in 0..2 {
        let alive = slot.as_mut().map(|helper| matches!(helper.child.try_wait(), Ok(None))).unwrap_or(false);
        if !alive {
            *slot = Some(start_resident_helper(helper)?);
        }
        let resident = slot.as_mut().expect("helper just started");
        let mut line = String::new();
        let answered = resident.stdin.write_all(request.as_bytes()).and_then(|_| resident.stdin.flush()).is_ok()
            && resident.stdout.read_line(&mut line).map(|read| read > 0).unwrap_or(false);
        if answered {
            let value = serde_json::from_str::<Value>(line.trim()).map_err(|error| error.to_string())?;
            if let Some(error) = value.get("error").and_then(Value::as_str) {
                return Err(format!("Everything IPC: {error}"));
            }
            return Ok(value);
        }
        if let Some(mut dead) = slot.take() {
            let _ = dead.child.kill();
        }
        if attempt == 1 {
            break;
        }
    }
    Err("Everything helper did not answer".to_string())
}

fn search_everything(app: &AppHandle, query: &str, limit: usize) -> Option<Result<Value, String>> {
    if !cfg!(windows) {
        return None;
    }
    let helper = helper_path(app)?;
    let path_only = !query_needs_native_metadata(query);
    if let Ok(value) = resident_query(&helper, query, limit, path_only) {
        return Some(Ok(value));
    }
    // Fall back to a one-shot helper (e.g. an older helper without --serve).
    let mut command = hidden_command(helper);
    command.arg("--json");
    if !query_needs_native_metadata(query) {
        command.arg("--path-only");
    }
    let output = command
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

fn search_goz(app: &AppHandle, query: &str, limit: usize) -> Option<Result<Value, String>> {
    let client = goz_path(app)?;
    let output = hidden_command(client)
        .arg("-argv")
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

fn merge_records(primary: Vec<Value>, supplemental: Vec<Value>, limit: usize) -> (Vec<Value>, usize) {
    let mut seen = HashSet::new();
    let mut merged = Vec::new();
    let mut supplemental_added = 0usize;
    for (is_supplemental, item) in primary
        .into_iter()
        .map(|item| (false, item))
        .chain(supplemental.into_iter().map(|item| (true, item)))
    {
        let key = item
            .get("fullPath")
            .and_then(Value::as_str)
            .map(|path| normalize_path(Path::new(path)))
            .unwrap_or_default();
        if key.is_empty() || !seen.insert(key) {
            continue;
        }
        if is_supplemental {
            supplemental_added += 1;
        }
        if merged.len() < limit {
            merged.push(item);
        }
    }
    (merged, supplemental_added)
}

fn everything_ipc_ready(app: &AppHandle) -> Option<(PathBuf, bool)> {
    let helper = helper_path(app)?;
    let ready = hidden_command(&helper)
        .arg("--status")
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false);
    Some((helper, ready))
}

fn command_available(command: &str) -> bool {
    hidden_command(command)
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

fn extract_hwp_text(path: &Path) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    if bytes.starts_with(&[0x9b, 0x20, 0x44, 0x52, 0x4d, 0x4f, 0x4e, 0x45]) {
        return Err("이 HWP는 DRM 보안 문서라 앱에서 본문을 직접 읽을 수 없습니다. 파일명(제목)으로는 계속 검색됩니다. 본문까지 검색하려면 한글에서 문서를 연 뒤 보안 해제본으로 저장하거나, 권한이 있는 위치에서 다시 추가해 주세요.".to_string());
    }
    let document = hwp::HwpDocument::from_bytes(&bytes).map_err(|error| error.to_string())?;
    Ok(document.extract_text().to_string())
}

fn content_terms(query: &str) -> Vec<String> {
    query
        .split_whitespace()
        .filter_map(|token| token.to_ascii_lowercase().strip_prefix("content:").map(str::to_string))
        .map(|term| term.trim_matches(['"', '\'']).to_string())
        .filter(|term| !term.is_empty())
        .collect()
}

fn is_plain_text_extension(extension: &str) -> bool {
    matches!(extension, "txt" | "md" | "markdown" | "json" | "js" | "jsx" | "ts" | "tsx" | "html" | "css" | "scss" | "py" | "c" | "cpp" | "h" | "hpp" | "java" | "cs" | "go" | "rs" | "php" | "rb" | "swift" | "xml" | "yaml" | "yml" | "ini" | "cfg" | "conf" | "csv" | "tsv" | "sql" | "sh" | "bat" | "cmd" | "ps1" | "log" | "env" | "properties" | "toml")
}

fn record_matches_content(record: &Value, query: &str) -> bool {
    let terms = content_terms(query);
    if terms.is_empty() {
        return true;
    }
    if record.get("isDir").and_then(Value::as_bool).unwrap_or(false) {
        return false;
    }
    let path = Path::new(record.get("fullPath").and_then(Value::as_str).unwrap_or(""));
    let extension = file_extension(path);
    let content = if extension == "hwp" {
        extract_hwp_text(path).ok()
    } else if is_plain_text_extension(&extension) {
        fs::metadata(path)
            .ok()
            .filter(|metadata| metadata.len() <= 5 * 1024 * 1024)
            .and_then(|_| fs::read_to_string(path).ok())
    } else {
        None
    };
    let Some(content) = content else { return false; };
    let content = content.to_ascii_lowercase();
    terms.iter().all(|term| content.contains(term))
}

fn conversion_options(paths: &[PathBuf]) -> Value {
    if paths.is_empty() {
        return json!([]);
    }
    let extensions = paths.iter().map(|path| file_extension(path)).collect::<Vec<_>>();
    let mut options = Vec::new();
    let all_images = extensions.iter().all(|extension| convert::RASTER_IMAGE_EXTENSIONS.contains(&extension.as_str()));
    if all_images {
        options.push(json!({
            "id": "images-to-pdf",
            "label": if paths.len() > 1 { "이미지를 PDF 하나로 묶기" } else { "PDF로 변환" },
            "detail": "원본은 유지하고 같은 폴더에 새 파일을 만듭니다."
        }));
        if paths.len() == 1 {
            if extensions[0] != "png" {
                options.push(json!({ "id": "image-to-png", "label": "PNG로 변환", "detail": "원본은 유지하고 같은 폴더에 PNG를 만듭니다." }));
            }
            if extensions[0] != "jpg" && extensions[0] != "jpeg" {
                options.push(json!({ "id": "image-to-jpg", "label": "JPG로 변환", "detail": "투명한 부분은 흰색으로 채웁니다." }));
            }
        }
    }
    if extensions.iter().all(|extension| extension == "pdf") {
        if paths.len() > 1 {
            options.push(json!({ "id": "merge-pdf", "label": "PDF 하나로 합치기", "detail": format!("{}개 PDF를 선택 순서대로 합칩니다.", paths.len()) }));
        } else {
            options.push(json!({ "id": "split-pdf", "label": "PDF 페이지별로 나누기", "detail": "페이지마다 별도 PDF를 만듭니다." }));
        }
    }
    if paths.len() == 1 && convert::WINDOWS_OFFICE_EXTENSIONS.contains(&extensions[0].as_str()) {
        if cfg!(windows) {
            options.push(json!({ "id": "office-to-pdf", "label": "PDF로 변환", "detail": "설치된 Word·Excel·PowerPoint·한글을 사용합니다. 암호·보안 문서는 제외됩니다." }));
        } else if command_available("soffice") {
            options.push(json!({ "id": "office-to-pdf", "label": "PDF로 변환", "detail": "설치된 LibreOffice를 사용합니다. 암호화 문서는 변환하지 않습니다." }));
        }
    }
    Value::Array(options)
}

fn entry_record(index: &fastindex::FastIndex, entry: &fastindex::Entry) -> Value {
    let ext = if entry.is_dir {
        String::new()
    } else {
        Path::new(entry.name.as_ref()).extension().map(|value| value.to_string_lossy().to_ascii_lowercase()).unwrap_or_default()
    };
    json!({
        "name": entry.name.as_ref(),
        "path": index.dir_of(entry),
        "fullPath": index.full_path(entry),
        "size": entry.size,
        "mtime": entry.mtime,
        "ctime": entry.mtime,
        "isDir": entry.is_dir,
        "ext": ext,
        "tags": [],
        "starred": false
    })
}

/// Splits a query into plain name words plus the filters the index can
/// apply directly (extension, file/folder). Returns None when the query
/// needs the full matcher (size:, dm:, path:, OR, NOT, wildcards, tags, ...).
fn fast_query(query: &str) -> Option<(Vec<String>, Vec<String>, Option<bool>)> {
    let mut terms = Vec::new();
    let mut extensions = Vec::new();
    let mut want_dir = None;
    for token in query.split_whitespace() {
        let clean = token.trim_matches(|c| c == '"' || c == '\'' || c == '(' || c == ')');
        if clean.is_empty() { continue; }
        let lower = clean.to_lowercase();
        if let Some(category) = lower.strip_suffix(':') {
            match category {
                "folder" | "directory" => { want_dir = Some(true); continue; }
                "file" => { want_dir = Some(false); continue; }
                _ => {
                    let list = category_extensions(category);
                    if list.is_empty() { return None; }
                    extensions.extend(list.iter().map(|value| (*value).to_string()));
                    want_dir = Some(false);
                    continue;
                }
            }
        }
        if let Some(value) = lower.strip_prefix("ext:") {
            extensions.extend(value.split([',', ';']).filter(|item| !item.is_empty()).map(|item| item.trim_start_matches('.').to_string()));
            want_dir = Some(false);
            continue;
        }
        if lower.contains([':', '|', '*', '?']) || lower.starts_with(['!', '-']) { return None; }
        terms.push(lower);
    }
    Some((terms, extensions, want_dir))
}

fn search_local_index(
    state: &AppState,
    config: &Value,
    query: &str,
    options: &Value,
    metadata: &Value,
    limit: usize,
) -> Result<(Vec<Value>, usize, usize, bool), String> {
    use rayon::prelude::*;
    let _ = config;
    let scope = options.get("scopeRoot").and_then(Value::as_str).map(PathBuf::from);
    let use_natural_language = options.get("useAI").and_then(Value::as_bool).unwrap_or(false);
    let guard = state.local_index.lock().map_err(|_| "로컬 색인 잠금에 실패했습니다.")?;
    let index = &guard.index;
    let total_indexed = index.entries.len();
    // Folder scope is checked per folder (tens of thousands) instead of per file.
    let dir_in_scope: Option<Vec<bool>> = scope.as_ref().map(|root| index.dirs.par_iter().map(|dir| is_path_within(Path::new(dir.as_ref()), root)).collect());
    let in_scope = |entry: &fastindex::Entry| dir_in_scope.as_ref().map(|dirs| dirs.get(entry.dir as usize).copied().unwrap_or(false)).unwrap_or(true);

    let lower_query = query.to_lowercase();
    let duplicate_by_size = lower_query.contains("dupe:size");
    let duplicate_by_name = !duplicate_by_size && lower_query.contains("dupe:");

    let (results, total_matches) = if let (false, Some((terms, extensions, want_dir))) = (duplicate_by_size || duplicate_by_name || lower_query.contains("content:"), fast_query(query)) {
        // Fast path: plain words plus extension/type filters, entirely on the index.
        // The window says whether the last word is still being typed (IME composing).
        let composing = options.get("composing").and_then(Value::as_bool).unwrap_or(false);
        // Column the user clicked in the result header (default: relevance).
        let sort = fastindex::SortKey::from_option(options.get("sortBy").and_then(Value::as_str));
        let descending = options.get("sortOrder").and_then(Value::as_str) == Some("desc");
        let (hits, total) = index.search_sorted(&terms, composing, sort, descending, limit, |_, entry| {
            if let Some(dir) = want_dir { if entry.is_dir != dir { return false; } }
            if !extensions.is_empty() {
                let Some(dot) = entry.lower.rfind('.') else { return false };
                if !extensions.iter().any(|ext| entry.lower[dot + 1..] == *ext) { return false; }
            }
            in_scope(entry)
        });
        (hits.iter().map(|position| entry_record(index, &index.entries[*position as usize])).collect::<Vec<_>>(), total)
    } else {
        // Full matcher for operators: narrow by any plain words first, then
        // check each candidate in parallel.
        let positive = query
            .split_whitespace()
            .map(|token| token.trim_matches(|c| c == '"' || c == '\'' || c == '(' || c == ')').to_lowercase())
            .filter(|token| !token.is_empty() && !token.contains([':', '|', '*', '?']) && !token.starts_with(['!', '-']))
            .collect::<Vec<_>>();
        let duplicate_counts: HashMap<String, usize> = if duplicate_by_size || duplicate_by_name {
            let mut counts = HashMap::new();
            for entry in index.entries.iter().filter(|entry| !entry.is_dir) {
                let key = if duplicate_by_size { entry.size.to_string() } else { entry.lower.to_string() };
                if key != "0" { *counts.entry(key).or_insert(0) += 1; }
            }
            counts
        } else {
            HashMap::new()
        };
        let needs_metadata = lower_query.contains("tag:") || lower_query.contains("starred:") || lower_query.contains("star:");
        let mut matched: Vec<(u32, Value)> = index
            .entries
            .par_iter()
            .enumerate()
            .filter(|(_, entry)| positive.iter().all(|term| entry.lower.contains(term.as_str())) && in_scope(entry))
            .filter(|(_, entry)| {
                if !(duplicate_by_size || duplicate_by_name) { return true; }
                if entry.is_dir { return false; }
                let key = if duplicate_by_size { entry.size.to_string() } else { entry.lower.to_string() };
                duplicate_counts.get(&key).copied().unwrap_or(0) >= 2
            })
            .filter_map(|(position, entry)| {
                let mut record = entry_record(index, entry);
                if needs_metadata { hydrate_records(std::slice::from_mut(&mut record), metadata); }
                (query_matches(&record, query, use_natural_language) && record_matches_content(&record, query)).then_some((position as u32, record))
            })
            .collect();
        let total = matched.len();
        let sort = fastindex::SortKey::from_option(options.get("sortBy").and_then(Value::as_str));
        let descending = options.get("sortOrder").and_then(Value::as_str) == Some("desc");
        matched.sort_by(|a, b| {
            let (ea, eb) = (&index.entries[a.0 as usize], &index.entries[b.0 as usize]);
            let ordering = match sort {
                fastindex::SortKey::Size => ea.size.cmp(&eb.size),
                fastindex::SortKey::Modified => ea.mtime.cmp(&eb.mtime),
                fastindex::SortKey::Path => index.dir_of(ea).cmp(index.dir_of(eb)),
                fastindex::SortKey::Extension => fastindex::entry_extension(ea).cmp(fastindex::entry_extension(eb)),
                _ => std::cmp::Ordering::Equal,
            }
            .then_with(|| ea.lower.cmp(&eb.lower));
            if descending && sort != fastindex::SortKey::Relevance { ordering.reverse() } else { ordering }
        });
        (matched.into_iter().take(limit).map(|(_, record)| record).collect::<Vec<_>>(), total)
    };
    let mut results = results;
    hydrate_records(&mut results, metadata);
    Ok((results, total_matches, total_indexed, guard.indexing))
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
    if native_can_handle_query && use_everything(&config) {
        // Search the supplemental local index on another thread while the
        // native engine answers; running them one after the other added the
        // local scan time to every keystroke.
        let local_search = {
            let (app, config, query, options, metadata) = (app.clone(), config.clone(), normalized_query.clone(), options.clone(), metadata.clone());
            std::thread::spawn(move || {
                let state = app.state::<AppState>();
                search_local_index(&state, &config, &query, &options, &metadata, limit)
            })
        };
        let mut native_backend = "everything-ipc";
        let mut payload = search_everything(&app, &native_query, limit).and_then(Result::ok);
        if payload.is_none() && goz_ready(&app).map(|(_, ready)| ready).unwrap_or(false) {
            native_backend = "goz";
            payload = search_goz(&app, &native_query, limit).and_then(Result::ok);
        }
        if let Some(payload) = payload {
            let local_roots = local_roots(&config);
            let items = payload
                .get("items")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|item| native_record(item, &local_roots))
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
            let (local_results, _local_total, local_indexed, indexing) = local_search
                .join()
                .map_err(|_| "로컬 색인 검색에 실패했습니다.".to_string())??;
            let (mut items, local_added) = merge_records(items, local_results, limit);
            let native_total = payload.get("total").and_then(Value::as_u64).unwrap_or(items.len() as u64);
            let total = if options.get("scopeRoot").is_some() {
                json!(items.len())
            } else {
                json!(native_total + local_added as u64)
            };
            hydrate_records(&mut items, &metadata);
            let total_indexed = json!(native_total.max(local_indexed as u64));
            return Ok(json!({
                "results": items,
                "totalMatches": total,
                "totalIndexed": total_indexed,
                "elapsedMs": started.elapsed().as_millis(),
                "backend": native_backend,
                "indexing": indexing,
                "warning": if local_added > 0 {
                    Value::String("내장 보완 색인 결과를 함께 표시했습니다.".to_string())
                } else {
                    Value::Null
                }
            }));
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
        "backend": "dawith-index",
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
    let extension = file_extension(&path);
    if extension == "hwp" {
        return Ok(match extract_hwp_text(&path) {
            Ok(content) => json!({ "success": true, "size": metadata.len(), "mtime": metadata.modified().ok().and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok()).map(|value| value.as_millis()).unwrap_or(0), "content": content, "truncated": false }),
            Err(error) => json!({ "success": false, "error": error }),
        });
    }
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
fn get_file_url(file_path: String, state: State<'_, AppState>, app: AppHandle) -> Result<Value, String> {
    let path = PathBuf::from(&file_path);
    let config = state.config.lock().map_err(|_| "설정 잠금에 실패했습니다.")?;
    if !is_allowed_path(&path, &config) || !path.is_file() { return Ok(json!({ "success": false, "error": "허용된 검색 경로의 파일만 미리볼 수 있습니다." })); }
    // The asset protocol scope starts empty; open it only for the file being
    // previewed, after the search-location check above.
    app.asset_protocol_scope().allow_file(&path).map_err(|error| error.to_string())?;
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
    let notice = if options.as_array().map(|items| items.is_empty()).unwrap_or(true) { "이 형식은 변환할 수 없습니다. PNG·JPG·BMP·GIF·WEBP·TIFF 이미지, PDF, Word·Excel·PowerPoint·한글 문서를 선택하세요." } else { "" };
    Ok(json!({ "success": true, "options": options, "notice": notice }))
}

fn encrypted_pdf(path: &Path) -> bool {
    fs::read(path).map(|bytes| bytes.windows(8).any(|window| window == b"/Encrypt")).unwrap_or(false)
}

#[tauri::command]
async fn convert_files(file_paths: Vec<String>, operation: String, destination_dir: Option<String>, state: State<'_, AppState>) -> Result<Value, String> {
    let paths = file_paths.into_iter().map(PathBuf::from).collect::<Vec<_>>();
    if paths.is_empty() { return Ok(json!({ "success": false, "error": "변환할 파일을 선택하세요." })); }
    let config = state.config.lock().map_err(|_| "설정 잠금에 실패했습니다.")?.clone();
    if paths.iter().any(|path| !is_allowed_path(path, &config)) { return Ok(json!({ "success": false, "error": "허용된 검색 경로의 파일만 변환할 수 있습니다." })); }
    let destination = destination_dir.map(PathBuf::from).unwrap_or_else(|| paths[0].parent().unwrap_or_else(|| Path::new(".")).to_path_buf());
    if !is_allowed_path(&destination, &config) || !destination.is_dir() { return Ok(json!({ "success": false, "error": "변환 대상 폴더가 허용된 검색 경로가 아닙니다." })); }
    if paths.iter().any(|path| path.extension().map(|value| value.to_string_lossy().eq_ignore_ascii_case("pdf")).unwrap_or(false) && encrypted_pdf(path)) {
        return Ok(json!({ "success": false, "error": "암호화되었거나 비밀번호가 필요한 PDF는 변환할 수 없습니다." }));
    }
    // Office exports can take a while; keep them off the UI thread.
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<PathBuf>, String> {
        match operation.as_str() {
            "images-to-pdf" => convert::images_to_pdf(&paths, &destination),
            "image-to-png" => convert::convert_image(&paths[0], "png", &destination),
            "image-to-jpg" => convert::convert_image(&paths[0], "jpg", &destination),
            "merge-pdf" => convert::merge_pdfs(&paths, &destination),
            "split-pdf" => convert::split_pdf(&paths[0], &destination),
            "office-to-pdf" if cfg!(windows) => convert::office_to_pdf(&paths[0], &destination, |program| hidden_command(program)),
            "office-to-pdf" => {
                let status = hidden_command("soffice").args(["--headless", "--convert-to", "pdf", "--outdir"]).arg(&destination).arg(&paths[0]).status().map_err(|error| error.to_string())?;
                if !status.success() { return Err("Office 문서를 PDF로 변환하지 못했습니다. 암호화 문서인지 확인하세요.".to_string()); }
                Ok(vec![destination.join(format!("{}.pdf", paths[0].file_stem().unwrap_or_default().to_string_lossy()))])
            }
            _ => Err("지원하지 않는 변환입니다.".to_string()),
        }
    })
    .await
    .map_err(|error| error.to_string())?;
    Ok(match result {
        Ok(outputs) => json!({ "success": true, "outputs": outputs.iter().map(|path| path.to_string_lossy().into_owned()).collect::<Vec<_>>() }),
        Err(error) => json!({ "success": false, "error": error }),
    })
}

// Storage overview and duplicate finder work on the in-memory index, so they
// never rescan the disk; only duplicate candidates of equal size are read.
const STORAGE_CATEGORIES: [(&str, &str, &str); 6] = [
    ("documents", "문서", "doc"),
    ("pictures", "이미지/사진", "pic"),
    ("videos", "동영상", "video"),
    ("audio", "오디오", "audio"),
    ("compressed", "압축 파일", "zip"),
    ("executables", "실행 파일", "exe"),
];

fn storage_category(extension: &str) -> usize {
    STORAGE_CATEGORIES
        .iter()
        .position(|(_, _, category)| category_extensions(category).contains(&extension))
        .unwrap_or(STORAGE_CATEGORIES.len())
}

fn storage_analysis(state: &AppState) -> Result<Value, String> {
    let guard = state.local_index.lock().map_err(|_| "로컬 색인 잠금에 실패했습니다.")?;
    let index = &guard.index;
    let mut counts = [0u64; STORAGE_CATEGORIES.len() + 1];
    let mut bytes = [0u64; STORAGE_CATEGORIES.len() + 1];
    let (mut total_files, mut total_folders, mut total_bytes) = (0u64, 0u64, 0u64);
    let mut files: Vec<&fastindex::Entry> = Vec::new();
    for entry in index.entries.iter().filter(|entry| entry.alive) {
        if entry.is_dir {
            total_folders += 1;
            continue;
        }
        total_files += 1;
        total_bytes += entry.size;
        let category = storage_category(fastindex::entry_extension(entry));
        counts[category] += 1;
        bytes[category] += entry.size;
        files.push(entry);
    }
    let top = 50.min(files.len());
    if top > 0 && files.len() > top {
        files.select_nth_unstable_by(top - 1, |a, b| b.size.cmp(&a.size));
    }
    files.truncate(top);
    files.sort_by(|a, b| b.size.cmp(&a.size));

    let mut categories = serde_json::Map::new();
    for (position, (key, label, _)) in STORAGE_CATEGORIES.iter().enumerate() {
        categories.insert(key.to_string(), json!({ "count": counts[position], "bytes": bytes[position], "label": label }));
    }
    let other = STORAGE_CATEGORIES.len();
    categories.insert("others".to_string(), json!({ "count": counts[other], "bytes": bytes[other], "label": "기타" }));
    Ok(json!({
        "success": true,
        "indexing": guard.indexing,
        "totalBytes": total_bytes,
        "totalFiles": total_files,
        "totalFolders": total_folders,
        "categories": categories,
        "topLargest": files.iter().map(|entry| entry_record(index, entry)).collect::<Vec<_>>()
    }))
}

#[tauri::command]
async fn get_storage_analysis(app: AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || storage_analysis(&app.state::<AppState>()))
        .await
        .map_err(|error| error.to_string())?
}

static DUPLICATE_SCAN_RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn hash_hex(digest: &[u8]) -> String {
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Hash of the first 64 KB: cheap first pass that rules out most look-alikes.
fn head_hash(path: &Path) -> Option<String> {
    use sha2::{Digest, Sha256};
    let mut buffer = vec![0u8; 64 * 1024];
    let mut file = fs::File::open(path).ok()?;
    let mut filled = 0;
    while filled < buffer.len() {
        match file.read(&mut buffer[filled..]) {
            Ok(0) => break,
            Ok(read) => filled += read,
            Err(_) => return None,
        }
    }
    Some(hash_hex(&Sha256::digest(&buffer[..filled])))
}

/// Content fingerprint: the whole file up to 16 MB, otherwise 1 MB from the
/// start, middle and end, so multi-GB videos don't have to be read in full.
fn content_hash(path: &Path, size: u64) -> Option<String> {
    use sha2::{Digest, Sha256};
    use std::io::{Seek, SeekFrom};
    const CHUNK: u64 = 1024 * 1024;
    let mut file = fs::File::open(path).ok()?;
    let mut hasher = Sha256::new();
    if size <= 16 * CHUNK {
        std::io::copy(&mut file, &mut hasher).ok()?;
    } else {
        let mut buffer = vec![0u8; CHUNK as usize];
        for offset in [0, size / 2 - CHUNK / 2, size - CHUNK] {
            file.seek(SeekFrom::Start(offset)).ok()?;
            file.read_exact(&mut buffer).ok()?;
            hasher.update(&buffer);
        }
    }
    Some(hash_hex(&hasher.finalize()))
}

fn duplicate_scan(state: &AppState, min_size: u64) -> Result<Value, String> {
    use rayon::prelude::*;
    const TIME_BUDGET: std::time::Duration = std::time::Duration::from_secs(20);
    const MAX_CANDIDATE_GROUPS: usize = 5000;
    const MAX_RESULT_GROUPS: usize = 200;
    let started = std::time::Instant::now();

    // Equal size is required for equal content. Collect those groups and let
    // go of the index before any disk access.
    let candidates: Vec<(u64, Vec<(PathBuf, Value)>)> = {
        let guard = state.local_index.lock().map_err(|_| "로컬 색인 잠금에 실패했습니다.")?;
        let index = &guard.index;
        let mut by_size: HashMap<u64, Vec<usize>> = HashMap::new();
        for (position, entry) in index.entries.iter().enumerate() {
            if entry.alive && !entry.is_dir && entry.size >= min_size {
                by_size.entry(entry.size).or_default().push(position);
            }
        }
        let mut groups: Vec<(u64, Vec<usize>)> = by_size.into_iter().filter(|(_, list)| list.len() >= 2).collect();
        // Biggest possible savings first, so a time-limited run finds what matters.
        groups.sort_by_key(|(size, list)| std::cmp::Reverse(size.saturating_mul(list.len() as u64 - 1)));
        groups.truncate(MAX_CANDIDATE_GROUPS);
        groups
            .into_iter()
            .map(|(size, list)| {
                let items = list
                    .into_iter()
                    .map(|position| {
                        let entry = &index.entries[position];
                        (PathBuf::from(index.full_path(entry)), entry_record(index, entry))
                    })
                    .collect();
                (size, items)
            })
            .collect()
    };
    let candidate_groups = candidates.len();

    // A small dedicated pool keeps searching responsive while files are read.
    let pool = rayon::ThreadPoolBuilder::new().num_threads(4).build().map_err(|error| error.to_string())?;
    let mut groups: Vec<Value> = Vec::new();
    let mut total_wasted = 0u64;
    let mut checked_groups = 0usize;
    for (size, items) in candidates {
        if started.elapsed() > TIME_BUDGET {
            break;
        }
        checked_groups += 1;
        let heads: Vec<Option<String>> = pool.install(|| items.par_iter().map(|(path, _)| head_hash(path)).collect());
        let mut by_head: HashMap<String, Vec<usize>> = HashMap::new();
        for (position, head) in heads.into_iter().enumerate() {
            if let Some(head) = head {
                by_head.entry(head).or_default().push(position);
            }
        }
        for same_head in by_head.into_values().filter(|list| list.len() >= 2) {
            let hashes: Vec<Option<String>> = pool.install(|| same_head.par_iter().map(|position| content_hash(&items[*position].0, size)).collect());
            let mut by_content: HashMap<String, Vec<usize>> = HashMap::new();
            for (position, hash) in same_head.iter().zip(hashes) {
                if let Some(hash) = hash {
                    by_content.entry(hash).or_default().push(*position);
                }
            }
            for (hash, list) in by_content.into_iter().filter(|(_, list)| list.len() >= 2) {
                let wasted = size * (list.len() as u64 - 1);
                total_wasted += wasted;
                groups.push(json!({
                    "hash": hash,
                    "size": size,
                    "wastedBytes": wasted,
                    "items": list.iter().map(|position| items[*position].1.clone()).collect::<Vec<_>>()
                }));
            }
        }
    }
    groups.sort_by_key(|group| std::cmp::Reverse(group["wastedBytes"].as_u64().unwrap_or(0)));
    let total_groups = groups.len();
    let total_duplicates: usize = groups.iter().map(|group| group["items"].as_array().map(Vec::len).unwrap_or(0)).sum();
    groups.truncate(MAX_RESULT_GROUPS);
    Ok(json!({
        "success": true,
        "groups": groups,
        "totalGroups": total_groups,
        "totalDuplicates": total_duplicates,
        "totalWastedBytes": total_wasted,
        "minSize": min_size,
        "checkedGroups": checked_groups,
        "candidateGroups": candidate_groups,
        "partial": checked_groups < candidate_groups,
        "elapsedMs": started.elapsed().as_millis() as u64
    }))
}

#[tauri::command]
async fn find_duplicates(app: AppHandle, options: Option<Value>) -> Result<Value, String> {
    use std::sync::atomic::Ordering;
    let min_size = options
        .as_ref()
        .and_then(|value| value.get("minSize"))
        .and_then(Value::as_u64)
        .unwrap_or(1024 * 1024)
        .max(1);
    if DUPLICATE_SCAN_RUNNING.swap(true, Ordering::SeqCst) {
        return Ok(json!({ "success": false, "error": "중복 파일을 이미 확인하고 있습니다. 잠시 후 다시 시도하세요." }));
    }
    let result = tauri::async_runtime::spawn_blocking(move || duplicate_scan(&app.state::<AppState>(), min_size)).await;
    DUPLICATE_SCAN_RUNNING.store(false, Ordering::SeqCst);
    result.map_err(|error| error.to_string())?
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
    let everything_enabled = app.state::<AppState>().config.lock().map(|config| use_everything(&config)).unwrap_or(false);
    if cfg!(windows) {
        if let Some((_helper, true)) = everything_enabled.then(|| everything_ipc_ready(&app)).flatten() {
            return json!({ "backend": "everything-ipc", "label": "Everything 연동", "available": true, "detail": "실행 중인 Everything DB에 공식 SDK IPC로 연결했습니다." });
        }
        if let Some((client, true)) = everything_enabled.then(|| goz_ready(&app)).flatten() {
            return json!({ "backend": "goz", "label": "goz NTFS 엔진 연결됨", "available": true, "detail": format!("{} · MIT 오픈소스 MFT/USN Journal 엔진", client.to_string_lossy()) });
        }
        if let Ok(index) = app.state::<AppState>().local_index.lock() {
            if index.indexing {
                return json!({ "backend": "dawith-index", "label": "Dawith 색인", "available": true, "detail": format!("파일 목록을 새로 읽는 중입니다. 지금까지 {}개를 찾았고, 그동안 저장된 목록으로 검색합니다.", index.total_files) });
            }
            if index.ready {
                return json!({ "backend": "dawith-index", "label": "Dawith 색인", "available": true, "detail": format!("{}개 파일을 Dawith 자체 색인으로 검색합니다.", index.total_files) });
            }
        }
        return json!({
            "backend": "local-native",
            "label": "Dawith 색인 준비 중",
            "available": true,
            "detail": "처음 한 번 파일 목록을 만들고 있습니다."
        });
    }
    if cfg!(target_os = "macos") {
        return json!({ "backend": "spotlight", "label": "Spotlight 연동", "available": true, "detail": "macOS 시스템 색인을 사용합니다." });
    }
    json!({ "backend": "local-native", "label": "내장 로컬 검색", "available": true, "detail": "Rust fallback 검색을 사용합니다." })
}

#[tauri::command]
fn install_goz_backend(app: AppHandle) -> Value {
    if !cfg!(windows) {
        return json!({ "success": false, "supported": false, "message": "Windows에서만 사용할 수 있습니다." });
    }
    let Some(daemon) = gozd_path(&app) else {
        return json!({ "success": false, "supported": true, "message": "gozd.exe가 패키지에 없습니다. Windows 패키지를 다시 설치하세요." });
    };
    let escaped = daemon.to_string_lossy().replace('\'', "''");
    let command = format!("Start-Process -FilePath '{}' -ArgumentList 'install' -Verb RunAs -Wait", escaped);
    match hidden_command("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"])
        .arg(&command)
        .output()
    {
        Ok(output) if output.status.success() => json!({ "success": true, "supported": true, "message": "goz Windows NTFS 엔진 설치 요청이 완료되었습니다. 잠시 후 상태를 다시 확인하세요." }),
        Ok(output) => json!({ "success": false, "supported": true, "message": String::from_utf8_lossy(&output.stderr).trim().to_string() }),
        Err(error) => json!({ "success": false, "supported": true, "message": error.to_string() }),
    }
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

/// Opens a file or folder with its default program the way Explorer does
/// (ShellExecuteW). Launching `cmd /C start` and waiting for it took 0.4-2.5 s
/// on PCs whose security software inspects every new process, and froze the
/// window while it waited.
#[cfg(windows)]
fn shell_open(path: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    let wide = |text: &std::ffi::OsStr| text.encode_wide().chain(Some(0)).collect::<Vec<u16>>();
    let verb = wide(std::ffi::OsStr::new("open"));
    let file = wide(path.as_os_str());
    let result = unsafe { ShellExecuteW(std::ptr::null_mut(), verb.as_ptr(), file.as_ptr(), std::ptr::null(), std::ptr::null(), SW_SHOWNORMAL) };
    // Values above 32 mean success.
    if result as isize > 32 { Ok(()) } else { Err(format!("파일을 열지 못했습니다 (오류 {})", result as isize)) }
}

fn run_open(path: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        return shell_open(path);
    }
    #[allow(unreachable_code)]
    let path_text = path.to_string_lossy().into_owned();
    let result = if cfg!(target_os = "macos") {
        hidden_command("open").arg(path).status()
    } else if cfg!(windows) {
        hidden_command("cmd").args(["/C", "start", "", &path_text]).status()
    } else {
        hidden_command("xdg-open").arg(path).status()
    };
    result.map_err(|error| error.to_string()).and_then(|status| {
        status.success().then_some(()).ok_or_else(|| "파일을 열지 못했습니다.".to_string())
    })
}

#[tauri::command]
async fn open_file(file_path: String, state: State<'_, AppState>) -> Result<Value, String> {
    let path = PathBuf::from(&file_path);
    let config = state.config.lock().map_err(|_| "설정 잠금에 실패했습니다.")?.clone();
    // Launching the document's program can take a moment; do it off the UI
    // thread so the window never freezes while Windows starts it.
    tauri::async_runtime::spawn_blocking(move || {
        if !is_allowed_path(&path, &config) {
            return Err("허용된 검색 경로의 파일만 열 수 있습니다.".to_string());
        }
        // Folders are results too (opened in Explorer/Finder), so only require
        // that the path still exists.
        if !path.exists() {
            return Err("파일이나 폴더를 찾을 수 없습니다. 이동되었거나 삭제되었을 수 있습니다.".to_string());
        }
        run_open(&path)?;
        Ok(json!({ "success": true }))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn open_folder(file_path: String, state: State<'_, AppState>) -> Result<Value, String> {
    let path = PathBuf::from(&file_path);
    let config = state.config.lock().map_err(|_| "설정 잠금에 실패했습니다.")?.clone();
    tauri::async_runtime::spawn_blocking(move || open_folder_blocking(path, config))
        .await
        .map_err(|error| error.to_string())?
}

fn open_folder_blocking(path: PathBuf, config: Value) -> Result<Value, String> {
    if !is_allowed_path(&path, &config) {
        return Err("허용된 검색 경로의 폴더만 열 수 있습니다.".to_string());
    }
    // On Windows, open Explorer with the file already selected; don't wait for it.
    if cfg!(windows) && !path.is_dir() {
        let mut argument = std::ffi::OsString::from("/select,");
        argument.push(path.as_os_str());
        Command::new("explorer.exe").arg(argument).spawn().map_err(|error| error.to_string())?;
        return Ok(json!({ "success": true }));
    }
    let folder = if path.is_dir() { path } else { path.parent().unwrap_or(Path::new(".")).to_path_buf() };
    run_open(&folder)?;
    Ok(json!({ "success": true }))
}

#[tauri::command]
fn copy_path(file_path: String) -> Result<Value, String> {
    let mut child = if cfg!(target_os = "macos") {
        hidden_command("pbcopy").stdin(Stdio::piped()).spawn().map_err(|error| error.to_string())?
    } else if cfg!(windows) {
        hidden_command("powershell.exe").args(["-NoProfile", "-NonInteractive", "-Command", "Set-Clipboard"]).stdin(Stdio::piped()).spawn().map_err(|error| error.to_string())?
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
    // Closing the window keeps Dawith running in the tray so indexing and
    // change tracking continue; "종료" in the tray menu really quits.
    window.hide().map_err(|error| error.to_string())
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
    let open = MenuItem::with_id(app, "open", "Dawith Search 열기", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "종료", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;
    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("Dawith Search · 색인을 계속합니다")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main_window(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

#[tauri::command]
fn open_guide() -> Value {
    let _ = run_open(Path::new("https://www.voidtools.com/ko-kr/"));
    json!({ "success": true })
}

const LATEST_RELEASE_API: &str = "https://api.github.com/repos/dawith-ai/dawith-search/releases/latest";

// DAWITH_UPDATE_CURRENT_VERSION and DAWITH_UPDATE_RELEASE_API let a test
// install pretend to be older or target a pre-release, so the full
// download → verify → install → relaunch path can be exercised before release.
fn current_app_version() -> String {
    std::env::var("DAWITH_UPDATE_CURRENT_VERSION").unwrap_or_else(|_| env!("CARGO_PKG_VERSION").to_string())
}

fn version_parts(version: &str) -> Vec<u64> {
    version
        .trim_start_matches(['v', 'V'])
        .split('.')
        .map(|part| part.chars().take_while(char::is_ascii_digit).collect::<String>().parse().unwrap_or(0))
        .collect()
}

fn is_newer_version(candidate: &str, current: &str) -> bool {
    let (mut a, mut b) = (version_parts(candidate), version_parts(current));
    let len = a.len().max(b.len());
    a.resize(len, 0);
    b.resize(len, 0);
    a > b
}

// Turns the GitHub release body into plain lines for the update window:
// keeps the bullet points, drops headings, the macOS note and the footer.
fn release_notes_text(body: &str) -> String {
    body.lines()
        .map(str::trim)
        .filter(|line| line.starts_with("- ") || line.starts_with("* "))
        .map(|line| line[2..].trim())
        .filter(|line| !line.starts_with("macOS"))
        .take(8)
        .collect::<Vec<_>>()
        .join("\n")
}

fn windows_setup_asset_name(version: &str) -> String {
    format!("Dawith-Search_{version}_x64-setup.exe")
}

fn fetch_update_info() -> Result<Value, String> {
    let current = current_app_version();
    if !cfg!(windows) {
        return Ok(json!({ "supported": false, "available": false, "currentVersion": current, "reason": "platform-unsupported" }));
    }
    let api = std::env::var("DAWITH_UPDATE_RELEASE_API").unwrap_or_else(|_| LATEST_RELEASE_API.to_string());
    let release: Value = ureq::get(&api)
        .set("User-Agent", "dawith-search-updater")
        .set("Accept", "application/vnd.github+json")
        .timeout(std::time::Duration::from_secs(15))
        .call()
        .map_err(|error| format!("최신 버전 정보를 가져오지 못했습니다: {error}"))?
        .into_json()
        .map_err(|error| format!("최신 버전 정보를 읽지 못했습니다: {error}"))?;
    let latest = release.get("tag_name").and_then(Value::as_str).unwrap_or("").trim_start_matches(['v', 'V']).to_string();
    let asset_name = windows_setup_asset_name(&latest);
    let asset = release
        .get("assets")
        .and_then(Value::as_array)
        .and_then(|assets| assets.iter().find(|asset| asset.get("name").and_then(Value::as_str) == Some(asset_name.as_str())));
    let Some(asset) = asset else {
        return Ok(json!({ "supported": false, "available": false, "currentVersion": current, "latestVersion": latest, "reason": "platform-asset-unavailable" }));
    };
    Ok(json!({
        "supported": true,
        "available": is_newer_version(&latest, &current),
        "currentVersion": current,
        "latestVersion": latest,
        "releaseUrl": release.get("html_url"),
        "notes": release.get("body").and_then(Value::as_str).map(release_notes_text).unwrap_or_default(),
        "asset": {
            "name": asset_name,
            "url": asset.get("browser_download_url"),
            "digest": asset.get("digest"),
            "size": asset.get("size")
        }
    }))
}

#[tauri::command]
fn app_version() -> String {
    current_app_version()
}

#[tauri::command]
async fn check_for_updates() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(fetch_update_info)
        .await
        .map_err(|error| error.to_string())?
}

// Downloads the installer, checks its size and the SHA-256 digest GitHub
// publishes for the asset, then runs it in passive update mode (progress
// window only, no prompts). `/R` makes the installer start the app again.
fn download_and_verify_update(info: &Value, progress: &dyn Fn(Value)) -> Result<PathBuf, String> {
    use sha2::{Digest, Sha256};
    let asset = info.get("asset").ok_or("설치 파일 정보가 없습니다.")?;
    let name = asset.get("name").and_then(Value::as_str).ok_or("설치 파일 이름이 없습니다.")?;
    let url = asset.get("url").and_then(Value::as_str).ok_or("설치 파일 주소가 없습니다.")?;
    let expected_size = asset.get("size").and_then(Value::as_u64);
    let expected_digest = asset
        .get("digest")
        .and_then(Value::as_str)
        .and_then(|digest| digest.strip_prefix("sha256:"))
        .map(str::to_ascii_lowercase)
        .ok_or("릴리스에 SHA-256 값이 없어 안전하게 설치할 수 없습니다.")?;

    let dir = std::env::temp_dir().join("dawith-search-update");
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let target = dir.join(name);
    let partial = dir.join(format!("{name}.part"));
    let response = ureq::get(url)
        .set("User-Agent", "dawith-search-updater")
        .timeout(std::time::Duration::from_secs(600))
        .call()
        .map_err(|error| format!("설치 파일을 내려받지 못했습니다: {error}"))?;
    let mut reader = response.into_reader();
    let mut file = fs::File::create(&partial).map_err(|error| error.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];
    let mut written = 0u64;
    let mut last_report = std::time::Instant::now();
    progress(json!({ "stage": "downloading", "received": 0, "total": expected_size }));
    loop {
        let read = reader.read(&mut buffer).map_err(|error| format!("다운로드가 중단되었습니다: {error}"))?;
        if read == 0 { break; }
        hasher.update(&buffer[..read]);
        file.write_all(&buffer[..read]).map_err(|error| error.to_string())?;
        written += read as u64;
        if last_report.elapsed() >= std::time::Duration::from_millis(120) {
            last_report = std::time::Instant::now();
            progress(json!({ "stage": "downloading", "received": written, "total": expected_size }));
        }
    }
    progress(json!({ "stage": "verifying", "received": written, "total": expected_size }));
    file.flush().map_err(|error| error.to_string())?;
    drop(file);
    let actual_digest = hasher.finalize().iter().map(|byte| format!("{byte:02x}")).collect::<String>();
    if expected_size.is_some_and(|size| size != written) || actual_digest != expected_digest {
        let _ = fs::remove_file(&partial);
        return Err("내려받은 설치 파일이 릴리스 정보와 일치하지 않아 설치하지 않았습니다.".to_string());
    }
    let _ = fs::remove_file(&target);
    fs::rename(&partial, &target).map_err(|error| error.to_string())?;
    Ok(target)
}

#[tauri::command]
async fn download_update(app: AppHandle) -> Result<Value, String> {
    let progress_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<PathBuf, String> {
        let progress = |payload: Value| { let _ = progress_app.emit("update-progress", payload); };
        progress(json!({ "stage": "checking" }));
        let info = fetch_update_info()?;
        if !info.get("available").and_then(Value::as_bool).unwrap_or(false) {
            return Err("이미 최신 버전입니다.".to_string());
        }
        download_and_verify_update(&info, &progress)
    })
    .await
    .map_err(|error| error.to_string())?;
    let installer = match result {
        Ok(path) => path,
        Err(error) => return Ok(json!({ "success": false, "error": error })),
    };
    // The installer is a GUI program: start it normally so its progress
    // window is visible, then quit so it can replace the running files.
    if let Err(error) = Command::new(&installer).args(["/P", "/UPDATE", "/R"]).spawn() {
        return Ok(json!({ "success": false, "error": format!("설치 파일을 실행하지 못했습니다: {error}") }));
    }
    let _ = app.emit("update-progress", json!({ "stage": "installing" }));
    // Leave the "installing, restarting soon" message up briefly before the
    // installer's own progress window takes over.
    let exit_app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(1500));
        exit_app.exit(0);
    });
    Ok(json!({ "success": true, "action": "relaunch" }))
}

#[tauri::command]
fn stub_success() -> Value {
    json!({ "success": false, "supported": false, "error": "이 기능은 경량 Tauri 핵심 버전에서 준비 중입니다." })
}

fn main() {
    let data_dir = data_dir();
    let config = read_config(&data_dir);
    tauri::Builder::default()
        // Opening the app again while it runs in the tray shows the existing
        // window instead of starting a second copy (and a second indexer).
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main_window(app)))
        .manage(AppState { config: Mutex::new(config), data_dir, local_index: Mutex::new(LocalIndex::default()) })
        .setup(|app| {
            build_tray(app)?;
            start_local_indexing(&app.handle()).map_err(std::io::Error::other)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // Alt+F4 and the taskbar's close also keep the app in the tray.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
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
            install_goz_backend,
            get_file_stats,
            get_file_content,
            get_file_url,
            open_file,
            open_folder,
            copy_path,
            delete_file,
            rename_file,
            get_conversion_options,
            get_storage_analysis,
            find_duplicates,
            convert_files,
            reindex,
            window_minimize,
            window_maximize,
            window_close,
            open_guide,
            check_for_updates,
            app_version,
            download_update,
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
        let root = if cfg!(windows) { PathBuf::from(r"C:\") } else { PathBuf::from("/") };
        let child = root.join("Users").join("dawith").join("Desktop").join("report.pdf");
        let config = json!({ "roots": [root.to_string_lossy()] });
        assert!(is_allowed_path(&child, &config));
    }

    #[test]
    fn storage_and_duplicates_use_index_and_content() {
        let dir = std::env::temp_dir().join(format!("dawith-dupe-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let small: Vec<u8> = (0..2 * 1024 * 1024).map(|i| (i % 251) as u8).collect();
        let mut small_tail = small.clone();
        *small_tail.last_mut().unwrap() ^= 1;
        let large: Vec<u8> = (0..20 * 1024 * 1024).map(|i| (i % 253) as u8).collect();
        let files: Vec<(&str, &[u8])> = vec![
            ("a.pdf", &small), ("b.pdf", &small), ("c.pdf", &small_tail),
            ("movie1.mp4", &large), ("movie2.mp4", &large), ("tiny.txt", b"hello"),
        ];
        let mut index = fastindex::FastIndex::default();
        let folder = index.add_dir(&dir.to_string_lossy());
        for (name, data) in &files {
            fs::write(dir.join(name), data).unwrap();
            index.push(folder, name, data.len() as u64, 0, false);
        }
        let state = AppState {
            config: Mutex::new(json!({})),
            data_dir: dir.clone(),
            local_index: Mutex::new(LocalIndex { index, ..Default::default() }),
        };

        let storage = storage_analysis(&state).unwrap();
        assert_eq!(storage["totalFiles"], 6);
        assert_eq!(storage["categories"]["documents"]["count"], 4);
        assert_eq!(storage["categories"]["videos"]["count"], 2);
        assert_eq!(storage["topLargest"][0]["name"], "movie1.mp4");

        let result = duplicate_scan(&state, 1024 * 1024).unwrap();
        let groups = result["groups"].as_array().unwrap();
        assert_eq!(groups.len(), 2, "{result}");
        assert_eq!(groups[0]["size"], 20 * 1024 * 1024);
        let names: Vec<&str> = groups[1]["items"].as_array().unwrap().iter().map(|item| item["name"].as_str().unwrap()).collect();
        assert!(names.contains(&"a.pdf") && names.contains(&"b.pdf") && !names.contains(&"c.pdf"));
        assert_eq!(result["partial"], false);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn scope_boundary_does_not_match_sibling() {
        let root = if cfg!(windows) {
            PathBuf::from(r"C:\Users\dawith")
        } else {
            PathBuf::from("/Users/dawith")
        };
        let child = root.join("Desktop").join("report.pdf");
        let sibling = if cfg!(windows) {
            PathBuf::from(r"C:\Users\dawith-other\report.pdf")
        } else {
            PathBuf::from("/Users/dawith-other/report.pdf")
        };
        let config = json!({ "roots": [root.to_string_lossy()] });
        assert!(is_allowed_path(&child, &config));
        assert!(!is_allowed_path(&sibling, &config));
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
    fn drm_hwp_title_is_searchable_without_reading_body() {
        let record = json!({
            "name": "돌봄통합지원법 대응 안내문.hwp",
            "fullPath": "C:/Users/dawith/Desktop/돌봄통합지원법 대응 안내문.hwp",
            "ext": "hwp",
            "size": 74256,
            "mtime": now_millis(),
            "isDir": false
        });
        assert!(query_matches(&record, "돌봄통합지원법 대응 안내문", false));
        assert!(query_matches(&record, "doc: 돌봄통합지원법", false));
    }

    #[test]
    fn bundled_native_path_finds_mapped_and_legacy_layouts() {
        let arch = if cfg!(target_arch = "aarch64") { "arm64" } else { "x64" };
        let base = std::env::temp_dir().join(format!("dawith-native-{}", now_millis()));
        let legacy = base.join("_up_").join("bin").join("native").join("windows").join(arch);
        fs::create_dir_all(&legacy).unwrap();
        fs::write(legacy.join("everything-ipc.exe"), b"").unwrap();
        assert_eq!(bundled_native_path(&base, "everything-ipc.exe"), Some(legacy.join("everything-ipc.exe")));

        let mapped = base.join("bin").join("native").join("windows").join(arch);
        fs::create_dir_all(&mapped).unwrap();
        fs::write(mapped.join("everything-ipc.exe"), b"").unwrap();
        assert_eq!(bundled_native_path(&base, "everything-ipc.exe"), Some(mapped.join("everything-ipc.exe")));
        assert_eq!(bundled_native_path(&base, "goz.exe"), None);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn path_only_native_items_skip_network_metadata() {
        let unc = json!({ "path": "\\\\server\\share\\대응 안내.hwp", "size": null, "date_modified": null, "is_dir": false });
        let record = native_record(&unc, &[PathBuf::from("C:\\")]).unwrap();
        assert_eq!(record["metaUnknown"], json!(true));
        assert_eq!(record["ext"], json!("hwp"));
        assert!(query_matches(&record, "대응", false));

        let full = json!({ "path": "\\\\server\\share\\폴더", "size": 0, "date_modified": 1700000000000u64, "is_dir": true });
        let record = native_record(&full, &[]).unwrap();
        assert_eq!(record["metaUnknown"], json!(false));
        assert_eq!(record["isDir"], json!(true));
        assert_eq!(record["mtime"], json!(1700000000000u64));
    }

    #[test]
    fn size_and_date_filters_request_native_metadata() {
        assert!(!query_needs_native_metadata("대응"));
        assert!(!query_needs_native_metadata("ext:hwp;hwpx 대응"));
        assert!(query_needs_native_metadata("대응 size:>1mb"));
        assert!(query_needs_native_metadata("dm:today"));
    }

    #[test]
    fn excluded_local_drives_stay_out_of_search_roots() {
        let mut config = json!({
            "roots": ["C:\\", "H:\\", "\\\\server\\share"],
            "excludedLocalRoots": ["H:\\"]
        });
        apply_local_roots(&mut config, vec!["C:\\".into(), "D:\\".into(), "H:\\".into()]);
        let roots: Vec<&str> = config["roots"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
        let local: Vec<&str> = config["localRoots"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
        assert_eq!(roots, vec!["C:\\", "\\\\server\\share", "D:\\"]);
        assert_eq!(local, vec!["C:\\", "D:\\"]);
    }

    #[test]
    fn release_notes_keep_only_bullets() {
        let body = "## Dawith Search 1.3.6\r\n\r\n- 업데이트 창을 띄웁니다.\r\n- 빨간 점으로 알립니다.\r\n- macOS는 1.3.3 그대로\r\n\r\n🤖 Generated";
        assert_eq!(release_notes_text(body), "업데이트 창을 띄웁니다.\n빨간 점으로 알립니다.");
    }

    #[test]
    fn update_versions_compare_numerically() {
        assert!(is_newer_version("1.2.1", "1.2.0"));
        assert!(is_newer_version("v1.10.0", "1.9.9"));
        assert!(is_newer_version("1.3", "1.2.9"));
        assert!(!is_newer_version("1.2.0", "1.2.0"));
        assert!(!is_newer_version("1.1.8", "1.2.0"));
        assert_eq!(windows_setup_asset_name("1.2.1"), "Dawith-Search_1.2.1_x64-setup.exe");
    }

    #[test]
    fn native_category_query_expands_to_extensions() {
        let query = translate_native_query("doc: 계약서");
        assert!(query.contains("ext:doc;docx"));
        assert!(query.contains("계약서"));
    }

    #[test]
    fn hwp_extraction_smoke_from_env() {
        let Ok(path) = std::env::var("DAWITH_HWP_TEST_FILE") else { return; };
        match extract_hwp_text(Path::new(&path)) {
            Ok(text) => {
                assert!(!text.trim().is_empty(), "HWP extraction returned empty text");
                println!("HWP_TEXT_PREVIEW={}", text.chars().take(300).collect::<String>());
            }
            Err(error) => {
                assert!(error.contains("DRM"), "unexpected HWP extraction error: {error}");
                println!("HWP_READABILITY={error}");
            }
        }
    }
}

