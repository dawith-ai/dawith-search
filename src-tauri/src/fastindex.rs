// Dawith's own file index: a compact in-memory table of every file name,
// searched on all CPU cores, and saved to disk so the next start is instant.
//
// Each entry keeps only what the result list needs. Folder paths are stored
// once and shared by index, and lowercased names are precomputed so a search
// is nothing but substring checks over a flat array.
use rayon::prelude::*;
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::Path;

#[derive(Clone)]
pub struct Entry {
    pub name: Box<str>,
    pub lower: Box<str>,
    pub dir: u32,
    pub size: u64,
    pub mtime: u64,
    pub is_dir: bool,
    // False once the file was deleted; skipped by search and not saved.
    pub alive: bool,
}

/// Column the result list is sorted by; Relevance is the default ranking.
#[derive(Clone, Copy, PartialEq, Debug, Default)]
pub enum SortKey {
    #[default]
    Relevance,
    Name,
    Path,
    Size,
    Modified,
    Extension,
}

impl SortKey {
    pub fn from_option(value: Option<&str>) -> SortKey {
        match value {
            Some("name") => SortKey::Name,
            Some("path") => SortKey::Path,
            Some("size") => SortKey::Size,
            Some("mtime") | Some("modified") => SortKey::Modified,
            Some("ext") | Some("extension") => SortKey::Extension,
            _ => SortKey::Relevance,
        }
    }
}

fn extension_of(lower: &str) -> &str {
    lower.rsplit_once('.').map(|(_, ext)| ext).unwrap_or("")
}

/// Extension used for sorting; folders have none even if their name has a dot.
pub fn entry_extension(entry: &Entry) -> &str {
    if entry.is_dir { "" } else { extension_of(&entry.lower) }
}

#[derive(Default)]
pub struct FastIndex {
    pub dirs: Vec<Box<str>>,
    pub entries: Vec<Entry>,
    // Lowercased folder path -> folder id, built on first use by live updates.
    dir_map: HashMap<String, u32>,
}

const MAGIC: &[u8; 8] = b"DWSIDX01";

impl FastIndex {
    pub fn add_dir(&mut self, path: &str) -> u32 {
        self.dirs.push(path.into());
        (self.dirs.len() - 1) as u32
    }

    pub fn push(&mut self, dir: u32, name: &str, size: u64, mtime: u64, is_dir: bool) {
        self.entries.push(Entry { name: name.into(), lower: name.to_lowercase().into(), dir, size, mtime, is_dir, alive: true });
    }

    fn folder_id(&mut self, path: &str) -> u32 {
        if self.dir_map.len() != self.dirs.len() {
            self.dir_map = self.dirs.iter().enumerate().map(|(id, dir)| (dir.to_lowercase(), id as u32)).collect();
        }
        let key = path.to_lowercase();
        if let Some(id) = self.dir_map.get(&key) {
            return *id;
        }
        let id = self.add_dir(path);
        self.dir_map.insert(key, id);
        id
    }

    fn find(&self, dir: u32, lower: &str) -> Option<usize> {
        self.entries.par_iter().position_any(|entry| entry.alive && entry.dir == dir && entry.lower.as_ref() == lower)
    }

    /// Adds a new file or folder, or refreshes size and time of a known one.
    pub fn upsert(&mut self, folder: &str, name: &str, size: u64, mtime: u64, is_dir: bool) {
        let dir = self.folder_id(folder);
        let lower = name.to_lowercase();
        match self.find(dir, &lower) {
            Some(position) => {
                let entry = &mut self.entries[position];
                entry.size = size;
                entry.mtime = mtime;
                entry.is_dir = is_dir;
            }
            None => self.push(dir, name, size, mtime, is_dir),
        }
    }

    /// Marks a deleted file, or a deleted folder with everything inside it.
    pub fn remove(&mut self, folder: &str, name: &str) {
        let dir = self.folder_id(folder);
        let lower = name.to_lowercase();
        let Some(position) = self.find(dir, &lower) else { return };
        let was_dir = self.entries[position].is_dir;
        self.entries[position].alive = false;
        if was_dir {
            let full = self.full_path(&self.entries[position].clone()).to_lowercase();
            let inside: HashSet<u32> = self
                .dirs
                .iter()
                .enumerate()
                .filter(|(_, dir)| {
                    let dir = dir.to_lowercase();
                    dir == full || dir.starts_with(&format!("{full}\\"))
                })
                .map(|(id, _)| id as u32)
                .collect();
            for entry in self.entries.iter_mut().filter(|entry| inside.contains(&entry.dir)) {
                entry.alive = false;
            }
        }
    }

