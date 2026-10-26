const fs = require('fs');
const path = require('path');
const os = require('os');
const EventEmitter = require('events');
const { QueryParser } = require('./query-parser');
const FileWatcher = require('./file-watcher');
const TagManager = require('./tag-manager');
const ContentSearcher = require('./content-search');

class Indexer extends EventEmitter {
  constructor(options = {}) {
    super();
    this.storageDir = options.storageDir || path.join(os.homedir(), '.dawith-search');
    this.cacheFile = path.join(this.storageDir, 'index-cache.json');
    this.configFile = path.join(this.storageDir, 'config.json');

    this.tagManager = new TagManager(this.storageDir);
    this.fileWatcher = new FileWatcher();

    // In-memory index
    this.records = []; // Array of file records
    this.recordMap = new Map(); // fullPath -> index in this.records

    // Configuration
    this.config = this.loadConfig();
    this.isIndexing = false;
    this.stats = {
      totalFiles: 0,
      totalFolders: 0,
      totalBytes: 0,
      lastIndexedAt: null
    };

    this.setupWatcher();
  }

  loadConfig() {
    const defaults = {
      roots: this.getDefaultRoots(),
      excludeFolders: [
        'node_modules',
        '.git',
        '.gemini',
        '.cache',
        '.npm',
        '.nuget',
        '.next',
        'AppData',
        '$Recycle.Bin',
        'System Volume Information',
        '__pycache__',
        'Temp',
        'Cache'
      ],
      excludeHidden: true,
      maxDepth: 12,
      autoStartWatcher: true
    };

    if (fs.existsSync(this.configFile)) {
      try {
        const raw = fs.readFileSync(this.configFile, 'utf8');
        return { ...defaults, ...JSON.parse(raw) };
      } catch (e) {
        return defaults;
      }
    }
    return defaults;
  }

  saveConfig() {
    try {
      if (!fs.existsSync(this.storageDir)) {
        fs.mkdirSync(this.storageDir, { recursive: true });
      }
      fs.writeFileSync(this.configFile, JSON.stringify(this.config, null, 2), 'utf8');
    } catch (e) {
      console.error('Failed to save config:', e);
    }
  }

  getDefaultRoots() {
    const userProfile = process.env.USERPROFILE || os.homedir();
    const candidateDirs = [
      path.join(userProfile, 'Desktop'),
      path.join(userProfile, 'Documents'),
      path.join(userProfile, 'Downloads'),
      path.join(userProfile, 'Pictures'),
      path.join(userProfile, 'Videos'),
      path.join(userProfile, 'Music'),
      'C:\\Users\\jhpar\\orca'
    ];

    const roots = [];
    for (const d of candidateDirs) {
      if (fs.existsSync(d) && !roots.includes(d)) {
        roots.push(d);
      }
    }

    if (roots.length === 0) roots.push(userProfile);
    return roots;
  }

  setupWatcher() {
    this.fileWatcher.on('file-added', (filePath, stats) => this.onFileCreated(filePath, stats, false));
    this.fileWatcher.on('folder-added', (dirPath, stats) => this.onFileCreated(dirPath, stats, true));
    this.fileWatcher.on('file-changed', (filePath, stats) => this.onFileChanged(filePath, stats));
    this.fileWatcher.on('file-deleted', (filePath) => this.onFileDeleted(filePath));
    this.fileWatcher.on('folder-deleted', (dirPath) => this.onFileDeleted(dirPath));
  }

  loadCache() {
    if (!fs.existsSync(this.cacheFile)) return false;
    try {
      const raw = fs.readFileSync(this.cacheFile, 'utf8');
      const data = JSON.parse(raw);
      this.records = data.records || [];
      this.rebuildMap();
      this.updateStats();
      this.emit('status', { status: 'loaded_cache', count: this.records.length });
      return true;
    } catch (e) {
      console.error('Failed to load cache:', e);
      return false;
    }
  }

  saveCache() {
    try {
      if (!fs.existsSync(this.storageDir)) {
        fs.mkdirSync(this.storageDir, { recursive: true });
      }
      fs.writeFileSync(this.cacheFile, JSON.stringify({
        savedAt: Date.now(),
        records: this.records
      }), 'utf8');
    } catch (e) {
      console.error('Failed to save cache:', e);
    }
  }

  rebuildMap() {
    this.recordMap.clear();
    for (let i = 0; i < this.records.length; i++) {
      const rec = this.records[i];
      const fullPath = path.join(rec.path, rec.name);
      this.recordMap.set(fullPath.toLowerCase(), i);
    }
  }

  updateStats() {
    let files = 0;
    let folders = 0;
    let bytes = 0;
    for (const r of this.records) {
      if (r.isDir) {
        folders++;
      } else {
        files++;
        bytes += r.size;
      }
    }
    this.stats.totalFiles = files;
    this.stats.totalFolders = folders;
    this.stats.totalBytes = bytes;
  }

  /**
   * Scan all configured roots asynchronously
   */
  async startIndexing() {
    if (this.isIndexing) return;
    this.isIndexing = true;
    this.emit('indexing-started');

    const newRecords = [];
    const roots = this.config.roots;

    for (const root of roots) {
      if (!fs.existsSync(root)) continue;
      await this.scanDirectory(root, newRecords, 0, this.config.maxDepth);
    }

    this.records = newRecords;
    this.rebuildMap();
    this.updateStats();
    this.stats.lastIndexedAt = Date.now();
    this.isIndexing = false;

    this.saveCache();
    this.emit('indexing-finished', {
      totalFiles: this.stats.totalFiles,
      totalFolders: this.stats.totalFolders,
      totalBytes: this.stats.totalBytes
    });

    if (this.config.autoStartWatcher) {
      this.fileWatcher.watch(this.config.roots);
    }
  }

