const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const { QueryParser } = require('./query-parser');
const { getFullPath } = require('./path-utils');

const WINDOWS_SORT_FIELDS = new Set(['name', 'path', 'size', 'mtime', 'ext']);
const NATIVE_UNSUPPORTED_FILTERS = /(?:^|\s)(?:content|tag|tags|star|starred|dupe):/i;

const NATIVE_CATEGORY_EXTENSIONS = {
  doc: ['doc', 'docx', 'pdf', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'hwp', 'hwpx', 'csv', 'rtf', 'odt', 'ods', 'odp', 'md'],
  document: ['doc', 'docx', 'pdf', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'hwp', 'hwpx', 'csv', 'rtf', 'odt', 'ods', 'odp', 'md'],
  pic: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'tiff', 'heic', 'raw', 'psd', 'ai'],
  picture: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'tiff', 'heic', 'raw', 'psd', 'ai'],
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'tiff', 'heic', 'raw', 'psd', 'ai'],
  video: ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', '3gp', 'ts', 'mts'],
  audio: ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma', 'opus', 'alac', 'mid', 'midi'],
  zip: ['zip', '7z', 'rar', 'tar', 'gz', 'bz2', 'xz', 'iso', 'tgz', 'cab', 'jar'],
  compressed: ['zip', '7z', 'rar', 'tar', 'gz', 'bz2', 'xz', 'iso', 'tgz', 'cab', 'jar'],
  exe: ['exe', 'msi', 'bat', 'cmd', 'ps1', 'sh', 'com', 'vbs', 'reg', 'app'],
  executable: ['exe', 'msi', 'bat', 'cmd', 'ps1', 'sh', 'com', 'vbs', 'reg', 'app']
};

function translateNativeQuery(query) {
  return String(query || '').replace(
    /(^|\s)(doc|document|pic|picture|image|video|audio|zip|compressed|exe|executable):/gi,
    (match, prefix, category) => `${prefix}ext:${NATIVE_CATEGORY_EXTENSIONS[category.toLowerCase()].join(';')}`
  );
}

function parseJsonOutput(stdout) {
  const text = String(stdout || '').replace(/^\uFEFF/, '').trim();
  if (!text) return [];

  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed.results)) return parsed.results;
    if (Array.isArray(parsed.items)) return parsed.items;
    return [];
  } catch (error) {
    const jsonLines = [];
    const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    for (const line of lines) {
      try {
        const parsedLine = JSON.parse(line);
        if (parsedLine && typeof parsedLine === 'object') jsonLines.push(parsedLine);
      } catch (lineError) {
        // Continue below with the legacy plain-path fallback.
        jsonLines.length = 0;
        break;
      }
    }
    return jsonLines.length > 0 ? jsonLines : lines.map(line => ({ path: line.replace(/^"|"$/g, '') }));
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
    if (options.forceLocal || NATIVE_UNSUPPORTED_FILTERS.test(query)) return false;
    if (this.platform === 'win32') return Boolean(this.esPath);
    if (this.platform !== 'darwin') return false;

    // Spotlight is used as a candidate finder; QueryParser still applies the
    // exact extension/type/date/size semantics after paths are returned.
    return true;
  }

  async search(query, options = {}, roots = []) {
    if (!this.supports(query, options)) {
      return { supported: false };
    }

    if (this.platform === 'win32') {
      return this.searchEverything(translateNativeQuery(query), options);
    }
    return this.searchSpotlight(query, options, roots);
  }

  searchEverything(query, options) {
    const timeoutMs = Math.max(1000, Math.min(30000, Number(options.timeoutMs) || 8000));
    const args = [
      '-json',
      '-no-header',
      '-timeout',
      String(timeoutMs),
      '-n',
      String(Math.max(1, options.limit || 1000))
    ];
    if (String(query || '').trim()) args.push(query);
    return new Promise(resolve => {
      this.spawn(this.esPath, args, {
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

    // Do not enumerate an entire home directory just to render the empty
    // initial state. The first real query is delegated to Spotlight below.
    if (parsed.isEmpty) return { supported: true, backend: 'spotlight', records: [] };

    const expression = buildSpotlightExpression(parsed);
    const nameTerm = parsed.terms && parsed.terms.length === 1
      && parsed.terms[0].length === 1
      && !parsed.terms[0][0].isNegated
      && !parsed.terms[0][0].hasWildcard
      ? parsed.terms[0][0].text
      : null;
    const limit = Math.max(1, Number(options.limit) || 1000);
    for (const root of searchRoots) {
      if (records.length >= limit) break;
      const result = await new Promise(resolve => {
        const args = ['-onlyin', root];
        // `-name` is much faster for the common filename query. Extension
        // and type filters are still enforced by QueryParser.matches below.
        if (nameTerm) args.push('-name', nameTerm);
        else args.push(expression);
        this.spawn('mdfind', args, {
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
        if (QueryParser.matches(record, parsed)) {
          records.push(record);
          if (records.length >= limit) break;
        }
      }
    }

    return { supported: true, backend: 'spotlight', records: records.slice(0, limit) };
  }
}

function escapeSpotlight(value) {
  return String(value || '').replace(/([\\"'])/g, '\\$1');
}

function buildSpotlightExpression(parsed) {
  const clauses = [];
  for (const group of parsed.terms || []) {
    const positive = group
      .filter(clause => !clause.isNegated && !clause.hasWildcard)
      .map(clause => `kMDItemFSName == "*${escapeSpotlight(clause.text)}*"cd`);
    if (positive.length > 0) clauses.push(positive.length === 1 ? positive[0] : `(${positive.join(' || ')})`);
  }

  if (Array.isArray(parsed.extensions) && parsed.extensions.length > 0) {
    const extensions = [...new Set(parsed.extensions)].map(ext =>
      `kMDItemFSName == "*.${escapeSpotlight(ext)}"cd`
    );
    clauses.push(extensions.length === 1 ? extensions[0] : `(${extensions.join(' || ')})`);
  }

  if (parsed.type === 'folder') clauses.push('kMDItemContentTypeTree == "public.folder"');
  if (clauses.length === 0) return 'kMDItemFSName == "*"cd';
  return clauses.length === 1 ? clauses[0] : `(${clauses.join(' && ')})`;
}

module.exports = {
  NativeSearchAdapter,
  normalizeEverythingRecord,
  parseJsonOutput,
  translateNativeQuery,
  buildSpotlightExpression
};
