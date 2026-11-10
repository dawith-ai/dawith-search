// Dawith's own file index: a compact in-memory table of every file name,
// searched on all CPU cores, and saved to disk so the next start is instant.
//
// Each entry keeps only what the result list needs. Folder paths are stored
// once and shared by index, and lowercased names are precomputed so a search
// is nothing but substring checks over a flat array.
use rayon::prelude::*;
use std::cmp::Ordering;
use std::fs;
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::Path;

pub struct Entry {
    pub name: Box<str>,
    pub lower: Box<str>,
    pub dir: u32,
    pub size: u64,
    pub mtime: u64,
    pub is_dir: bool,
}

#[derive(Default)]
pub struct FastIndex {
    pub dirs: Vec<Box<str>>,
    pub entries: Vec<Entry>,
}

const MAGIC: &[u8; 8] = b"DWSIDX01";

impl FastIndex {
    pub fn add_dir(&mut self, path: &str) -> u32 {
        self.dirs.push(path.into());
        (self.dirs.len() - 1) as u32
    }

    pub fn push(&mut self, dir: u32, name: &str, size: u64, mtime: u64, is_dir: bool) {
        self.entries.push(Entry { name: name.into(), lower: name.to_lowercase().into(), dir, size, mtime, is_dir });
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
        let mut hits: Vec<u32> = self
            .entries
            .par_iter()
            .enumerate()
            .filter(|(_, entry)| terms.iter().all(|term| entry.lower.contains(term.as_str())) && keep(self, entry))
            .map(|(index, _)| index as u32)
            .collect();
        let total = hits.len();
        let by_name = |a: &u32, b: &u32| -> Ordering {
            let (a, b) = (&self.entries[*a as usize], &self.entries[*b as usize]);
            a.lower.cmp(&b.lower).then_with(|| a.dir.cmp(&b.dir))
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
            write_u32(&mut out, self.entries.len() as u32)?;
            for entry in &self.entries {
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
            .map(|(name, dir, size, mtime, is_dir)| Entry { lower: name.to_lowercase().into(), name: name.into(), dir, size, mtime, is_dir })
            .collect();
        Ok(FastIndex { dirs, entries })
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
        assert_eq!(names, vec!["2026 보고서.hwp", "보고서 모음"]);

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