  async scanDirectory(dir, outputArray, depth, maxDepth) {
    if (depth > maxDepth) return;

    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (e) {
      return; // permission denied or busy
    }

    const subdirs = [];

    for (const entry of entries) {
      const name = entry.name;
      
      // Hidden folder / file check
      if (this.config.excludeHidden && name.startsWith('.')) {
        continue;
      }

      // Exclusion list
      const lowerName = name.toLowerCase();
      if (this.config.excludeFolders.some(ex => lowerName === ex.toLowerCase())) {
        continue;
      }

      const isDir = entry.isDirectory();
      const fullPath = path.join(dir, name);
      let size = 0;
      let mtime = Date.now();
      let ctime = Date.now();

      try {
        const stat = await fs.promises.stat(fullPath);
        size = isDir ? 0 : stat.size;
        mtime = stat.mtimeMs;
        ctime = stat.birthtimeMs || stat.ctimeMs;
      } catch (e) {
        // Skip inaccessible items
      }

      const ext = isDir ? '' : path.extname(name).replace(/^\./, '').toLowerCase();
      const tags = this.tagManager.getTags(fullPath);
      const starred = this.tagManager.isStarred(fullPath);

      outputArray.push({
        name,
        path: dir,
        size,
        mtime,
        ctime,
        isDir,
        ext,
        tags,
        starred
      });

      if (isDir) {
        subdirs.push(fullPath);
      }
    }

    // Recurse into subdirectories
    for (const sub of subdirs) {
      await this.scanDirectory(sub, outputArray, depth + 1, maxDepth);
    }
  }

  onFileCreated(fullPath, stats, isDir) {
    const key = fullPath.toLowerCase();
    if (this.recordMap.has(key)) return;

    const dir = path.dirname(fullPath);
    const name = path.basename(fullPath);
    const ext = isDir ? '' : path.extname(name).replace(/^\./, '').toLowerCase();

    const record = {
      name,
      path: dir,
      size: stats ? stats.size : 0,
      mtime: stats ? stats.mtimeMs : Date.now(),
      ctime: stats ? (stats.birthtimeMs || stats.ctimeMs) : Date.now(),
      isDir,
      ext,
      tags: this.tagManager.getTags(fullPath),
      starred: this.tagManager.isStarred(fullPath)
    };

    const newIdx = this.records.length;
    this.records.push(record);
    this.recordMap.set(key, newIdx);
    this.updateStats();
    this.emit('file-updated', { type: 'created', fullPath });
  }

  onFileChanged(fullPath, stats) {
    const key = fullPath.toLowerCase();
    const idx = this.recordMap.get(key);
    if (idx !== undefined && this.records[idx]) {
      if (stats) {
        this.records[idx].size = stats.size;
        this.records[idx].mtime = stats.mtimeMs;
      }
      this.emit('file-updated', { type: 'changed', fullPath });
    }
  }

  onFileDeleted(fullPath) {
    const key = fullPath.toLowerCase();
    const idx = this.recordMap.get(key);
    if (idx !== undefined && this.records[idx]) {
      this.records.splice(idx, 1);
      this.rebuildMap();
      this.updateStats();
      this.emit('file-updated', { type: 'deleted', fullPath });
    }
  }

  /**
   * Fast Everything-compatible Search
   */
  async search(queryString, options = {}) {
    const start = Date.now();
    const parsed = QueryParser.parse(queryString, options);

    let matched = [];
    const limit = options.limit || 5000;

    // Check if query is duplicate check
    if (parsed.dupe) {
      matched = this.findDuplicatesQuick(parsed.dupe);
    } else {
      for (let i = 0; i < this.records.length; i++) {
        const item = this.records[i];
        if (QueryParser.matches(item, parsed)) {
          matched.push(item);
          if (matched.length >= limit) break;
        }
      }
    }

    // Handle content search if requested
    if (parsed.content) {
      const contentFiltered = [];
      for (const item of matched) {
        if (item.isDir) continue;
        const full = path.join(item.path, item.name);
        const hasContent = await ContentSearcher.matchesContent(full, item.ext, parsed.content, parsed.caseSensitive);
        if (hasContent) {
          contentFiltered.push(item);
        }
      }
      matched = contentFiltered;
    }

    // Sort results
    const sortBy = options.sortBy || 'name'; // 'name', 'path', 'size', 'mtime', 'ext'
    const sortOrder = options.sortOrder === 'desc' ? -1 : 1;

    matched.sort((a, b) => {
      let valA = a[sortBy];
      let valB = b[sortBy];
      if (typeof valA === 'string') {
        return valA.localeCompare(valB) * sortOrder;
      }
      if (valA < valB) return -1 * sortOrder;
      if (valA > valB) return 1 * sortOrder;
      return 0;
    });

    const elapsedMs = Date.now() - start;
    return {
      results: matched.slice(0, limit),
      totalMatches: matched.length,
      totalIndexed: this.records.length,
      elapsedMs,
      parsedQuery: parsed
    };
  }

  findDuplicatesQuick(by = 'name') {
    const map = new Map();
    const dupes = [];

    for (const item of this.records) {
      if (item.isDir) continue;
      const key = by === 'size' ? item.size : item.name.toLowerCase();
      if (key === 0 && by === 'size') continue; // ignore empty files

      if (map.has(key)) {
        map.get(key).push(item);
      } else {
        map.set(key, [item]);
      }
    }

    for (const list of map.values()) {
      if (list.length > 1) {
        dupes.push(...list);
      }
    }
    return dupes;
  }
}

module.exports = Indexer;
