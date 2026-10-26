const chokidar = require('chokidar');
const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');

class FileWatcher extends EventEmitter {
  constructor(options = {}) {
    super();
    this.watcher = null;
    this.ignored = options.ignored || [
      '**/node_modules/**',
      '**/.git/**',
      '**/$Recycle.Bin/**',
      '**/System Volume Information/**',
      '**/AppData/Local/Temp/**',
      '**/AppData/Local/Microsoft/Windows/INetCache/**',
      '**/*.tmp',
      '**/*.crdownload'
    ];
  }

  watch(paths) {
    if (this.watcher) {
      this.close();
    }

    const validPaths = (Array.isArray(paths) ? paths : [paths]).filter(p => {
      try {
        return fs.existsSync(p);
      } catch (e) {
        return false;
      }
    });

    if (validPaths.length === 0) return;

    this.watcher = chokidar.watch(validPaths, {
      ignored: this.ignored,
      persistent: true,
      ignoreInitial: true, // We already index initially
      followSymlinks: false,
      depth: 10,
      awaitWriteFinish: {
        stabilityThreshold: 300,
        pollInterval: 100
      }
    });

    this.watcher
      .on('add', (filePath, stats) => {
        this.emit('file-added', filePath, stats);
      })
      .on('change', (filePath, stats) => {
        this.emit('file-changed', filePath, stats);
      })
      .on('unlink', (filePath) => {
        this.emit('file-deleted', filePath);
      })
      .on('addDir', (dirPath, stats) => {
        this.emit('folder-added', dirPath, stats);
      })
      .on('unlinkDir', (dirPath) => {
        this.emit('folder-deleted', dirPath);
      })
      .on('error', (err) => {
        // Silently swallow permission / EPERM errors
      });
  }

  close() {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }
}

module.exports = FileWatcher;
