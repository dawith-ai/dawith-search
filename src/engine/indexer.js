const fs = require('fs');
const path = require('path');
const os = require('os');
const EventEmitter = require('events');
const { fdir } = require('fdir');
const { QueryParser } = require('./query-parser');
const FileWatcher = require('./file-watcher');
const TagManager = require('./tag-manager');
const ContentSearcher = require('./content-search');
const { NativeSearchAdapter } = require('./native-search');
const { getFullPath, normalizePathKey } = require('./path-utils');
const { ensurePrivateDirectory, readJsonWithBackup, writeJsonAtomic } = require('./storage-utils');

class Indexer extends EventEmitter {
  constructor(options = {}) {
    super();
    this.storageDir = options.storageDir || path.join(os.homedir(), '.dawith-search');
    this.cacheFile = path.join(this.storageDir, 'index-cache.json');
    this.configFile = path.join(this.storageDir, 'config.json');

    this.tagManager = new TagManager(this.storageDir);
    this.fileWatcher = new FileWatcher({ ignored: this.getIgnoredPaths() });
    this.nativeSearch = options.nativeSearch || new NativeSearchAdapter({
      platform: options.platform,
      esPath: options.esPath
    });
    this.saveTimer = null;

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
      autoStartWatcher: true,
      searchBackend: 'auto'
    };

