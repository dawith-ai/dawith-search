(() => {
  const tauri = window.__TAURI__;
  if (!tauri?.core?.invoke) return;

  const invoke = (command, args) => tauri.core.invoke(command, args);
  const unsupported = () => Promise.resolve({
    success: false,
    supported: false,
    error: '이 기능은 경량 Tauri 핵심 버전에서 준비 중입니다.'
  });

  window.dawithAPI = {
    search: (query, options) => invoke('search', { query, options }),
    getConfig: () => invoke('get_config'),
    saveConfig: (config) => invoke('save_config', { config }),
    chooseRoot: () => invoke('choose_root'),
    inspectRoot: (rootPath) => invoke('inspect_root', { rootPath }),
    getBackendStatus: () => invoke('get_backend_status'),
    getFileStats: (filePath) => invoke('get_file_stats', { filePath }),
    openFile: (filePath) => invoke('open_file', { filePath }),
    openFolder: (filePath) => invoke('open_folder', { filePath }),
    copyPath: (filePath) => invoke('copy_path', { filePath }),
    reindex: () => invoke('reindex'),
    minimizeWindow: () => invoke('window_minimize'),
    maximizeWindow: () => invoke('window_maximize'),
    closeWindow: () => invoke('window_close'),
    openGuide: () => invoke('open_guide'),
    getFileUrl: (filePath) => Promise.resolve({ success: true, url: filePath }),
    addSearchHistory: () => Promise.resolve({ success: true }),
    listSearchHistory: () => Promise.resolve([]),
    clearSearchHistory: () => Promise.resolve({ success: true }),
    listBookmarks: () => Promise.resolve([]),
    addBookmark: unsupported,
    touchBookmark: unsupported,
    removeBookmark: unsupported,
    addTag: unsupported,
    removeTag: unsupported,
    toggleStar: unsupported,
    getAllTags: () => Promise.resolve([]),
    deleteFile: unsupported,
    renameFile: unsupported,
    getFileContent: unsupported,
    getConversionOptions: unsupported,
    convertFiles: unsupported,
    exportResults: unsupported,
    startRemoteServer: unsupported,
    stopRemoteServer: unsupported,
    getRemoteServerStatus: () => Promise.resolve({ isRunning: false }),
    getStorageAnalysis: unsupported,
    analyzePath: unsupported,
    saveAnalysisReport: unsupported,
    findDuplicates: unsupported,
    installGozBackend: unsupported,
    checkForUpdates: () => Promise.resolve({ supported: false, available: false }),
    downloadUpdate: unsupported,
    onIndexStatus: (callback) => {
      if (!tauri.event?.listen) return;
      tauri.event.listen('index-status', event => callback(event.payload));
    }
  };
})();

