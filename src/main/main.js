const { app, BrowserWindow, ipcMain, shell, clipboard, dialog, globalShortcut, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');

function writeCrashLog(message) {
  try {
    const logDir = app.isReady() ? app.getPath('logs') : path.join(os.tmpdir(), 'dawith-search');
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, 'crash.log'), `${message}\n`, 'utf8');
  } catch (error) {
    console.error('Unable to write crash log:', error);
  }
}

process.on('uncaughtException', (err) => {
  writeCrashLog('UNCAUGHT: ' + err.stack);
});
process.on('unhandledRejection', (reason) => {
  writeCrashLog('REJECTION: ' + (reason && reason.stack ? reason.stack : reason));
});

const Indexer = require('../engine/indexer');
const StorageAnalyzer = require('../engine/storage-analyzer');
const DuplicateFinder = require('../engine/duplicate-finder');
const Exporter = require('../engine/exporter');
const RemoteServer = require('../engine/remote-server');
const BookmarkManager = require('../engine/bookmark-manager');
const HistoryManager = require('../engine/history-manager');
const EvidenceAnalyzer = require('../engine/evidence-analyzer');
const RootManager = require('../engine/root-manager');
const UpdateManager = require('./update-manager');
const Converter = require('../engine/converter');

let mainWindow = null;
let guideWindow = null;
let tray = null;
let indexer = null;
let remoteServer = null;
let bookmarkManager = null;
let historyManager = null;
let lastEvidenceReport = null;

function getAllowedPath(filePath, options = {}) {
  const candidate = path.resolve(String(filePath || ''));
  if (!indexer || !indexer.isWithinConfiguredRoot(candidate)) {
    throw new Error('Path is outside the configured search folders.');
  }
  if (options.mustExist !== false && !fs.existsSync(candidate)) {
    throw new Error('Path not found.');
  }
  return candidate;
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      createWindow();
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}

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
      webSecurity: true
    },
    // Show immediately so a frameless window cannot remain invisible when
    // Electron skips ready-to-show on a local file URL.
    show: true
  });

  mainWindow.once('ready-to-show', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
  });
  // Some macOS/Electron combinations load the local file successfully but do
  // not emit ready-to-show for a hidden frameless window. Never leave the app
  // running only in the tray when the main document has finished loading.
  mainWindow.webContents.once('did-finish-load', () => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    if (errorCode === -3) return;
    const message = `MAIN_WINDOW_LOAD_FAILED ${errorCode}: ${errorDescription} (${validatedURL})`;
    writeCrashLog(message);
    dialog.showErrorBox('Dawith Search를 열 수 없습니다', `${errorDescription}\n\n${validatedURL}`);
  });
  mainWindow.webContents.on('render-process-gone', (event, details) => {
    writeCrashLog(`RENDERER_GONE: ${details.reason || 'unknown'} ${details.exitCode || ''}`);
  });
  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html')).catch(error => {
    writeCrashLog('MAIN_WINDOW_LOAD_EXCEPTION: ' + error.stack);
    dialog.showErrorBox('Dawith Search를 열 수 없습니다', error.message);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function openGuideWindow() {
  if (guideWindow && !guideWindow.isDestroyed()) {
    guideWindow.show();
    guideWindow.focus();
    return;
  }

  guideWindow = new BrowserWindow({
    width: 1120,
    height: 800,
    minWidth: 780,
    minHeight: 620,
    title: 'Dawith Search 사용 안내',
    backgroundColor: '#0a0f19',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });
  guideWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url).catch(error => writeCrashLog('EXTERNAL_OPEN_FAILED: ' + error.stack));
    }
    return { action: 'deny' };
  });
  guideWindow.loadFile(path.join(__dirname, '../renderer/guide.html'));
  guideWindow.on('closed', () => {
    guideWindow = null;
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
  bookmarkManager = new BookmarkManager(indexer.storageDir);
  historyManager = new HistoryManager(indexer.storageDir);

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
  indexer.on('indexing-started', (stats = {}) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('index-status', { status: 'indexing', ...stats });
    }
  });

  indexer.on('indexing-finished', (stats) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('index-status', { status: 'idle', stats });
    }
  });

  indexer.on('indexing-progress', (stats) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('index-status', { status: 'indexing-progress', stats });
    }
  });

  indexer.on('file-updated', (data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('index-status', { status: 'updated', data });
    }
  });

  indexer.on('indexing-error', (error) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('index-status', { status: 'error', error: error.message });
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
  writeCrashLog('EVENT: window-all-closed');
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
  else if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
  }
});