    if (fs.existsSync(this.configFile)) {
      try {
        const raw = readJsonWithBackup(this.configFile, null);
        if (raw) return { ...defaults, ...raw };
      } catch (e) {
        return defaults;
      }
    }
    return defaults;
  }

  saveConfig() {
    try {
      writeJsonAtomic(this.configFile, this.config);
    } catch (e) {
      console.error('Failed to save config:', e);
    }
  }

  getDefaultRoots() {
    const userProfile = os.homedir();
    const candidateDirs = [
      path.join(userProfile, 'Desktop'),
      path.join(userProfile, 'Documents'),
      path.join(userProfile, 'Downloads'),
      path.join(userProfile, 'Pictures'),
      path.join(userProfile, 'Videos'),
      path.join(userProfile, 'Music'),
      path.join(userProfile, 'Movies')
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

  getIgnoredPaths() {
    return (filePath) => {
      const excluded = new Set(((this.config && this.config.excludeFolders) || []).map(item => String(item).toLowerCase()));
      const segments = filePath.split(/[\\/]/).filter(Boolean);
      const name = path.basename(filePath);
      if (this.config && this.config.excludeHidden && name.startsWith('.')) return true;
      return segments.some(segment => excluded.has(segment.toLowerCase()));
    };
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
      const data = readJsonWithBackup(this.cacheFile, null);
      if (!data) return false;
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
      ensurePrivateDirectory(this.storageDir);
      writeJsonAtomic(this.cacheFile, {
        savedAt: Date.now(),
        records: this.records
      });
    } catch (e) {
      console.error('Failed to save cache:', e);
    }
  }

  rebuildMap() {
    this.recordMap.clear();
    for (let i = 0; i < this.records.length; i++) {
      const rec = this.records[i];
      const fullPath = getFullPath(rec);
      this.recordMap.set(normalizePathKey(fullPath), i);
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
    try {
      for (const root of this.config.roots) {
        if (!fs.existsSync(root)) continue;
        await this.scanRoot(root, newRecords);
      }

      this.records = newRecords;
      this.rebuildMap();
      this.updateStats();
      this.stats.lastIndexedAt = Date.now();
      this.saveCache();
      this.emit('indexing-finished', {
        totalFiles: this.stats.totalFiles,
        totalFolders: this.stats.totalFolders,
        totalBytes: this.stats.totalBytes
      });

      if (this.config.autoStartWatcher) {
        this.fileWatcher.watch(this.config.roots);
      }
    } catch (error) {
      this.emit('indexing-error', error);
      throw error;
    } finally {
      this.isIndexing = false;
    }
  }

  async scanRoot(root, outputArray) {
    const crawler = new fdir()
      .withFullPaths()
      .withDirs()
      .withMaxDepth(this.config.maxDepth)
      .exclude((dirName) => this.shouldExcludeName(dirName));

    const paths = await crawler.crawl(root).withPromise();
    const records = await Promise.all(paths.map(itemPath => this.createRecord(itemPath)));
    outputArray.push(...records.filter(Boolean));
  }

  shouldExcludeName(name) {
    if (this.config.excludeHidden && name.startsWith('.')) return true;
    return this.config.excludeFolders.some(excluded => name.toLowerCase() === String(excluded).toLowerCase());
  }

  async createRecord(fullPath) {
    const name = path.basename(fullPath);
    if (this.shouldExcludeName(name)) return null;

    let stat;
    try {
      stat = await fs.promises.stat(fullPath);
    } catch (error) {
      return null;
    }

    const isDir = stat.isDirectory();
    return {
      name,
      path: path.dirname(fullPath),
      fullPath,
      size: isDir ? 0 : stat.size,
      mtime: stat.mtimeMs,
      ctime: stat.birthtimeMs || stat.ctimeMs,
      isDir,
      ext: isDir ? '' : path.extname(name).replace(/^\./, '').toLowerCase(),
      tags: this.tagManager.getTags(fullPath),
      starred: this.tagManager.isStarred(fullPath)
    };
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
        fullPath,
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
    const key = normalizePathKey(fullPath);
    if (this.recordMap.has(key)) return;

    const dir = path.dirname(fullPath);
    const name = path.basename(fullPath);
    const ext = isDir ? '' : path.extname(name).replace(/^\./, '').toLowerCase();

    const record = {
      name,
      path: dir,
      fullPath,
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
    this.scheduleCacheSave();
    this.emit('file-updated', { type: 'created', fullPath });
  }

  onFileChanged(fullPath, stats) {
    const key = normalizePathKey(fullPath);
    const idx = this.recordMap.get(key);
    if (idx !== undefined && this.records[idx]) {
      if (stats) {
        this.records[idx].size = stats.size;
        this.records[idx].mtime = stats.mtimeMs;
      }
      this.scheduleCacheSave();
      this.emit('file-updated', { type: 'changed', fullPath });
    }
  }

  onFileDeleted(fullPath) {
    const key = normalizePathKey(fullPath);
    const idx = this.recordMap.get(key);
    if (idx !== undefined && this.records[idx]) {
      this.records.splice(idx, 1);
      this.rebuildMap();
      this.updateStats();
      this.scheduleCacheSave();
      this.emit('file-updated', { type: 'deleted', fullPath });
    }
  }

  /**
   * Fast Everything-compatible Search
   */
  async search(queryString, options = {}) {
    const start = Date.now();
    const parsed = QueryParser.parse(queryString, options);
    const scopeRoot = options.scopeRoot ? path.resolve(String(options.scopeRoot)) : null;

    if (this.config.searchBackend !== 'local' && !options.forceLocal && !scopeRoot) {
      const nativeResult = await this.nativeSearch.search(parsed.raw, options, this.config.roots);
      if (nativeResult.supported) {
        const nativeRecords = nativeResult.records.map(item => ({
          ...item,
          fullPath: getFullPath(item),
          tags: this.tagManager.getTags(getFullPath(item)),
          starred: this.tagManager.isStarred(getFullPath(item))
        }));
        const scopedNativeRecords = nativeRecords.filter(item => this.isWithinConfiguredRoot(getFullPath(item)));
        const sorted = this.sortResults(scopedNativeRecords, options);
        return {
          results: sorted.slice(0, options.limit || 5000),
          totalMatches: sorted.length,
          totalIndexed: this.records.length,
          elapsedMs: Date.now() - start,
          parsedQuery: parsed,
          backend: nativeResult.backend,
          warning: nativeResult.warning || null
        };
      }
    }

    let matched = [];
    const limit = options.limit || 5000;

    // Check if query is duplicate check
    if (parsed.dupe) {
      const scopedRecords = scopeRoot
        ? this.records.filter(item => this.isWithinScope(getFullPath(item), scopeRoot))
        : this.records;
      matched = this.findDuplicatesQuick(parsed.dupe, scopedRecords);
    } else {
      for (let i = 0; i < this.records.length; i++) {
        const item = this.records[i];
        if (scopeRoot && !this.isWithinScope(getFullPath(item), scopeRoot)) continue;
        if (QueryParser.matches(item, parsed)) {
          matched.push(item);
          if (!parsed.content && matched.length >= limit) break;
        }
      }
    }

    // Handle content search if requested
    if (parsed.content) {
      const contentFiltered = [];
      for (const item of matched) {
        if (item.isDir) continue;
        const full = getFullPath(item);
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

    matched = this.sortResults(matched, options);

    const elapsedMs = Date.now() - start;
    return {
      results: matched.slice(0, limit),
      totalMatches: matched.length,
      totalIndexed: this.records.length,
      elapsedMs,
      parsedQuery: parsed,
      backend: 'local'
    };
  }

  isWithinScope(fullPath, scopeRoot) {
    const fileKey = normalizePathKey(path.resolve(fullPath));
    const rootKey = normalizePathKey(path.resolve(scopeRoot));
    const separator = path.sep;
    return fileKey === rootKey || fileKey.startsWith(`${rootKey}${separator}`);
  }

  isWithinConfiguredRoot(fullPath) {
    return (this.config.roots || []).some(root => this.isWithinScope(fullPath, root));
  }

  sortResults(items, options = {}) {
    const sortBy = options.sortBy || 'name';
    const sortOrder = options.sortOrder === 'desc' ? -1 : 1;
    return [...items].sort((a, b) => {
      const valA = a[sortBy] ?? '';
      const valB = b[sortBy] ?? '';
      if (typeof valA === 'string' || typeof valB === 'string') {
        return String(valA).localeCompare(String(valB), undefined, { numeric: true, sensitivity: 'base' }) * sortOrder;
      }
      if (valA < valB) return -1 * sortOrder;
      if (valA > valB) return 1 * sortOrder;
      return 0;
    });
  }

  scheduleCacheSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveCache(), 250);
  }

  findDuplicatesQuick(by = 'name', records = this.records) {
    const map = new Map();
    const dupes = [];

    for (const item of records) {
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
