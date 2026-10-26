const { app, BrowserWindow, ipcMain, shell, clipboard, dialog, globalShortcut, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

process.on('uncaughtException', (err) => {
  fs.appendFileSync(path.join(__dirname, '../../crash.log'), 'UNCAUGHT: ' + err.stack + '\n');
});
process.on('unhandledRejection', (reason) => {
  fs.appendFileSync(path.join(__dirname, '../../crash.log'), 'REJECTION: ' + (reason && reason.stack ? reason.stack : reason) + '\n');
});

const Indexer = require('../engine/indexer');
const StorageAnalyzer = require('../engine/storage-analyzer');
const DuplicateFinder = require('../engine/duplicate-finder');
const Exporter = require('../engine/exporter');
const RemoteServer = require('../engine/remote-server');

let mainWindow = null;
let tray = null;
let indexer = null;
let remoteServer = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1150,
    height: 780,
    minWidth: 850,
    minHeight: 550,
    frame: false, // Modern custom borderless titlebar
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: false
    },
    show: true
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function setupTray() {
  try {
    const iconPath = path.join(__dirname, '../assets/icon.png');
    if (!fs.existsSync(iconPath)) return;
    const nImg = nativeImage.createFromPath(iconPath);
    if (nImg.isEmpty()) return;
    tray = new Tray(nImg.resize({ width: 16, height: 16 }));
    const contextMenu = Menu.buildFromTemplate([
      { label: 'Dawith Search 열기', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } else createWindow(); } },
      { label: '색인 새로고침 (Reindex)', click: () => { if (indexer) indexer.startIndexing(); } },
      { type: 'separator' },
      { label: '종료', click: () => { app.isQuitting = true; app.quit(); } }
    ]);
    tray.setToolTip('Dawith Search (초고속 파일 검색기)');
    tray.setContextMenu(contextMenu);
    tray.on('double-click', () => {
      if (mainWindow) {
        if (mainWindow.isVisible()) {
          mainWindow.hide();
        } else {
          mainWindow.show();
          mainWindow.focus();
        }
      } else {
        createWindow();
      }
    });
  } catch (e) {
    console.error('Tray error ignored:', e);
  }
}

app.whenReady().then(() => {
  indexer = new Indexer();
  remoteServer = new RemoteServer(indexer);

  // Fast load cached index first
  const loaded = indexer.loadCache();
  
  createWindow();
  setupTray();

  // Register Global Hotkey: Alt+Space
  try {
    globalShortcut.register('Alt+Space', () => {
      if (mainWindow) {
        if (mainWindow.isVisible()) {
          if (mainWindow.isFocused()) {
            mainWindow.hide();
          } else {
            mainWindow.focus();
          }
        } else {
          mainWindow.show();
          mainWindow.focus();
        }
      } else {
        createWindow();
      }
    });
  } catch (e) {
    console.error('Failed to register global hotkey:', e);
  }

  // Forward indexer events to renderer
  indexer.on('indexing-started', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('index-status', { status: 'indexing' });
    }
  });

  indexer.on('indexing-finished', (stats) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('index-status', { status: 'idle', stats });
    }
  });

  indexer.on('file-updated', (data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('index-status', { status: 'updated', data });
    }
  });

  // If not cached, start indexing immediately in background
  if (!loaded || indexer.records.length === 0) {
    setTimeout(() => {
      indexer.startIndexing();
    }, 500);
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (remoteServer) remoteServer.stop();
  if (indexer) indexer.fileWatcher.close();
});