// IPC Handlers
ipcMain.handle('search', async (event, query, options) => {
  if (!indexer) return { results: [], totalMatches: 0, totalIndexed: 0, elapsedMs: 0 };
  return await indexer.search(query, options);
});

ipcMain.handle('list-bookmarks', () => bookmarkManager ? bookmarkManager.list() : []);

ipcMain.handle('add-bookmark', (event, bookmark) => {
  try {
    return { success: true, bookmark: bookmarkManager.add(bookmark) };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('touch-bookmark', (event, id) => ({
  success: Boolean(bookmarkManager && bookmarkManager.touch(id))
}));

ipcMain.handle('remove-bookmark', (event, id) => ({
  success: Boolean(bookmarkManager && bookmarkManager.remove(id))
}));

ipcMain.handle('list-search-history', () => historyManager ? historyManager.list() : []);

ipcMain.handle('add-search-history', (event, query) => ({
  success: Boolean(historyManager && historyManager.add(query))
}));

ipcMain.handle('clear-search-history', () => {
  if (historyManager) historyManager.clear();
  return { success: true };
});

ipcMain.handle('open-file', async (event, filePath) => {
  try {
    const safePath = getAllowedPath(filePath);
    const error = await shell.openPath(safePath);
    return error ? { success: false, error } : { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('open-folder', async (event, filePath) => {
  try {
    const safePath = getAllowedPath(filePath);
    shell.showItemInFolder(safePath);
    return { success: true };
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
    const safePath = getAllowedPath(filePath);
    await shell.trashItem(safePath); // Safe recycle bin deletion
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('rename-file', async (event, oldPath, newPath) => {
  try {
    const safeOldPath = getAllowedPath(oldPath);
    const safeNewPath = getAllowedPath(newPath, { mustExist: false });
    if (path.dirname(safeOldPath) !== path.dirname(safeNewPath)) {
      return { success: false, error: 'Renaming across folders is not allowed.' };
    }
    await fs.promises.rename(safeOldPath, safeNewPath);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('get-file-content', async (event, filePath) => {
  try {
    const safePath = getAllowedPath(filePath);
    const stat = await fs.promises.stat(safePath);
    if (stat.isDirectory()) return { success: false, error: 'Is directory' };
    
    // Read text preview up to 2MB
    const limit = 2 * 1024 * 1024;
    const buffer = Buffer.alloc(Math.min(stat.size, limit));
    const fd = await fs.promises.open(safePath, 'r');
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

ipcMain.handle('get-file-url', (event, filePath) => {
  try {
    const safePath = getAllowedPath(filePath);
    return { success: true, url: pathToFileURL(safePath).toString() };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('get-file-stats', async (event, filePath) => {
  try {
    const safePath = getAllowedPath(filePath);
    const stat = await fs.promises.stat(safePath);
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

ipcMain.handle('get-conversion-options', async (event, filePaths) => {
  try {
    const paths = (Array.isArray(filePaths) ? filePaths : [filePaths]).map(filePath => getAllowedPath(filePath));
    const stats = await Promise.all(paths.map(filePath => fs.promises.stat(filePath)));
    if (stats.some(stat => stat.isDirectory())) return { success: false, error: '폴더 자체는 변환할 수 없습니다.' };
    const options = Converter.getConversionOptions(paths);
    return { success: true, options, notice: options.length ? '' : Converter.getConversionNotice(paths) };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('convert-files', async (event, filePaths, operation, destinationDir) => {
  try {
    const paths = (Array.isArray(filePaths) ? filePaths : [filePaths]).map(filePath => getAllowedPath(filePath));
    const destination = destinationDir ? getAllowedPath(destinationDir) : path.dirname(paths[0]);
    const destinationStat = await fs.promises.stat(destination);
    if (!destinationStat.isDirectory()) throw new Error('변환 대상 폴더가 아닙니다.');
    const options = Converter.getConversionOptions(paths);
    if (!options.some(option => option.id === operation)) throw new Error('선택한 파일에서 지원하지 않는 변환입니다.');
    const outputs = await Converter.convertFiles(paths, operation, destination);
    return { success: true, outputs };
  } catch (error) {
    return { success: false, error: error.message };
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

ipcMain.handle('analyze-path', async (event, filePath, options) => {
  try {
    const safePath = getAllowedPath(filePath);
    const report = await EvidenceAnalyzer.analyzePath(safePath, options);
    lastEvidenceReport = report;
    return { success: true, report };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('save-analysis-report', async () => {
  if (!lastEvidenceReport) return { success: false, error: '먼저 분석을 실행하세요.' };
  try {
    const { filePath } = await dialog.showSaveDialog(mainWindow, {
      title: '증거 분석 보고서 저장',
      defaultPath: 'dawith-evidence-report.json',
      filters: [{ name: 'JSON Evidence Bundle', extensions: ['json'] }]
    });
    if (!filePath) return { canceled: true };
    await fs.promises.writeFile(filePath, JSON.stringify(lastEvidenceReport, null, 2), 'utf8');
    return { success: true, filePath };
  } catch (err) {
    return { success: false, error: err.message };
  }
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

ipcMain.handle('choose-root', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '검색할 폴더 선택',
    properties: ['openDirectory', 'createDirectory']
  });
  return result.canceled || result.filePaths.length === 0
    ? { canceled: true, path: null }
    : { canceled: false, path: result.filePaths[0] };
});

ipcMain.handle('inspect-root', async (event, rootPath) => {
  return await RootManager.inspectRoot(rootPath);
});

ipcMain.handle('get-backend-status', () => {
  return indexer ? indexer.nativeSearch.getStatus() : { backend: 'local', label: '로컬 색인 모드', available: false };
});

ipcMain.handle('check-for-updates', async () => {
  if (process.env.DAWITH_DISABLE_UPDATE_CHECK === '1') {
    return { supported: false, available: false, reason: 'disabled-for-test' };
  }
  try {
    return await UpdateManager.checkForUpdates(app.getVersion(), process.platform);
  } catch (error) {
    return { supported: false, available: false, reason: error.message };
  }
});

ipcMain.handle('download-update', async () => {
  if (process.env.DAWITH_DISABLE_UPDATE_CHECK === '1') {
    return { success: false, error: '업데이트 확인이 테스트 모드에서 비활성화되어 있습니다.' };
  }
  try {
    const update = await UpdateManager.checkForUpdates(app.getVersion(), process.platform);
    if (!update.available) return { success: false, error: '현재 최신 버전입니다.' };

    const updateDir = path.join(app.getPath('downloads'), 'Dawith Search Updates');
    const destination = path.join(updateDir, update.asset.name);
    await UpdateManager.downloadAndVerify(update, destination);

    if (process.platform === 'win32') {
      const scriptPath = path.join(updateDir, `launch-${update.latestVersion}.cmd`);
      const script = [
        '@echo off',
        'timeout /t 2 /nobreak >nul',
        `start "" "${destination.replace(/"/g, '""')}"`,
        'del "%~f0"'
      ].join('\r\n');
      fs.writeFileSync(scriptPath, script, 'utf8');
      const launcher = spawn('cmd.exe', ['/d', '/s', '/c', scriptPath], {
        detached: true,
        windowsHide: true,
        stdio: 'ignore'
      });
      launcher.unref();
      app.isQuitting = true;
      app.quit();
      return { success: true, action: 'relaunch', path: destination, version: update.latestVersion };
    }

    const openError = await shell.openPath(destination);
    if (openError) return { success: false, error: openError };
    return { success: true, action: 'open-installer', path: destination, version: update.latestVersion };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('open-guide', () => {
  openGuideWindow();
  return { success: true };
});

ipcMain.handle('save-config', (event, config) => {
  indexer.config = { ...indexer.config, ...config };
  indexer.normalizeConfig();
  indexer.fileWatcher.watch(indexer.config.roots);
  indexer.saveConfig();
  return { success: true };
});

ipcMain.handle('reindex', async () => {
  try {
    await indexer.startIndexing();
    return { success: true, ...indexer.stats };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('window-minimize', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
  return { success: true };
});

ipcMain.handle('window-maximize', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return { success: false };
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
  return { success: true, maximized: mainWindow.isMaximized() };
});

ipcMain.handle('window-close', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
  return { success: true };
});
