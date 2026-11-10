// Benchmark for the new index: walk a root, build, save, load, search.
#[path = "../src/fastindex.rs"]
mod fastindex;
use fastindex::FastIndex;
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Instant;

fn main() {
    let root = std::env::args().nth(1).unwrap_or_else(|| "C:\\".into());
    let excluded: Vec<String> = ["node_modules", ".git", "$recycle.bin", "system volume information", "appdata", "temp", "cache", "__pycache__"].iter().map(|s| s.to_string()).collect();
    let t = Instant::now();
    let mut index = FastIndex::default();
    let mut dir_ids: HashMap<PathBuf, u32> = HashMap::new();
    let ex = excluded.clone();
    let walker = jwalk::WalkDir::new(&root).skip_hidden(true).follow_links(false).process_read_dir(move |_, _, _, children| {
        children.retain(|child| child.as_ref().map(|e| !ex.contains(&e.file_name.to_string_lossy().to_lowercase())).unwrap_or(true));
    });
    for entry in walker.into_iter().filter_map(Result::ok) {
        if entry.depth == 0 { continue; }
        let parent = entry.parent_path().to_path_buf();
        let dir = match dir_ids.get(&parent) { Some(id) => *id, None => { let id = index.add_dir(&parent.to_string_lossy()); dir_ids.insert(parent, id); id } };
        let meta = entry.metadata().ok();
        let size = meta.as_ref().map(|m| if m.is_dir() { 0 } else { m.len() }).unwrap_or(0);
        let mtime = meta.as_ref().and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0);
        index.push(dir, &entry.file_name.to_string_lossy(), size, mtime, entry.file_type.is_dir());
    }
    println!("walk+build {}: {} entries, {} dirs in {:.1}s", root, index.entries.len(), index.dirs.len(), t.elapsed().as_secs_f64());
    let cache = std::env::temp_dir().join("dawith-bench.idx");
    let t = Instant::now(); index.save(&cache).unwrap(); println!("save {:.2}s ({} MB)", t.elapsed().as_secs_f64(), std::fs::metadata(&cache).unwrap().len() / 1_000_000);
    let t = Instant::now(); let loaded = FastIndex::load(&cache).unwrap(); println!("load {:.2}s ({} entries)", t.elapsed().as_secs_f64(), loaded.entries.len());
    for q in ["ㅈ", "직원", "대응", "보고서", "a", "2026 보고서", "pdf", "dawith"] {
        let terms: Vec<String> = q.split_whitespace().map(|s| s.to_lowercase()).collect();
        let mut best = f64::MAX; let mut total = 0;
        for _ in 0..5 { let t = Instant::now(); let (_hits, n) = loaded.search(&terms, 200, |_, _| true); best = best.min(t.elapsed().as_secs_f64() * 1000.0); total = n; }
        println!("search {:<12} {:>8} matches  {:>6.1} ms", q, total, best);
    }
}
