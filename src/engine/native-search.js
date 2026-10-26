const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const { QueryParser } = require('./query-parser');
const { getFullPath } = require('./path-utils');

const WINDOWS_SORT_FIELDS = new Set(['name', 'path', 'size', 'mtime', 'ext']);
const NATIVE_UNSUPPORTED_FILTERS = /(?:^|\s)(?:content|tag|tags|star|starred|dupe):/i;

function parseJsonOutput(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return [];

  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed.results)) return parsed.results;
    if (Array.isArray(parsed.items)) return parsed.items;
    return [];
  } catch (error) {
    return text.split(/\r?\n/).filter(Boolean).map(line => ({ path: line }));
  }
}

function parseTimestamp(value) {
  if (typeof value === 'number') {
    if (value > 1e16) return (value - 116444736000000000) / 10000;
    return value > 1e12 ? value : value * 1000;
  }
  if (!value) return 0;
  if (/^\d+$/.test(String(value))) {
    return parseTimestamp(Number(value));
  }
  const timestamp = Date.parse(String(value));
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function portableBasename(value) {
  return String(value || '').replace(/[\\/]$/, '').split(/[\\/]/).pop() || '';
}

function portableDirname(value) {
  const clean = String(value || '').replace(/[\\/]$/, '');
  const separatorIndex = Math.max(clean.lastIndexOf('\\'), clean.lastIndexOf('/'));
  return separatorIndex >= 0 ? clean.slice(0, separatorIndex) || clean.slice(0, 1) : '';
}

function portableJoin(directory, name) {
  const base = String(directory || '');
  return /\\|^[A-Za-z]:/.test(base)
    ? path.win32.join(base, name)
    : path.join(base, name);
}

function normalizeEverythingRecord(raw) {
  const rawPath = String(raw.path || raw.full_path || raw.filename || raw.name || '');
  const name = raw.name || raw.filename || portableBasename(rawPath);
  const directory = raw.path && raw.name
    ? String(raw.path).replace(/[\\/]$/, '')
    : portableDirname(rawPath);
  const fullPath = raw.fullPath || raw.full_path || (directory && name ? portableJoin(directory, name) : rawPath);
  const isDir = Boolean(raw.isDir || raw.is_directory || raw.directory || raw.attributes === 16 || /[\\/]$/.test(rawPath));

  return {
    name,
    path: directory,
    fullPath,
    size: Number(String(raw.size || raw.length || 0).replace(/,/g, '')) || 0,
    mtime: parseTimestamp(raw.mtime || raw.mtimeMs || raw.date_modified || raw.dateModified),
    ctime: parseTimestamp(raw.ctime || raw.ctimeMs || raw.date_created || raw.dateCreated),
    isDir,
    ext: isDir ? '' : path.extname(name).replace(/^\./, '').toLowerCase(),
    tags: [],
    starred: false
  };
}

class NativeSearchAdapter {
  constructor(options = {}) {
    this.platform = options.platform || process.platform;
    this.spawn = options.spawn || execFile;
    this.execFileSync = options.execFileSync || execFileSync;
    this.esPath = options.esPath || this.findEverythingCli();
  }

  findEverythingCli() {
    if (this.platform !== 'win32') return null;

    const candidates = [
      process.env.DAWITH_ES_PATH,
      process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'Everything', 'es.exe') : null,
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Everything', 'es.exe') : null,
      'es.exe'
    ].filter(Boolean);

    for (const candidate of candidates) {
      if (candidate === 'es.exe') {
        try {
          const resolved = this.execFileSync('where', ['es.exe'], { encoding: 'utf8', windowsHide: true }).trim();
          if (resolved) return resolved.split(/\r?\n/)[0];
        } catch (error) {
          continue;
        }
      } else if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  getStatus() {
    if (this.platform === 'win32') {
      return {
        backend: this.esPath ? 'everything' : 'local',
        label: this.esPath ? 'Everything 연결됨' : '로컬 색인 모드',
        available: Boolean(this.esPath),
        detail: this.esPath || 'es.exe를 찾지 못해 자체 색인을 사용합니다.'
      };
    }
    if (this.platform === 'darwin') {
      return {
        backend: 'spotlight',
        label: 'Spotlight 연동',
        available: true,
        detail: '단순 검색은 macOS Spotlight, 복합 검색은 로컬 색인을 사용합니다.'
      };
    }
    return {
      backend: 'local',
      label: '로컬 색인 모드',
      available: false,
      detail: `${this.platform}에서는 자체 색인을 사용합니다.`
    };
  }

  supports(query, options = {}) {
    if (!query || options.forceLocal || NATIVE_UNSUPPORTED_FILTERS.test(query)) return false;
    if (this.platform === 'win32') return Boolean(this.esPath);
    if (this.platform !== 'darwin') return false;

    // Spotlight's -interpret mode is intentionally limited to plain text.
    // Everything-specific operators remain on the deterministic local parser.
    return /^[\p{L}\p{N}._\-\s]+$/u.test(query.trim());
  }

  async search(query, options = {}, roots = []) {
    if (!this.supports(query, options)) {
      return { supported: false };
    }

    if (this.platform === 'win32') {
      return this.searchEverything(query, options);
    }
    return this.searchSpotlight(query, options, roots);
  }

  searchEverything(query, options) {
    const args = ['-json', '-no-header', '-n', String(Math.max(1, options.limit || 1000))];
    return new Promise(resolve => {
      this.spawn(this.esPath, [...args, query], {
        windowsHide: true,
        timeout: options.timeoutMs || 8000,
        maxBuffer: 16 * 1024 * 1024
      }, (error, stdout, stderr) => {
        if (error && !stdout) {
          resolve({ supported: false, error: error.message, stderr });
          return;
        }

        const records = parseJsonOutput(stdout).map(normalizeEverythingRecord).filter(record => record.fullPath);
        resolve({
          supported: true,
          backend: 'everything',
          records,
          warning: error ? String(stderr || error.message || '').trim() : null
        });
      });
    });
  }

  async searchSpotlight(query, options, roots) {
    const searchRoots = Array.isArray(roots) && roots.length > 0 ? roots : [os.homedir()];
    const records = [];
    const parsed = QueryParser.parse(query, options);

    for (const root of searchRoots) {
      const result = await new Promise(resolve => {
        const expression = `kMDItemFSName == "*${query.replace(/"/g, '')}*"cd`;
        this.spawn('mdfind', ['-onlyin', root, expression], {
          timeout: options.timeoutMs || 8000,
          maxBuffer: 16 * 1024 * 1024
        }, (error, stdout) => resolve({ error, stdout }));
      });

      if (result.error && !result.stdout) {
        return { supported: false, error: result.error.message };
      }

      for (const fullPath of String(result.stdout || '').split(/\r?\n/).filter(Boolean)) {
        let stat;
        try {
          stat = await fs.promises.stat(fullPath);
        } catch (error) {
          continue;
        }
        const record = normalizeEverythingRecord({
          name: path.basename(fullPath),
          path: path.dirname(fullPath),
          fullPath,
          size: stat.isDirectory() ? 0 : stat.size,
          mtime: stat.mtimeMs,
          ctime: stat.birthtimeMs || stat.ctimeMs,
          isDir: stat.isDirectory()
        });
        if (QueryParser.matches(record, parsed)) records.push(record);
      }
    }

    return { supported: true, backend: 'spotlight', records };
  }
}

module.exports = {
  NativeSearchAdapter,
  normalizeEverythingRecord,
  parseJsonOutput
};