app.on('window-all-closed', () => {
  fs.appendFileSync(path.join(__dirname, '../../crash.log'), 'EVENT: window-all-closed\n');
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// IPC Handlers
ipcMain.handle('search', async (event, query, options) => {
  if (!indexer) return { results: [], totalMatches: 0, totalIndexed: 0, elapsedMs: 0 };
  return await indexer.search(query, options);
});

ipcMain.handle('open-file', async (event, filePath) => {
  try {
    if (fs.existsSync(filePath)) {
      await shell.openPath(filePath);
      return { success: true };
    }
    return { success: false, error: 'File not found' };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('open-folder', async (event, filePath) => {
  try {
    if (fs.existsSync(filePath)) {
      shell.showItemInFolder(filePath);
      return { success: true };
    }
    return { success: false, error: 'Path not found' };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('copy-path', (event, filePath) => {
  clipboard.writeText(filePath);
  return { success: true };
});

ipcMain.handle('delete-file', async (event, filePath) => {
  try {
    if (!fs.existsSync(filePath)) return { success: false, error: 'File not found' };
    await shell.trashItem(filePath); // Safe recycle bin deletion
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('rename-file', async (event, oldPath, newPath) => {
  try {
    if (!fs.existsSync(oldPath)) return { success: false, error: 'File not found' };
    await fs.promises.rename(oldPath, newPath);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('get-file-content', async (event, filePath) => {
  try {
    if (!fs.existsSync(filePath)) return { success: false, error: 'File not found' };
    const stat = await fs.promises.stat(filePath);
    if (stat.isDirectory()) return { success: false, error: 'Is directory' };
    
    // Read text preview up to 2MB
    const limit = 2 * 1024 * 1024;
    const buffer = Buffer.alloc(Math.min(stat.size, limit));
    const fd = await fs.promises.open(filePath, 'r');
    await fd.read(buffer, 0, buffer.length, 0);
    await fd.close();
    
    return {
      success: true,
      size: stat.size,
      mtime: stat.mtimeMs,
      content: buffer.toString('utf8'),
      truncated: stat.size > limit
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('get-file-stats', async (event, filePath) => {
  try {
    if (!fs.existsSync(filePath)) return null;
    const stat = await fs.promises.stat(filePath);
    return {
      size: stat.size,
      mtime: stat.mtimeMs,
      ctime: stat.birthtimeMs || stat.ctimeMs,
      isDirectory: stat.isDirectory()
    };
  } catch (e) {
    return null;
  }
});

ipcMain.handle('export-results', async (event, format, items) => {
  try {
    const { filePath } = await dialog.showSaveDialog(mainWindow, {
      title: '검색 결과 내보내기',
      defaultPath: `dawith-search-results.${format || 'csv'}`,
      filters: [
        { name: 'CSV File', extensions: ['csv'] },
        { name: 'Everything File List (EFU)', extensions: ['efu'] },
        { name: 'Plain Text', extensions: ['txt'] },
        { name: 'JSON Data', extensions: ['json'] }
      ]
    });

    if (!filePath) return { canceled: true };
    const result = Exporter.exportToFile(filePath, format, items);
    return { success: true, ...result };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('start-remote-server', async (event, port) => {
  try {
    const res = await remoteServer.start(port || 8888);
    return { success: true, ...res };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('stop-remote-server', () => {
  if (remoteServer) remoteServer.stop();
  return { success: true };
});

ipcMain.handle('get-remote-server-status', () => {
  return remoteServer ? remoteServer.getStatus() : { isRunning: false };
});

ipcMain.handle('get-storage-analysis', () => {
  if (!indexer) return null;
  return StorageAnalyzer.analyze(indexer.records);
});

ipcMain.handle('find-duplicates', async (event, options) => {
  if (!indexer) return { groups: [], totalDuplicates: 0, totalWastedBytes: 0 };
  return await DuplicateFinder.findDuplicates(indexer.records, options);
});

ipcMain.handle('add-tag', (event, filePath, tag) => {
  return indexer.tagManager.addTag(filePath, tag);
});

ipcMain.handle('remove-tag', (event, filePath, tag) => {
  return indexer.tagManager.removeTag(filePath, tag);
});

ipcMain.handle('toggle-star', (event, filePath) => {
  return indexer.tagManager.toggleStar(filePath);
});

ipcMain.handle('get-all-tags', () => {
  return indexer.tagManager.getAllTags();
});

ipcMain.handle('get-config', () => {
  return indexer.config;
});

ipcMain.handle('save-config', (event, config) => {
  indexer.config = { ...indexer.config, ...config };
  indexer.saveConfig();
  return { success: true };
});

ipcMain.handle('reindex', async () => {
  if (indexer) {
    indexer.startIndexing();
    return { success: true };
  }
  return { success: false };
});

ipcMain.handle('window-minimize', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.handle('window-maximize', () => {
  if (mainWindow) {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  }
});

ipcMain.handle('window-close', () => {
  if (mainWindow) mainWindow.close();
});