    pub fn dir_of(&self, entry: &Entry) -> &str {
        self.dirs.get(entry.dir as usize).map(|dir| dir.as_ref()).unwrap_or("")
    }

    pub fn full_path(&self, entry: &Entry) -> String {
        let dir = self.dir_of(entry);
        if dir.is_empty() {
            entry.name.to_string()
        } else if dir.ends_with('\\') || dir.ends_with('/') {
            format!("{dir}{}", entry.name)
        } else {
            format!("{dir}\\{}", entry.name)
        }
    }

    /// Indexes of entries whose lowercased name contains every term and that
    /// pass `keep`, sorted by name; returns at most `limit` plus the total.
    pub fn search<F>(&self, terms: &[String], limit: usize, keep: F) -> (Vec<u32>, usize)
    where
        F: Fn(&FastIndex, &Entry) -> bool + Sync,
    {
        self.search_typed(terms, false, limit, keep)
    }

    pub fn search_typed<F>(&self, terms: &[String], composing: bool, limit: usize, keep: F) -> (Vec<u32>, usize)
    where
        F: Fn(&FastIndex, &Entry) -> bool + Sync,
    {
        self.search_sorted(terms, composing, SortKey::Relevance, false, limit, keep)
    }

    /// 0 = the name starts with the first word, 1 = the word starts after a
    /// space or punctuation, 2 = anywhere else.
    fn rank(lower: &str, term: &str, pattern: Option<&Vec<QChar>>) -> u8 {
        let start = match pattern {
            Some(pattern) => pattern_position(lower, pattern),
            None => lower.find(term).map(|byte| lower[..byte].chars().count()),
        };
        match start {
            Some(0) => 0,
            Some(position) => match lower.chars().nth(position - 1) {
                Some(c) if !c.is_alphanumeric() => 1,
                _ => 2,
            },
            None => 2,
        }
    }

