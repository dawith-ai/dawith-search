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
    getFileUrl: (filePath) => invoke('get_file_url', { filePath }).then(result => {
      if (!result?.success || !result.url) return result;
      const url = tauri.core.convertFileSrc ? tauri.core.convertFileSrc(result.url) : result.url;
      return { ...result, url };
    }),
    addSearchHistory: (query) => invoke('add_search_history', { query }),
    listSearchHistory: () => invoke('list_search_history'),
    clearSearchHistory: () => invoke('clear_search_history'),
    listBookmarks: () => invoke('list_bookmarks'),
    addBookmark: (bookmark) => invoke('add_bookmark', { bookmark }),
    touchBookmark: (id) => invoke('touch_bookmark', { id }),
    removeBookmark: (id) => invoke('remove_bookmark', { id }),
    addTag: (filePath, tag) => invoke('add_tag', { filePath, tag }),
    removeTag: (filePath, tag) => invoke('remove_tag', { filePath, tag }),
    toggleStar: (filePath) => invoke('toggle_star', { filePath }).then(result => result?.starred ?? false),
    getAllTags: () => invoke('get_all_tags'),
    deleteFile: (filePath) => invoke('delete_file', { filePath }),
    renameFile: (oldPath, newPath) => invoke('rename_file', { oldPath, newPath }),
    getFileContent: (filePath) => invoke('get_file_content', { filePath }),
    getConversionOptions: (filePaths) => invoke('get_conversion_options', { filePaths }),
    convertFiles: (filePaths, operation, destinationDir) => invoke('convert_files', { filePaths, operation, destinationDir }),
    exportResults: unsupported,
    startRemoteServer: unsupported,
    stopRemoteServer: unsupported,
    getRemoteServerStatus: () => Promise.resolve({ isRunning: false }),
    getStorageAnalysis: unsupported,
    analyzePath: unsupported,
    saveAnalysisReport: unsupported,
    findDuplicates: unsupported,
    installGozBackend: () => invoke('install_goz_backend'),
    checkForUpdates: () => invoke('check_for_updates'),
    downloadUpdate: () => invoke('download_update'),
    onUpdateProgress: (callback) => {
      if (!tauri.event?.listen) return;
      tauri.event.listen('update-progress', event => callback(event.payload));
    },
    onIndexStatus: (callback) => {
      if (!tauri.event?.listen) return;
      tauri.event.listen('index-status', event => callback(event.payload));
    }
  };
})();

