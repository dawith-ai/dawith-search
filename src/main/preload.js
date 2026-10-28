const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dawithAPI', {
  search: (query, options) => ipcRenderer.invoke('search', query, options),
  listBookmarks: () => ipcRenderer.invoke('list-bookmarks'),
  addBookmark: (bookmark) => ipcRenderer.invoke('add-bookmark', bookmark),
  touchBookmark: (id) => ipcRenderer.invoke('touch-bookmark', id),
  removeBookmark: (id) => ipcRenderer.invoke('remove-bookmark', id),
  listSearchHistory: () => ipcRenderer.invoke('list-search-history'),
  addSearchHistory: (query) => ipcRenderer.invoke('add-search-history', query),
  clearSearchHistory: () => ipcRenderer.invoke('clear-search-history'),
  openFile: (filePath) => ipcRenderer.invoke('open-file', filePath),
  openFolder: (filePath) => ipcRenderer.invoke('open-folder', filePath),
  copyPath: (filePath) => ipcRenderer.invoke('copy-path', filePath),
  deleteFile: (filePath) => ipcRenderer.invoke('delete-file', filePath),
  renameFile: (oldPath, newPath) => ipcRenderer.invoke('rename-file', oldPath, newPath),
  getFileContent: (filePath) => ipcRenderer.invoke('get-file-content', filePath),
  getFileStats: (filePath) => ipcRenderer.invoke('get-file-stats', filePath),
  getFileUrl: (filePath) => ipcRenderer.invoke('get-file-url', filePath),
  
  exportResults: (format, items) => ipcRenderer.invoke('export-results', format, items),
  
  startRemoteServer: (port) => ipcRenderer.invoke('start-remote-server', port),
  stopRemoteServer: () => ipcRenderer.invoke('stop-remote-server'),
  getRemoteServerStatus: () => ipcRenderer.invoke('get-remote-server-status'),
  
  getStorageAnalysis: () => ipcRenderer.invoke('get-storage-analysis'),
  analyzePath: (filePath, options) => ipcRenderer.invoke('analyze-path', filePath, options),
  saveAnalysisReport: () => ipcRenderer.invoke('save-analysis-report'),
  findDuplicates: (options) => ipcRenderer.invoke('find-duplicates', options),
  
  addTag: (filePath, tag) => ipcRenderer.invoke('add-tag', filePath, tag),
  removeTag: (filePath, tag) => ipcRenderer.invoke('remove-tag', filePath, tag),
  toggleStar: (filePath) => ipcRenderer.invoke('toggle-star', filePath),
  getAllTags: () => ipcRenderer.invoke('get-all-tags'),
  
  getConfig: () => ipcRenderer.invoke('get-config'),
  chooseRoot: () => ipcRenderer.invoke('choose-root'),
  getBackendStatus: () => ipcRenderer.invoke('get-backend-status'),
  openGuide: () => ipcRenderer.invoke('open-guide'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),
  reindex: () => ipcRenderer.invoke('reindex'),
  
  minimizeWindow: () => ipcRenderer.invoke('window-minimize'),
  maximizeWindow: () => ipcRenderer.invoke('window-maximize'),
  closeWindow: () => ipcRenderer.invoke('window-close'),

  onIndexStatus: (callback) => {
    ipcRenderer.on('index-status', (event, data) => callback(data));
  }
});