    /// Like `search`, with Korean initial-consonant matching and, when
    /// `composing`, a still-being-typed last syllable.
    /// Search sorted by a result-list column (or by relevance), ascending
    /// unless `descending`.
    pub fn search_sorted<F>(&self, terms: &[String], composing: bool, sort: SortKey, descending: bool, limit: usize, keep: F) -> (Vec<u32>, usize)
    where
        F: Fn(&FastIndex, &Entry) -> bool + Sync,
    {
        let last = terms.len().saturating_sub(1);
        let patterns: Vec<Option<Vec<QChar>>> = terms.iter().enumerate().map(|(position, term)| compile_term(term, composing && position == last)).collect();
        let matches_name = |lower: &str| {
            terms.iter().zip(&patterns).all(|(term, pattern)| match pattern {
                Some(pattern) => pattern_in(lower, pattern),
                None => lower.contains(term.as_str()),
            })
        };
        let mut hits: Vec<u32> = self
            .entries
            .par_iter()
            .enumerate()
            .filter(|(_, entry)| entry.alive && matches_name(&entry.lower) && keep(self, entry))
            .map(|(index, _)| index as u32)
            .collect();
        let total = hits.len();
        // Better matches first, then by name (Everything sorts by name only).
        let first_term = terms.first().map(String::as_str).unwrap_or("");
        let first_pattern = patterns.first().and_then(Option::as_ref);
        let ranks: HashMap<u32, u8> = if first_term.is_empty() || sort != SortKey::Relevance {
            HashMap::new()
        } else {
            hits.par_iter().map(|hit| (*hit, Self::rank(&self.entries[*hit as usize].lower, first_term, first_pattern))).collect()
        };
        let by_name = |a: &u32, b: &u32| -> Ordering {
            let (ea, eb) = (&self.entries[*a as usize], &self.entries[*b as usize]);
            let ordering = match sort {
                SortKey::Relevance => {
                    let rank = |hit: &u32| ranks.get(hit).copied().unwrap_or(2);
                    rank(a).cmp(&rank(b)).then_with(|| ea.lower.cmp(&eb.lower))
                }
                SortKey::Name => ea.lower.cmp(&eb.lower),
                SortKey::Path => self.dir_of(ea).cmp(self.dir_of(eb)).then_with(|| ea.lower.cmp(&eb.lower)),
                SortKey::Size => ea.size.cmp(&eb.size).then_with(|| ea.lower.cmp(&eb.lower)),
                SortKey::Modified => ea.mtime.cmp(&eb.mtime).then_with(|| ea.lower.cmp(&eb.lower)),
                // Folders have no extension even if their name has a dot.
                SortKey::Extension => entry_extension(ea).cmp(entry_extension(eb)).then_with(|| ea.lower.cmp(&eb.lower)),
            }
            .then_with(|| ea.dir.cmp(&eb.dir));
            if descending && sort != SortKey::Relevance { ordering.reverse() } else { ordering }
        };
        if hits.len() > limit && limit > 0 {
            hits.select_nth_unstable_by(limit - 1, by_name);
            hits.truncate(limit);
        }
        hits.par_sort_unstable_by(by_name);
        (hits, total)
    }

    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        let temp = path.with_extension("tmp");
        {
            let mut out = BufWriter::with_capacity(1 << 20, fs::File::create(&temp)?);
            out.write_all(MAGIC)?;
            write_u32(&mut out, self.dirs.len() as u32)?;
            for dir in &self.dirs {
                write_str(&mut out, dir)?;
            }
            let alive = self.entries.iter().filter(|entry| entry.alive).count();
            write_u32(&mut out, alive as u32)?;
            for entry in self.entries.iter().filter(|entry| entry.alive) {
                write_str(&mut out, &entry.name)?;
                write_u32(&mut out, entry.dir)?;
                out.write_all(&entry.size.to_le_bytes())?;
                out.write_all(&entry.mtime.to_le_bytes())?;
                out.write_all(&[entry.is_dir as u8])?;
            }
            out.flush()?;
        }
        fs::rename(temp, path)
    }

    pub fn load(path: &Path) -> std::io::Result<FastIndex> {
        let mut input = BufReader::with_capacity(1 << 20, fs::File::open(path)?);
        let mut magic = [0u8; 8];
        input.read_exact(&mut magic)?;
        if &magic != MAGIC {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "unknown index format"));
        }
        let dir_count = read_u32(&mut input)? as usize;
        let mut dirs = Vec::with_capacity(dir_count);
        for _ in 0..dir_count {
            dirs.push(read_str(&mut input)?.into_boxed_str());
        }
        let entry_count = read_u32(&mut input)? as usize;
        let mut raw = Vec::with_capacity(entry_count);
        for _ in 0..entry_count {
            let name = read_str(&mut input)?;
            let dir = read_u32(&mut input)?;
            let mut eight = [0u8; 8];
            input.read_exact(&mut eight)?;
            let size = u64::from_le_bytes(eight);
            input.read_exact(&mut eight)?;
            let mtime = u64::from_le_bytes(eight);
            let mut flag = [0u8; 1];
            input.read_exact(&mut flag)?;
            raw.push((name, dir, size, mtime, flag[0] != 0));
        }
        // Lowercasing millions of names is the slow part of loading; do it on all cores.
        let entries = raw
            .into_par_iter()
            .map(|(name, dir, size, mtime, is_dir)| Entry { lower: name.to_lowercase().into(), name: name.into(), dir, size, mtime, is_dir, alive: true })
            .collect();
        Ok(FastIndex { dirs, entries, dir_map: HashMap::new() })
    }
}


// Korean typing goes through partial states (ㅈ → 지 → 직 → 직ㅇ → 직이 →
// 직인). Plain substring search finds nothing for most of them, so the result
// list flickered empty on almost every key. A search word can therefore
// contain:
//   - a bare initial consonant (ㅈ): matches any syllable starting with it,
//     so "ㅈㅇ" finds 직인, 주인, 저장 ... (초성 검색)
//   - while the IME is still composing, a last syllable without a final
//     consonant (이): matches any syllable with the same start (인, 일, 있 ...)
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum QChar {
    Exact(char),
    Initial(u32),
    Prefix(u32, u32),
}

