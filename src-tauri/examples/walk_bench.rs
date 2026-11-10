// Parallel walker using std::fs::read_dir: on Windows DirEntry::metadata()
// comes from the directory listing itself (no extra per-file system call).
use rayon::prelude::*;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Instant;

struct Out { dirs: Vec<(PathBuf, Vec<(String, u64, u64, bool)>)> }

fn walk(dir: &Path, excluded: &[String], out: &Mutex<Out>, count: &AtomicUsize) {
    let Ok(read) = std::fs::read_dir(dir) else { return };
    let mut children = Vec::new();
    let mut subdirs = Vec::new();
    for entry in read.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let lower = name.to_lowercase();
        if name.starts_with('.') || excluded.contains(&lower) { continue; }
        let Ok(meta) = entry.metadata() else { continue };
        let is_dir = meta.is_dir();
        #[cfg(windows)]
        { use std::os::windows::fs::MetadataExt; if meta.file_attributes() & 0x2 != 0 { continue; } }
        let mtime = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0);
        if is_dir && !meta.file_type().is_symlink() { subdirs.push(entry.path()); }
        children.push((name, if is_dir { 0 } else { meta.len() }, mtime, is_dir));
    }
    count.fetch_add(children.len(), Ordering::Relaxed);
    out.lock().unwrap().dirs.push((dir.to_path_buf(), children));
    subdirs.par_iter().for_each(|sub| walk(sub, excluded, out, count));
}

fn main() {
    let root = std::env::args().nth(1).unwrap_or_else(|| "C:\\".into());
    let excluded: Vec<String> = ["node_modules", ".git", "$recycle.bin", "system volume information", "appdata", "temp", "cache", "__pycache__"].iter().map(|s| s.to_string()).collect();
    let t = Instant::now();
    let out = Mutex::new(Out { dirs: Vec::new() });
    let count = AtomicUsize::new(0);
    walk(Path::new(&root), &excluded, &out, &count);
    println!("std read_dir parallel walk {}: {} entries in {} dirs, {:.1}s", root, count.load(Ordering::Relaxed), out.lock().unwrap().dirs.len(), t.elapsed().as_secs_f64());
}
