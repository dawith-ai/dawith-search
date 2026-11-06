const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const EventEmitter = require('events');
const { QueryParser } = require('./query-parser');
const FileWatcher = require('./file-watcher');
const TagManager = require('./tag-manager');
const ContentSearcher = require('./content-search');
const { NativeSearchAdapter } = require('./native-search');
const { getFullPath, normalizePathKey, isPathWithinRoot } = require('./path-utils');
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
      everythingIpcPath: options.everythingIpcPath,
      gozPath: options.gozPath,
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
    const localRoots = this.getDefaultRoots();
    const defaults = {
      roots: localRoots,
      localRoots,
      autoLocalRoots: true,
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
      // Local search should not silently stop at a shallow folder depth.
      // 64 is high enough for real Windows/macOS paths while still guarding
      // against accidental recursive directory structures.
      maxDepth: 64,
      autoStartWatcher: true,
      searchBackend: 'auto',
      uiMode: null
    };

    if (fs.existsSync(this.configFile)) {
      try {
        const raw = readJsonWithBackup(this.configFile, null);
        if (raw) {
          const rawRoots = Array.isArray(raw.roots) ? raw.roots : [];
          const legacyRoots = this.getLegacyDefaultRoots();
          const autoLocalRoots = raw.autoLocalRoots !== false;
          const effectiveLocalRoots = autoLocalRoots
            ? localRoots
            : (Array.isArray(raw.localRoots) ? raw.localRoots : []);
          const externalRoots = rawRoots.filter(root => !legacyRoots.includes(root) && !localRoots.includes(root));
          const roots = autoLocalRoots
            ? Array.from(new Set([...localRoots, ...externalRoots]))
            : rawRoots;
          return { ...defaults, ...raw, localRoots: effectiveLocalRoots, autoLocalRoots, roots };
        }
      } catch (e) {
        return defaults;
      }
    }
    return defaults;
  }

  saveConfig() {
    try {
      this.normalizeConfig();
      writeJsonAtomic(this.configFile, this.config);
    } catch (e) {
      console.error('Failed to save config:', e);
    }
  }

  getDefaultRoots() {
    const userProfile = os.homedir();
    if (process.platform === 'win32') {
      const drives = this.getWindowsLocalDrives();
      if (drives.length > 0) return drives;
    }
    return [userProfile];
  }

  getLegacyDefaultRoots() {
    const userProfile = os.homedir();
    return [
      path.join(userProfile, 'Desktop'),
      path.join(userProfile, 'Documents'),
      path.join(userProfile, 'Downloads'),
      path.join(userProfile, 'Pictures'),
      path.join(userProfile, 'Videos'),
      path.join(userProfile, 'Music'),
      path.join(userProfile, 'Movies')
    ];
  }

  getWindowsLocalDrives() {
    try {
      const output = execFileSync('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_LogicalDisk | Where-Object { $_.DriveType -eq 2 -or $_.DriveType -eq 3 } | Select-Object -ExpandProperty DeviceID'
      ], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
      return String(output).split(/\r?\n/)
        .map(value => value.trim())
        .filter(value => /^[A-Za-z]:$/.test(value))
        .map(value => `${value}\\`);
    } catch (error) {
      // PowerShell can be disabled by enterprise policy. Keep automatic
      // whole-PC scope instead of silently falling back to the user profile.
      try {
        const output = execFileSync('wmic.exe', ['logicaldisk', 'get', 'deviceid,drivetype'], {
          encoding: 'utf8',
          windowsHide: true,
          timeout: 5000
        });
        return String(output).split(/\r?\n/)
          .map(line => line.trim().split(/\s+/))
          .filter(parts => /^[A-Za-z]:$/.test(parts[0]) && (parts[1] === '2' || parts[1] === '3'))
          .map(parts => `${parts[0]}\\`);
      } catch (fallbackError) {
        const fallbackDrive = process.env.SystemDrive || process.env.HOMEDRIVE;
        return /^[A-Za-z]:$/.test(String(fallbackDrive || '').trim())
          ? [`${String(fallbackDrive).trim()}\\`]
          : [];
      }
    }
  }

  normalizeConfig() {
    if (this.config.autoLocalRoots === false) return this.config;
    const localRoots = Array.isArray(this.config.localRoots) && this.config.localRoots.length > 0
      ? this.config.localRoots
      : this.getDefaultRoots();
    this.config.localRoots = localRoots;
    this.config.roots = Array.from(new Set([
      ...localRoots,
      ...(Array.isArray(this.config.roots) ? this.config.roots : [])
    ]));
    return this.config;
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
    // A native index is already optimized for whole-device lookup. The old
    // JSON mirror is not needed when every configured root is local/native;
    // retaining hundreds of megabytes here only makes the app look heavy and
    // can cause stale local results after a reinstall. External roots still
    // keep their own lightweight cache.
    try {
      if (this.canUseNativeLocalIndex() && !this.hasExternalRoots()) {
        this.removeNativeLocalCache();
        return false;
      }
    } catch (error) {
      // Continue with the normal cache read when metadata is unavailable.
    }
    try {
      const data = readJsonWithBackup(this.cacheFile, null);
      if (!data) return false;
      if (!Array.isArray(data.roots) || JSON.stringify(data.roots) !== JSON.stringify(this.config.roots)) return false;
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
    if (this.canUseNativeLocalIndex() && !this.hasExternalRoots()) {
      return;
    }
    try {
      ensurePrivateDirectory(this.storageDir);
      writeJsonAtomic(this.cacheFile, {
        savedAt: Date.now(),
        roots: this.config.roots,
        records: this.records
      });
    } catch (e) {
      console.error('Failed to save cache:', e);
    }
  }

  hasExternalRoots() {
    const localRoots = new Set(this.config.localRoots || []);
    return (this.config.roots || []).some(root => !localRoots.has(root));
  }

  removeNativeLocalCache() {
    for (const filePath of [this.cacheFile, `${this.cacheFile}.bak`]) {
      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch (error) {
        // A locked cache must not prevent native search from starting.
      }
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
    const indexingStartedAt = Date.now();
    const configuredRoots = this.config.roots.filter(root => fs.existsSync(root));
    const localRoots = new Set(this.config.localRoots || []);
    const roots = this.canUseNativeLocalIndex()
      ? configuredRoots.filter(root => !localRoots.has(root))
      : configuredRoots;
    const scanCounters = { totalFiles: 0, totalFolders: 0, totalBytes: 0 };
    this.emit('indexing-started', {
      startedAt: indexingStartedAt,
      totalRoots: roots.length,
      roots,
      nativeRoots: configuredRoots.length - roots.length
    });

    const newRecords = [];
    // Publish an empty-but-live array immediately. Searches during a large
    // whole-drive scan should return partial results instead of staying blank.
    this.records = newRecords;
    this.rebuildMap();
    this.stats = { totalFiles: 0, totalFolders: 0, totalBytes: 0, lastIndexedAt: this.stats.lastIndexedAt };
    try {
      for (const [rootIndex, root] of roots.entries()) {
        await this.scanRoot(root, newRecords, {
          root,
          rootIndex,
          totalRoots: roots.length,
          startedAt: indexingStartedAt,
          counters: scanCounters
        });
      }

      this.records = newRecords;
      this.rebuildMap();
      this.stats.totalFiles = scanCounters.totalFiles;
      this.stats.totalFolders = scanCounters.totalFolders;
      this.stats.totalBytes = scanCounters.totalBytes;
      this.stats.lastIndexedAt = Date.now();
      this.saveCache();
      this.emit('indexing-finished', {
        totalFiles: this.stats.totalFiles,
        totalFolders: this.stats.totalFolders,
        totalBytes: this.stats.totalBytes,
        elapsedMs: Date.now() - indexingStartedAt,
        totalRoots: roots.length
      });

      if (this.config.autoStartWatcher) {
        const watchedRoots = this.canUseNativeLocalIndex()
          ? this.config.roots.filter(root => !(this.config.localRoots || []).includes(root))
          : this.config.roots;
        if (watchedRoots.length > 0) this.fileWatcher.watch(watchedRoots);
      }
    } catch (error) {
      this.emit('indexing-error', error);
      throw error;
    } finally {
      this.isIndexing = false;
    }
  }

  async scanRoot(root, outputArray, progressContext = {}) {
    // Do not use a fail-fast crawler for a whole drive. One protected
    // directory (AppData, System Volume Information, a disconnected share)
    // must not abort the complete local index.
    const startLength = outputArray.length;
    let publishedCount = outputArray.length;
    const counters = progressContext.counters || { totalFiles: 0, totalFolders: 0, totalBytes: 0 };
    const publishProgress = () => {
      if (outputArray.length - publishedCount < 2000) return;
      this.records = outputArray;
      this.stats.totalFiles = counters.totalFiles;
      this.stats.totalFolders = counters.totalFolders;
      this.stats.totalBytes = counters.totalBytes;
      publishedCount = outputArray.length;
      this.emit('indexing-progress', {
        totalFiles: counters.totalFiles,
        totalFolders: counters.totalFolders,
        totalBytes: counters.totalBytes,
        root: progressContext.root || root,
        rootIndex: progressContext.rootIndex || 0,
        totalRoots: progressContext.totalRoots || 1,
        elapsedMs: progressContext.startedAt ? Date.now() - progressContext.startedAt : 0
      });
    };
    await this.scanDirectory(root, outputArray, 0, this.config.maxDepth, record => {
      if (record.isDir) counters.totalFolders += 1;
      else {
        counters.totalFiles += 1;
        counters.totalBytes += record.size || 0;
      }
      publishProgress();
    });
    if (outputArray.length !== publishedCount) {
      this.records = outputArray;
      this.stats.totalFiles = counters.totalFiles;
      this.stats.totalFolders = counters.totalFolders;
      this.stats.totalBytes = counters.totalBytes;
      this.emit('indexing-progress', {
        totalFiles: counters.totalFiles,
        totalFolders: counters.totalFolders,
        totalBytes: counters.totalBytes,
        root: progressContext.root || root,
        rootIndex: progressContext.rootIndex || 0,
        totalRoots: progressContext.totalRoots || 1,
        elapsedMs: progressContext.startedAt ? Date.now() - progressContext.startedAt : 0
      });
    }
    return outputArray.length - startLength;
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
      // Tags and starred state live in TagManager. Do not duplicate them in
      // the file index: whole-device scans should keep records compact.
    };
  }

  async scanDirectory(dir, outputArray, depth, maxDepth, onProgress = null) {
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
      const record = {
        name,
        path: dir,
        fullPath,
        size,
        mtime,
        ctime,
        isDir,
        ext
      };
      outputArray.push(record);
      if (onProgress) onProgress(record);

      if (isDir) {
        subdirs.push(fullPath);
      }
    }

    // Recurse into subdirectories
    for (const sub of subdirs) {
      await this.scanDirectory(sub, outputArray, depth + 1, maxDepth, onProgress);
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
      // Tags and starred state are hydrated only for matching queries.
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

        // Everything can only return files that are present in its own index.
        // A configured Windows UNC share may be reachable to this app while
        // missing from Everything's index, so merge matching local-index
        // records for network roots instead of silently returning zero files.
        const networkRoots = (this.config.roots || []).filter(root => /^\\\\/.test(String(root)));
        const localNetworkRecords = networkRoots.length === 0 ? [] : this.records
          .filter(item => {
            const fullPath = getFullPath(item);
            return networkRoots.some(root => this.isWithinScope(fullPath, root));
          })
          .map(item => {
            const fullPath = getFullPath(item);
            return {
              ...item,
              tags: this.tagManager.getTags(fullPath),
              starred: this.tagManager.isStarred(fullPath)
            };
          })
          .filter(item => QueryParser.matches(item, parsed));

        // If Everything returns zero, recover matches already present in the
        // local index. This covers files on drives/shares that Everything has
        // not indexed yet without slowing down normal native searches.
        const localFallbackRecords = nativeRecords.length > 0 ? [] : this.records
          .filter(item => this.isWithinConfiguredRoot(getFullPath(item)))
          .map(item => {
            const fullPath = getFullPath(item);
            return {
              ...item,
              tags: this.tagManager.getTags(fullPath),
              starred: this.tagManager.isStarred(fullPath)
            };
          })
          .filter(item => QueryParser.matches(item, parsed));

        const byPath = new Map();
        for (const item of [...scopedNativeRecords, ...localNetworkRecords, ...localFallbackRecords]) {
          byPath.set(normalizePathKey(getFullPath(item)), item);
        }
        const sorted = this.sortResults([...byPath.values()], options);
        return {
          results: sorted.slice(0, options.limit || 5000),
          totalMatches: sorted.length,
          totalIndexed: this.records.length,
          elapsedMs: Date.now() - start,
          parsedQuery: parsed,
          backend: localFallbackRecords.length > 0 ? 'local-fallback' : nativeResult.backend,
          warning: localFallbackRecords.length > 0
            ? 'Everything returned no matches; local index fallback used.'
            : (nativeResult.warning || null)
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
        const fullPath = getFullPath(item);
        // Tags and starred state can change without rebuilding the file index.
        // Hydrate them for every local search so a just-toggled result is
        // immediately searchable and cannot be overwritten by stale cache data.
        const searchableItem = { ...item };
        if ((parsed.tags || []).length > 0) searchableItem.tags = this.tagManager.getTags(fullPath);
        if (parsed.starred !== null && parsed.starred !== undefined) searchableItem.starred = this.tagManager.isStarred(fullPath);
        if (scopeRoot && !this.isWithinScope(fullPath, scopeRoot)) continue;
        if (QueryParser.matches(searchableItem, parsed)) {
          // Hydrate presentation metadata only for matched rows. This keeps a
          // large local search cheap while keeping star state immediately
          // visible after a toggle.
          if (searchableItem.starred === undefined) searchableItem.starred = this.tagManager.isStarred(fullPath);
          matched.push(searchableItem);
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
    return isPathWithinRoot(fullPath, scopeRoot);
  }

  isWithinConfiguredRoot(fullPath) {
    return (this.config.roots || []).some(root => this.isWithinScope(fullPath, root));
  }

  canUseNativeLocalIndex() {
    if (this.config.searchBackend === 'local') return false;
    return Boolean(this.nativeSearch && typeof this.nativeSearch.getStatus === 'function' && this.nativeSearch.getStatus().available);
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