const SYLLABLE_BASE: u32 = 0xAC00;
const SYLLABLE_LAST: u32 = 0xD7A3;
// Compatibility jamo (what a keyboard types) for the 19 initial consonants.
const INITIALS: [char; 19] = ['ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];

fn syllable_parts(c: char) -> Option<(u32, u32, u32)> {
    let code = c as u32;
    if !(SYLLABLE_BASE..=SYLLABLE_LAST).contains(&code) {
        return None;
    }
    let offset = code - SYLLABLE_BASE;
    Some((offset / 588, (offset % 588) / 28, offset % 28))
}

/// Turns a search word into a pattern, or None when plain substring search
/// is enough. `composing` means the last character is still being typed.
pub fn compile_term(term: &str, composing: bool) -> Option<Vec<QChar>> {
    let chars: Vec<char> = term.chars().collect();
    let mut special = false;
    let pattern = chars
        .iter()
        .enumerate()
        .map(|(position, c)| {
            if let Some(initial) = INITIALS.iter().position(|jamo| jamo == c) {
                special = true;
                return QChar::Initial(initial as u32);
            }
            if composing && position + 1 == chars.len() {
                if let Some((initial, medial, 0)) = syllable_parts(*c) {
                    special = true;
                    return QChar::Prefix(initial, medial);
                }
            }
            QChar::Exact(*c)
        })
        .collect();
    special.then_some(pattern)
}

fn char_matches(query: QChar, c: char) -> bool {
    match query {
        QChar::Exact(expected) => c == expected,
        QChar::Initial(initial) => c == INITIALS[initial as usize] || syllable_parts(c).is_some_and(|(i, _, _)| i == initial),
        QChar::Prefix(initial, medial) => syllable_parts(c).is_some_and(|(i, m, _)| i == initial && m == medial),
    }
}

/// Character position of the first match of `pattern` in `name`.
pub fn pattern_position(name: &str, pattern: &[QChar]) -> Option<usize> {
    let mut rest = name.chars();
    let mut position = 0;
    loop {
        let mut probe = rest.clone();
        if pattern.iter().all(|query| probe.next().is_some_and(|c| char_matches(*query, c))) {
            return Some(position);
        }
        rest.next()?;
        position += 1;
    }
}

/// True when `pattern` occurs anywhere in `name` (no allocation).
pub fn pattern_in(name: &str, pattern: &[QChar]) -> bool {
    if pattern.is_empty() {
        return true;
    }
    let mut rest = name.chars();
    loop {
        let mut probe = rest.clone();
        if pattern.iter().all(|query| probe.next().is_some_and(|c| char_matches(*query, c))) {
            return true;
        }
        if rest.next().is_none() {
            return false;
        }
    }
}

fn write_u32(out: &mut impl Write, value: u32) -> std::io::Result<()> {
    out.write_all(&value.to_le_bytes())
}

fn write_str(out: &mut impl Write, value: &str) -> std::io::Result<()> {
    write_u32(out, value.len() as u32)?;
    out.write_all(value.as_bytes())
}

fn read_u32(input: &mut impl Read) -> std::io::Result<u32> {
    let mut four = [0u8; 4];
    input.read_exact(&mut four)?;
    Ok(u32::from_le_bytes(four))
}

fn read_str(input: &mut impl Read) -> std::io::Result<String> {
    let len = read_u32(input)? as usize;
    let mut bytes = vec![0u8; len];
    input.read_exact(&mut bytes)?;
    String::from_utf8(bytes).map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sorts_by_each_column_both_ways() {
        let mut index = FastIndex::default();
        let a = index.add_dir(r"C:A");
        let b = index.add_dir(r"C:B");
        index.push(b, "보고서 가.pdf", 300, 10, false);
        index.push(a, "보고서 나.hwp", 100, 30, false);
        index.push(a, "보고서 다.xlsx", 200, 20, false);
        let order = |sort: SortKey, desc: bool| -> Vec<String> {
            let (hits, _) = index.search_sorted(&["보고서".to_string()], false, sort, desc, 10, |_, _| true);
            hits.iter().map(|i| index.entries[*i as usize].name.to_string()).collect()
        };
        assert_eq!(order(SortKey::Size, false), vec!["보고서 나.hwp", "보고서 다.xlsx", "보고서 가.pdf"]);
        assert_eq!(order(SortKey::Size, true), vec!["보고서 가.pdf", "보고서 다.xlsx", "보고서 나.hwp"]);
        assert_eq!(order(SortKey::Modified, true)[0], "보고서 나.hwp");
        assert_eq!(order(SortKey::Path, false)[2], "보고서 가.pdf");
        assert_eq!(order(SortKey::Extension, false), vec!["보고서 나.hwp", "보고서 가.pdf", "보고서 다.xlsx"]);
        assert_eq!(order(SortKey::Name, true)[0], "보고서 다.xlsx");
        // Only the top `limit` come back, still in the requested order.
        let (hits, total) = index.search_sorted(&["보고서".to_string()], false, SortKey::Size, true, 1, |_, _| true);
        assert_eq!((total, index.entries[hits[0] as usize].size), (3, 300));
    }

    #[test]
    fn korean_initials_and_composing_syllables() {
        let mut index = FastIndex::default();
        let dir = index.add_dir(r"C:Docs");
        for name in ["직인 날인 대장.hwp", "주민 명단.xlsx", "저장소.txt", "직원 교육.pdf", "report.pdf"] {
            index.push(dir, name, 1, 1, false);
        }
        let names = |terms: &[&str], composing: bool| -> Vec<String> {
            let terms: Vec<String> = terms.iter().map(|t| t.to_string()).collect();
            let (hits, _) = index.search_typed(&terms, composing, 10, |_, _| true);
            hits.iter().map(|i| index.entries[*i as usize].name.to_string()).collect()
        };
        // 초성 only
        assert_eq!(names(&["ㅈㅇ"], false), vec!["직원 교육.pdf", "직인 날인 대장.hwp"]);
        assert_eq!(names(&["ㅈ"], false).len(), 4);
        // mixed syllable + initial while typing 직ㅇ
        assert_eq!(names(&["직ㅇ"], true), vec!["직원 교육.pdf", "직인 날인 대장.hwp"]);
        // composing last syllable 이 matches 인, finished 직이 matches nothing
        assert_eq!(names(&["직이"], true), vec!["직인 날인 대장.hwp"]);
        assert!(names(&["직이"], false).is_empty());
        // plain words unchanged
        assert_eq!(names(&["주민"], false), vec!["주민 명단.xlsx"]);
        assert_eq!(names(&["pdf"], false).len(), 2);
    }

    #[test]
    fn live_updates_add_refresh_and_remove() {
        let mut index = FastIndex::default();
        let docs = index.add_dir(r"C:\Docs");
        index.push(docs, "Project", 0, 1, true);
        let project = index.add_dir(r"C:\Docs\Project");
        index.push(project, "plan.txt", 5, 1, false);

        index.upsert(r"C:\Docs", "새 보고서.hwp", 10, 2, false);
        assert_eq!(index.search(&["보고서".to_string()], 10, |_, _| true).1, 1);
        index.upsert(r"c:\docs", "새 보고서.HWP", 99, 3, false);
        let (hits, total) = index.search(&["보고서".to_string()], 10, |_, _| true);
        assert_eq!((total, index.entries[hits[0] as usize].size), (1, 99));

        index.remove(r"C:\Docs", "새 보고서.hwp");
        assert_eq!(index.search(&["보고서".to_string()], 10, |_, _| true).1, 0);
        // Removing a folder hides what was inside it, and saving drops them.
        index.remove(r"C:\Docs", "Project");
        assert_eq!(index.search(&["plan".to_string()], 10, |_, _| true).1, 0);
        let file = std::env::temp_dir().join(format!("dawith-live-{}.bin", std::process::id()));
        index.save(&file).unwrap();
        let loaded = FastIndex::load(&file).unwrap();
        let _ = fs::remove_file(&file);
        assert_eq!(loaded.entries.len(), 0);
    }

    #[test]
    fn search_sorts_filters_and_survives_save_load() {
        let mut index = FastIndex::default();
        let docs = index.add_dir(r"C:\Users\me\Documents");
        let desk = index.add_dir(r"C:\Users\me\Desktop");
        index.push(docs, "2026 보고서.hwp", 10, 1, false);
        index.push(desk, "돌봄 대응 안내문.HWP", 20, 2, false);
        index.push(docs, "보고서 모음", 0, 3, true);
        index.push(desk, "Photo.png", 30, 4, false);

        let (hits, total) = index.search(&["보고서".to_string()], 10, |_, _| true);
        assert_eq!(total, 2);
        let names: Vec<&str> = hits.iter().map(|i| index.entries[*i as usize].name.as_ref()).collect();
        // A name that starts with the word ranks above one that has it later.
        assert_eq!(names, vec!["보고서 모음", "2026 보고서.hwp"]);

        // Case-insensitive, with a caller filter.
        let (hits, _) = index.search(&["hwp".to_string()], 10, |_, entry| !entry.is_dir);
        assert_eq!(hits.len(), 2);
        let (hits, total) = index.search(&[], 1, |_, _| true);
        assert_eq!((hits.len(), total), (1, 4));
        assert_eq!(index.full_path(&index.entries[1]), r"C:\Users\me\Desktop\돌봄 대응 안내문.HWP");

        let file = std::env::temp_dir().join(format!("dawith-fastindex-{}.bin", std::process::id()));
        index.save(&file).unwrap();
        let loaded = FastIndex::load(&file).unwrap();
        let _ = fs::remove_file(&file);
        assert_eq!(loaded.entries.len(), 4);
        assert_eq!(loaded.dirs.len(), 2);
        let (hits, _) = loaded.search(&["대응".to_string()], 10, |_, _| true);
        assert_eq!(loaded.full_path(&loaded.entries[hits[0] as usize]), r"C:\Users\me\Desktop\돌봄 대응 안내문.HWP");
        assert_eq!(loaded.entries[hits[0] as usize].size, 20);
    }
}
