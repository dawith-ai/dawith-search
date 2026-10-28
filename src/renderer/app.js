/**
 * Dawith Search - Renderer Application
 */

// State
let searchResults = [];
let searchRequestId = 0;
let selectedIndex = -1;
let selectedIndexes = new Set();
let currentFilter = '';
let isAiMode = false;
let currentSortBy = 'name';
let currentSortOrder = 'asc';
let searchDebounceTimer = null;
let historyDebounceTimer = null;
let currentContextItem = null;
let scopeRoot = '';

// UI Elements
const searchInput = document.getElementById('searchInput');
const clearBtn = document.getElementById('btnClear');
const aiToggleBtn = document.getElementById('btnAiToggle');
const toolsButton = document.getElementById('btnTools');
const toolsMenu = document.getElementById('toolsMenu');
const btnThemeToggle = document.getElementById('btnThemeToggle');
const tableBody = document.getElementById('tableBody');
const emptyState = document.getElementById('emptyState');
const statMatches = document.getElementById('statMatches');
const statElapsed = document.getElementById('statElapsed');
const statTotalIndexed = document.getElementById('statTotalIndexed');
const titlebarStatus = document.getElementById('titlebarStatusText');
const backendStatus = document.getElementById('backendStatusText');
const statusDot = document.querySelector('.status-dot');
const workspaceSidebar = document.getElementById('workspaceSidebar');
const activeScope = document.getElementById('activeScope');
const activeScopeLabel = document.getElementById('activeScopeLabel');
const bookmarkList = document.getElementById('bookmarkList');
const bookmarkCount = document.getElementById('bookmarkCount');
const historyList = document.getElementById('historyList');
const sidebarRoots = document.getElementById('sidebarRoots');
const selectionBar = document.getElementById('selectionBar');
const selectionSummary = document.getElementById('selectionSummary');

// Modals
const quickLookModal = document.getElementById('quickLookModal');
const remoteModal = document.getElementById('remoteModal');
const storageModal = document.getElementById('storageModal');
const settingsModal = document.getElementById('settingsModal');
const syntaxModal = document.getElementById('syntaxModal');
const evidenceModal = document.getElementById('evidenceModal');
const contextMenu = document.getElementById('contextMenu');

// Utilities
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatDate(timestamp) {
  if (!timestamp) return '';
  const d = new Date(timestamp);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function getFileIcon(ext, isDir) {
  if (isDir) return '📁';
  const e = (ext || '').toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(e)) return '🖼️';
  if (['mp4', 'mkv', 'avi', 'mov', 'wmv'].includes(e)) return '🎬';
  if (['mp3', 'wav', 'flac', 'aac', 'ogg'].includes(e)) return '🎵';
  if (['zip', '7z', 'rar', 'tar', 'gz'].includes(e)) return '📦';
  if (['exe', 'bat', 'cmd', 'ps1', 'msi'].includes(e)) return '⚙️';
  if (['pdf'].includes(e)) return '📕';
  if (['xls', 'xlsx', 'csv'].includes(e)) return '📊';
  if (['doc', 'docx', 'hwp', 'hwpx'].includes(e)) return '📝';
  if (['ppt', 'pptx'].includes(e)) return '📽️';
  if (['js', 'ts', 'jsx', 'tsx', 'py', 'html', 'css', 'json'].includes(e)) return '💻';
  return '📄';
}

function highlightMatch(text, query) {
  if (!query || !text) return escapeHtml(text);
  const terms = query.replace(/[|*?!():]/g, ' ').split(/\s+/).filter(t => t.length > 0 && !t.includes(':'));
  if (terms.length === 0) return escapeHtml(text);

  let escaped = escapeHtml(text);
  for (const term of terms) {
    const re = new RegExp(`(${escapeRegex(term)})`, 'gi');
    escaped = escaped.replace(re, '<span class="highlight">$1</span>');
  }
  return escaped;
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getPathLabel(filePath) {
  const value = String(filePath || '');
  return value.replace(/[\\/]$/, '').split(/[\\/]/).pop() || value;
}

function updateScopeUI() {
  if (!activeScope || !activeScopeLabel) return;
  activeScope.hidden = !scopeRoot;
  activeScopeLabel.textContent = scopeRoot ? getPathLabel(scopeRoot) : '';
  activeScopeLabel.title = scopeRoot || '';
}

function setActivePreset(query) {
  document.querySelectorAll('#workPresets .sidebar-nav-item').forEach(item => {
    item.classList.toggle('active', item.dataset.query === query && !scopeRoot);
  });
}

function applyWorkspaceQuery(query, options = {}) {
  currentFilter = '';
  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.filter === ''));
  scopeRoot = options.scopeRoot || '';
  searchInput.value = query || '';
  setActivePreset(query || '');
  updateScopeUI();
  if (options.bookmarkId) window.dawithAPI.touchBookmark(options.bookmarkId);
  searchInput.focus();
  executeSearch();
}

function renderSidebarRoots(roots = []) {
  if (!sidebarRoots) return;
  sidebarRoots.innerHTML = '';
  if (!roots.length) {
    sidebarRoots.innerHTML = '<div class="sidebar-empty">설정에서 검색 폴더를 추가하세요.</div>';
    return;
  }
  roots.forEach(root => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sidebar-list-item';
    button.dataset.root = root;
    button.title = root;
    button.innerHTML = `<span class="nav-mark">⌂</span><span class="sidebar-item-label">${escapeHtml(getPathLabel(root))}<small>${escapeHtml(root)}</small></span>`;
    sidebarRoots.appendChild(button);
  });
}

function getRootKindLabel(root) {
  if (/^\\\\[^\\/]+[\\/][^\\/]+/.test(root)) return 'Windows 공유폴더';
  if (/^[A-Za-z]:[\\/]/.test(root)) return 'Windows 네트워크 드라이브';
  if (/^\/Volumes(?:\/|$)/.test(root)) return 'macOS 연결된 공유폴더';
  return '로컬 폴더';
}

function renderSettingsRoots(roots = []) {
  const rootsList = document.getElementById('rootsList');
  if (!rootsList) return;
  if (!roots.length) {
    rootsList.innerHTML = '<div class="roots-empty">등록된 검색 위치가 없습니다.</div>';
    return;
  }
  rootsList.innerHTML = roots.map(root => `
    <div class="root-item" data-root-item="${escapeHtml(root)}">
      <span class="root-item-icon">⌂</span>
      <span class="root-item-copy"><strong>${escapeHtml(getRootKindLabel(root))}</strong><code>${escapeHtml(root)}</code></span>
      <button class="root-remove" type="button" data-remove-root="${escapeHtml(root)}" title="검색 위치에서 제거">×</button>
    </div>
  `).join('');
}

async function refreshBookmarks() {
  if (!bookmarkList || !window.dawithAPI.listBookmarks) return;
  const bookmarks = await window.dawithAPI.listBookmarks();
  bookmarkCount.textContent = String(bookmarks.length);
  bookmarkList.innerHTML = '';
  if (!bookmarks.length) {
    bookmarkList.innerHTML = '<div class="sidebar-empty">자주 쓰는 검색을 저장하세요.</div>';
    return;
  }
  bookmarks.forEach(bookmark => {
    const entry = document.createElement('div');
    entry.className = 'sidebar-entry';
    entry.innerHTML = `
      <button class="sidebar-list-item" data-bookmark-id="${escapeHtml(bookmark.id)}" title="${escapeHtml(bookmark.query)}">
        <span class="nav-mark">☆</span><span class="sidebar-item-label">${escapeHtml(bookmark.name)}<small>${escapeHtml(bookmark.query)}</small></span>
      </button>
      <button class="sidebar-item-remove" data-remove-bookmark="${escapeHtml(bookmark.id)}" title="저장된 검색 삭제">×</button>
    `;
    bookmarkList.appendChild(entry);
  });
}

async function refreshHistory() {
  if (!historyList || !window.dawithAPI.listSearchHistory) return;
  const history = await window.dawithAPI.listSearchHistory();
  historyList.innerHTML = '';
  if (!history.length) {
    historyList.innerHTML = '<div class="sidebar-empty">검색하면 최근 기록이 여기에 남습니다.</div>';
    return;
  }
  history.slice(0, 8).forEach(item => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sidebar-list-item';
    button.dataset.historyQuery = item.query;
    button.title = item.query;
    button.innerHTML = `<span class="nav-mark">↗</span><span class="sidebar-item-label">${escapeHtml(item.query)}</span>`;
    historyList.appendChild(button);
  });
}

async function saveCurrentBookmark() {
  const query = getActiveQuery();
  if (!query && !scopeRoot) {
    alert('먼저 저장할 검색어나 폴더 범위를 선택하세요.');
    searchInput.focus();
    return;
  }
  const defaultName = query || getPathLabel(scopeRoot);
  const name = prompt('저장된 검색 이름을 입력하세요:', defaultName);
  if (!name) return;
  const result = await window.dawithAPI.addBookmark({
    name,
    query,
    scopeRoot,
    sortBy: currentSortBy,
    sortOrder: currentSortOrder
  });
  if (!result.success) alert(`저장 실패: ${result.error}`);
  await refreshBookmarks();
}

async function addSearchRoot() {
  const result = await window.dawithAPI.chooseRoot();
  if (!result || result.canceled || !result.path) return;
  const config = await window.dawithAPI.getConfig();
  const roots = Array.from(new Set([...(config.roots || []), result.path]));
  await window.dawithAPI.saveConfig({ roots });
  renderSidebarRoots(roots);
  renderSettingsRoots(roots);
  await window.dawithAPI.reindex();
}

async function initWorkspace() {
  const config = await window.dawithAPI.getConfig();
  renderSidebarRoots(config.roots || []);
  await Promise.all([refreshBookmarks(), refreshHistory()]);
  updateScopeUI();
}

// Perform Search
function getActiveQuery() {
  return `${currentFilter ? `${currentFilter} ` : ''}${searchInput.value.trim()}`.trim();
}

async function executeSearch() {
  const requestId = ++searchRequestId;
  const rawInput = searchInput.value.trim();
  const query = (currentFilter ? currentFilter + ' ' : '') + rawInput;

  clearBtn.style.display = rawInput ? 'block' : 'none';

  try {
    const res = await window.dawithAPI.search(query, {
      useAI: isAiMode,
      sortBy: currentSortBy,
      sortOrder: currentSortOrder,
      limit: 1000,
      scopeRoot: scopeRoot || undefined
    });

    // Index-status events and debounced input can overlap. Never let an older
    // response overwrite the result for the latest user query.
    if (requestId !== searchRequestId) return;

    searchResults = res.results || [];
    selectedIndex = searchResults.length > 0 ? 0 : -1;
    selectedIndexes = searchResults.length > 0 ? new Set([0]) : new Set();
    updateSelectionUI();
    renderResults(searchResults, rawInput);

    if (backendStatus) {
      backendStatus.textContent = res.backend === 'everything'
        ? 'Everything'
        : res.backend === 'spotlight' ? 'Spotlight' : '로컬 색인';
    }

    statMatches.textContent = `${res.totalMatches.toLocaleString()}개 항목 발견`;
    statElapsed.textContent = `${res.elapsedMs} ms`;
    statTotalIndexed.textContent = `색인 항목: ${res.totalIndexed.toLocaleString()}개`;

    if (query.trim()) {
      clearTimeout(historyDebounceTimer);
      historyDebounceTimer = setTimeout(async () => {
        await window.dawithAPI.addSearchHistory(query);
        refreshHistory();
      }, 700);
    }
  } catch (err) {
    console.error('Search error:', err);
  }
}

function triggerSearch() {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(executeSearch, 40);
}

// Render Results Table
function renderResults(items, currentQuery) {
  tableBody.innerHTML = '';

  if (items.length === 0) {
    emptyState.style.display = 'block';
    const hasQuery = Boolean(currentQuery || currentFilter);
    document.getElementById('emptyTitle').textContent = hasQuery
      ? '검색 결과가 없습니다'
      : '검색을 시작하세요';
    document.getElementById('emptySub').textContent = hasQuery
      ? '다른 키워드나 필터 조건을 사용해 보세요.'
      : '파일명이나 폴더명을 입력하면 이 PC의 파일을 바로 찾습니다.';
    document.getElementById('emptyExamples').style.display = hasQuery ? 'none' : 'flex';
    return;
  }
  emptyState.style.display = 'none';

  const fragment = document.createDocumentFragment();

  items.forEach((item, idx) => {
    const row = document.createElement('div');
    row.className = `table-row ${selectedIndexes.has(idx) ? 'selected' : ''}`;
    row.dataset.index = idx;

    const icon = getFileIcon(item.ext, item.isDir);
    const starActive = item.starred ? 'active' : '';

    row.innerHTML = `
      <div class="td col-name" title="${escapeHtml(item.name)}">
        <span class="row-star ${starActive}" data-idx="${idx}" title="즐겨찾기">⭐</span>
        <span class="file-icon">${icon}</span>
        <span class="file-name-text">${highlightMatch(item.name, currentQuery)}</span>
      </div>
      <div class="td col-path" title="${escapeHtml(item.path)}">${escapeHtml(item.path)}</div>
      <div class="td col-size">${item.isDir ? '&lt;DIR&gt;' : formatBytes(item.size)}</div>
      <div class="td col-mtime">${formatDate(item.mtime)}</div>
      <div class="td col-ext">${item.isDir ? '폴더' : (item.ext ? item.ext.toUpperCase() : '파일')}</div>
      <div class="td col-actions">
        <button class="btn btn-sm btn-ghost row-btn-open" data-idx="${idx}" title="열기">열기</button>
      </div>
    `;

    // Row selection and click events
    row.addEventListener('click', (e) => {
      if (e.target.classList.contains('row-star')) {
        toggleItemStar(item);
        return;
      }
      if (e.target.classList.contains('row-btn-open')) {
        openItem(item);
        return;
      }
      if (e.metaKey || e.ctrlKey) {
        toggleRowSelection(idx);
      } else if (e.shiftKey && selectedIndex >= 0) {
        selectRange(selectedIndex, idx);
      } else {
        selectRow(idx);
      }
    });

    row.addEventListener('dblclick', () => {
      openItem(item);
    });

    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      selectRow(idx);
      showContextMenu(e.clientX, e.clientY, item);
    });

    fragment.appendChild(row);
  });

  tableBody.appendChild(fragment);
  scrollToSelected();
}

function selectRow(index) {
  if (index < 0 || index >= searchResults.length) return;
  selectedIndex = index;
  selectedIndexes = new Set([index]);
  updateSelectionUI();
  const rows = tableBody.children;
  for (let i = 0; i < rows.length; i++) {
    rows[i].classList.toggle('selected', i === selectedIndex);
  }
  scrollToSelected();
}

function toggleRowSelection(index) {
  selectedIndex = index;
  if (selectedIndexes.has(index) && selectedIndexes.size > 1) selectedIndexes.delete(index);
  else selectedIndexes.add(index);
  updateSelectionUI();
  const rows = tableBody.children;
  for (let i = 0; i < rows.length; i++) rows[i].classList.toggle('selected', selectedIndexes.has(i));
}

function selectRange(from, to) {
  const start = Math.min(from, to);
  const end = Math.max(from, to);
  selectedIndexes = new Set();
  for (let index = start; index <= end; index++) selectedIndexes.add(index);
  selectedIndex = to;
  updateSelectionUI();
  const rows = tableBody.children;
  for (let i = 0; i < rows.length; i++) rows[i].classList.toggle('selected', selectedIndexes.has(i));
}

function updateSelectionUI() {
  if (!selectionBar || !selectionSummary) return;
  const count = selectedIndexes.size;
  selectionBar.hidden = count < 2;
  selectionSummary.textContent = `${count.toLocaleString()}개 선택`;
}

function getSelectedItems() {
  return [...selectedIndexes].sort((a, b) => a - b).map(index => searchResults[index]).filter(Boolean);
}

function scrollToSelected() {
  const selectedEl = tableBody.querySelector('.table-row.selected');
  if (selectedEl) {
    selectedEl.scrollIntoView({ block: 'nearest' });
  }
}

// File Actions
function getFullPath(item) {
  if (item.fullPath) return item.fullPath;
  if (!item.path) return item.name || '';
  const separator = item.path.endsWith('\\') || item.path.endsWith('/')
    ? ''
    : (item.path.includes('\\') ? '\\' : '/');
  return item.path + separator + item.name;
}

async function openItem(item) {
  if (!item) return;
  const full = getFullPath(item);
  await window.dawithAPI.openFile(full);
}

async function openItemFolder(item) {
  if (!item) return;
  const full = getFullPath(item);
  await window.dawithAPI.openFolder(full);
}

async function toggleItemStar(item) {
  const full = getFullPath(item);
  const isStarred = await window.dawithAPI.toggleStar(full);
  item.starred = isStarred;
  executeSearch();
}

// Quick Look Preview (Spacebar)
async function showQuickLook(item) {
  if (!item) return;
  const full = getFullPath(item);
  const icon = getFileIcon(item.ext, item.isDir);

  document.getElementById('qlIcon').textContent = icon;
  document.getElementById('qlName').textContent = item.name;
  document.getElementById('qlSize').textContent = item.isDir ? '폴더' : formatBytes(item.size);
  document.getElementById('qlPath').textContent = full;
  document.getElementById('qlDate').textContent = '수정일: ' + formatDate(item.mtime);

  const bodyEl = document.getElementById('qlBody');
  bodyEl.innerHTML = '<div style="color: #64748b;">로딩 중...</div>';
  quickLookModal.style.display = 'flex';

  const ext = (item.ext || '').toLowerCase();

  // Handle Images
  const fileUrlResult = await window.dawithAPI.getFileUrl(full);
  const fileUrl = fileUrlResult.success ? fileUrlResult.url : '';

  if (fileUrl && ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(ext)) {
    bodyEl.innerHTML = `<img src="${fileUrl}" alt="Preview" />`;
    return;
  }

  // Handle Audio / Video
  if (fileUrl && ['mp4', 'webm', 'ogg'].includes(ext)) {
    bodyEl.innerHTML = `<video controls autoplay style="max-width:100%; max-height:100%;"><source src="${fileUrl}" type="video/${ext}"></video>`;
    return;
  }
  if (fileUrl && ['mp3', 'wav'].includes(ext)) {
    bodyEl.innerHTML = `<audio controls autoplay><source src="${fileUrl}" type="audio/${ext}"></audio>`;
    return;
  }

  // Handle Text / Code / Documents
  const res = await window.dawithAPI.getFileContent(full);
  if (res.success) {
    bodyEl.innerHTML = `<pre>${escapeHtml(res.content)}</pre>`;
  } else {
    bodyEl.innerHTML = '<div style="text-align:center; color:#94a3b8;">미리보기를 지원하지 않는 바이너리 파일입니다.<br><button class="btn btn-primary mt-2 ql-open-default" type="button">기본 프로그램으로 열기</button></div>';
    bodyEl.querySelector('.ql-open-default').addEventListener('click', () => openItem(item));
  }
}

// Command Palette Implementation (Ctrl+K)
const cmdPaletteModal = document.getElementById('cmdPaletteModal');
const cmdPaletteInput = document.getElementById('cmdPaletteInput');
const cmdPaletteList = document.getElementById('cmdPaletteList');

function openCommandPalette() {
  closeToolsMenu();
  cmdPaletteModal.style.display = 'flex';
  cmdPaletteInput.value = '';
  filterCmdItems('');
  cmdPaletteInput.focus();
}

function closeCommandPalette() {
  cmdPaletteModal.style.display = 'none';
}

function filterCmdItems(query) {
  const items = cmdPaletteList.querySelectorAll('.cmd-item');
  const q = query.toLowerCase().trim();
  items.forEach(item => {
    const text = item.textContent.toLowerCase();
    item.style.display = text.includes(q) ? 'flex' : 'none';
  });
}

cmdPaletteInput.addEventListener('input', (e) => {
  filterCmdItems(e.target.value);
});

cmdPaletteList.addEventListener('click', (e) => {
  const item = e.target.closest('.cmd-item');
  if (!item) return;
  const action = item.dataset.action;
  closeCommandPalette();
  handleCmdAction(action);
});

function handleCmdAction(action) {
  if (action === 'toggle-ai') {
    aiToggleBtn.click();
  } else if (action === 'save-bookmark') {
    saveCurrentBookmark();
  } else if (action === 'open-remote') {
    document.getElementById('btnRemoteServer').click();
  } else if (action === 'open-storage') {
    document.getElementById('btnStorageAnalyzer').click();
  } else if (action === 'open-evidence') {
    document.getElementById('btnEvidenceAnalyzer').click();
  } else if (action === 'reindex') {
    window.dawithAPI.reindex();
  } else if (action === 'export-csv') {
    if (searchResults.length > 0) window.dawithAPI.exportResults('csv', searchResults);
  } else if (action === 'export-efu') {
    if (searchResults.length > 0) window.dawithAPI.exportResults('efu', searchResults);
  } else if (action === 'open-settings') {
    document.getElementById('btnSettings').click();
  } else if (action === 'open-syntax') {
    document.getElementById('syntaxHintBtn').click();
  }
}

function closeToolsMenu() {
  if (!toolsMenu || !toolsButton) return;
  toolsMenu.hidden = true;
  toolsButton.setAttribute('aria-expanded', 'false');
}

if (toolsButton && toolsMenu) {
  toolsButton.addEventListener('click', (event) => {
    event.stopPropagation();
    toolsMenu.hidden = !toolsMenu.hidden;
    toolsButton.setAttribute('aria-expanded', String(!toolsMenu.hidden));
  });

  toolsMenu.addEventListener('click', closeToolsMenu);
  document.addEventListener('click', (event) => {
    if (!event.target.closest('.tools-menu-wrap')) closeToolsMenu();
  });
}

// Keyboard Navigation
document.addEventListener('keydown', (e) => {
  // If Quick Look open, Escape closes it
  if (quickLookModal.style.display === 'flex') {
    if (e.key === 'Escape' || e.code === 'Space') {
      quickLookModal.style.display = 'none';
      e.preventDefault();
      return;
    }
  }

  // Close modals on Escape
  if (e.key === 'Escape') {
    cmdPaletteModal.style.display = 'none';
    remoteModal.style.display = 'none';
    storageModal.style.display = 'none';
    settingsModal.style.display = 'none';
    syntaxModal.style.display = 'none';
    evidenceModal.style.display = 'none';
    contextMenu.style.display = 'none';
    closeToolsMenu();
    return;
  }

  const primaryModifier = e.metaKey || e.ctrlKey;

  // Focus search input on Cmd/Ctrl+F
  if (primaryModifier && e.key === 'f') {
    searchInput.focus();
    searchInput.select();
    e.preventDefault();
    return;
  }

  // Command Palette on Cmd/Ctrl+K
  if (primaryModifier && e.key === 'k') {
    openCommandPalette();
    e.preventDefault();
    return;
  }

  // If focus in searchInput, let Up/Down navigate table without losing focus
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    selectRow(Math.min(selectedIndex + 1, searchResults.length - 1));
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    selectRow(Math.max(selectedIndex - 1, 0));
  } else if (e.key === 'Enter') {
    if (selectedIndex >= 0 && searchResults[selectedIndex]) {
      if (primaryModifier) {
        openItemFolder(searchResults[selectedIndex]);
      } else {
        openItem(searchResults[selectedIndex]);
      }
    }
  } else if (e.code === 'Space' && document.activeElement !== searchInput) {
    if (selectedIndex >= 0 && searchResults[selectedIndex]) {
      e.preventDefault();
      showQuickLook(searchResults[selectedIndex]);
    }
  } else if (e.key === 'F2' && selectedIndex >= 0) {
    renameItemPrompt(searchResults[selectedIndex]);
  } else if (e.key === 'Delete' && selectedIndex >= 0) {
    deleteItemPrompt(searchResults[selectedIndex]);
  } else if (primaryModifier && e.key === 'c' && document.activeElement !== searchInput && selectedIndex >= 0) {
    copySelectedPaths();
  }
});

// Rename / Delete
async function renameItemPrompt(item) {
  if (!item) return;
  const oldFull = getFullPath(item);
  const newName = prompt('새 파일/폴더 이름을 입력하세요:', item.name);
  if (newName && newName !== item.name) {
    const separator = item.path.endsWith('\\') || item.path.endsWith('/')
      ? ''
      : (item.path.includes('\\') ? '\\' : '/');
    const newFull = item.path + separator + newName;
    const res = await window.dawithAPI.renameFile(oldFull, newFull);
    if (res.success) {
      item.name = newName;
      executeSearch();
    } else {
      alert('이름 변경 실패: ' + res.error);
    }
  }
}

async function deleteItemPrompt(item) {
  if (!item) return;
  const full = getFullPath(item);
  if (confirm(`'${item.name}' 항목을 휴지통으로 이동하시겠습니까?`)) {
    const res = await window.dawithAPI.deleteFile(full);
    if (res.success) {
      executeSearch();
    } else {
      alert('삭제 실패: ' + res.error);
    }
  }
}

async function copySelectedPaths() {
  const items = getSelectedItems();
  if (!items.length) return;
  await window.dawithAPI.copyPath(items.map(getFullPath).join('\n'));
}

async function batchRenameSelected() {
  const items = getSelectedItems().filter(item => item && !item.isDir);
  if (!items.length) {
    alert('파일을 두 개 이상 선택하세요. 폴더는 일괄 이름 변경에서 제외됩니다.');
    return;
  }
  const template = prompt('이름 형식을 입력하세요. {name}=기존 이름, {n}=순번, {ext}=확장자', '{name}_{n}.{ext}');
  if (!template) return;
  if (!confirm(`${items.length}개 파일의 이름을 변경하시겠습니까?`)) return;

  let success = 0;
  for (const [index, item] of items.entries()) {
    const extension = item.ext || '';
    const stem = extension ? item.name.slice(0, -(extension.length + 1)) : item.name;
    const newName = template
      .replace(/\{name\}/gi, stem)
      .replace(/\{n\}/gi, String(index + 1).padStart(2, '0'))
      .replace(/\{ext\}/gi, extension);
    if (!newName || newName === item.name || /[\\/:*?"<>|]/.test(newName)) continue;
    const separator = item.path.endsWith('\\') || item.path.endsWith('/') ? '' : (item.path.includes('\\') ? '\\' : '/');
    const result = await window.dawithAPI.renameFile(getFullPath(item), item.path + separator + newName);
    if (result.success) success++;
  }
  selectedIndexes = new Set();
  updateSelectionUI();
  await executeSearch();
  alert(`${success}개 파일의 이름을 변경했습니다. 충돌하거나 건너뛴 파일: ${items.length - success}개`);
}

async function deleteSelectedItems() {
  const items = getSelectedItems();
  if (!items.length) return;
  if (!confirm(`${items.length}개 항목을 휴지통으로 이동하시겠습니까?`)) return;
  let success = 0;
  for (const item of items) {
    const result = await window.dawithAPI.deleteFile(getFullPath(item));
    if (result.success) success++;
  }
  selectedIndexes = new Set();
  updateSelectionUI();
  await executeSearch();
  alert(`${success}개 항목을 휴지통으로 이동했습니다.`);
}

// Context Menu Setup
function showContextMenu(x, y, item) {
  currentContextItem = item;
  contextMenu.style.left = `${Math.min(x, window.innerWidth - 200)}px`;
  contextMenu.style.top = `${Math.min(y, window.innerHeight - 250)}px`;
  contextMenu.style.display = 'block';
}

document.addEventListener('click', (e) => {
  if (!contextMenu.contains(e.target)) {
    contextMenu.style.display = 'none';
  }
});

document.getElementById('ctxOpen').addEventListener('click', () => {
  if (currentContextItem) openItem(currentContextItem);
});
document.getElementById('ctxOpenFolder').addEventListener('click', () => {
  if (currentContextItem) openItemFolder(currentContextItem);
});
document.getElementById('ctxQuickLook').addEventListener('click', () => {
  if (currentContextItem) showQuickLook(currentContextItem);
});
document.getElementById('ctxCopyPath').addEventListener('click', () => {
  if (currentContextItem) window.dawithAPI.copyPath(getFullPath(currentContextItem));
});
document.getElementById('ctxStar').addEventListener('click', () => {
  if (currentContextItem) toggleItemStar(currentContextItem);
});
document.getElementById('ctxTag').addEventListener('click', async () => {
  if (!currentContextItem) return;
  const full = getFullPath(currentContextItem);
  const currentTags = (currentContextItem.tags || []).join(', ');
  const newTag = prompt('태그를 입력하세요 (쉼표로 구분):', currentTags);
  if (newTag !== null) {
    await window.dawithAPI.addTag(full, newTag);
    executeSearch();
  }
});
document.getElementById('ctxRename').addEventListener('click', () => {
  if (currentContextItem) renameItemPrompt(currentContextItem);
});
document.getElementById('ctxDelete').addEventListener('click', () => {
  if (currentContextItem) deleteItemPrompt(currentContextItem);
});

// UI Event Listeners
searchInput.addEventListener('input', triggerSearch);

clearBtn.addEventListener('click', () => {
  searchInput.value = '';
  clearBtn.style.display = 'none';
  searchInput.focus();
  executeSearch();
});

// Theme Toggle Logic
function initTheme() {
  const savedTheme = localStorage.getItem('theme') || 'light-theme';
  document.body.className = savedTheme;
  updateThemeIcon(savedTheme);
}

function updateThemeIcon(theme) {
  if (!btnThemeToggle) return;
  const icon = btnThemeToggle.querySelector('.tool-menu-icon');
  if (icon) {
    icon.textContent = theme === 'light-theme' ? '◐' : '☼';
  } else {
    btnThemeToggle.textContent = theme === 'light-theme' ? '🌙' : '☀️';
  }
}

if (btnThemeToggle) {
  btnThemeToggle.addEventListener('click', () => {
    const isLight = document.body.classList.contains('light-theme');
    const newTheme = isLight ? 'dark-theme' : 'light-theme';
    document.body.className = newTheme;
    updateThemeIcon(newTheme);
    localStorage.setItem('theme', newTheme);
  });
}

initTheme();

// AI Mode Toggle
aiToggleBtn.addEventListener('click', () => {
  isAiMode = !isAiMode;
  aiToggleBtn.classList.toggle('active', isAiMode);
  executeSearch();
});

// Category Filter Tabs
document.getElementById('filterTabs').addEventListener('click', (e) => {
  if (e.target.classList.contains('tab-btn')) {
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    e.target.classList.add('active');
    currentFilter = e.target.dataset.filter || '';
    scopeRoot = '';
    updateScopeUI();
    setActivePreset('');
    executeSearch();
  }
});

document.getElementById('workPresets').addEventListener('click', (e) => {
  const button = e.target.closest('.sidebar-nav-item');
  if (!button) return;
  applyWorkspaceQuery(button.dataset.query || '');
});

sidebarRoots.addEventListener('click', (e) => {
  const button = e.target.closest('[data-root]');
  if (!button) return;
  applyWorkspaceQuery('', { scopeRoot: button.dataset.root });
});

bookmarkList.addEventListener('click', async (e) => {
  const removeButton = e.target.closest('[data-remove-bookmark]');
  if (removeButton) {
    await window.dawithAPI.removeBookmark(removeButton.dataset.removeBookmark);
    await refreshBookmarks();
    return;
  }
  const button = e.target.closest('[data-bookmark-id]');
  if (!button) return;
  const bookmarks = await window.dawithAPI.listBookmarks();
  const bookmark = bookmarks.find(item => item.id === button.dataset.bookmarkId);
  if (bookmark) applyWorkspaceQuery(bookmark.query, { scopeRoot: bookmark.scopeRoot, bookmarkId: bookmark.id });
});

historyList.addEventListener('click', (e) => {
  const button = e.target.closest('[data-history-query]');
  if (button) applyWorkspaceQuery(button.dataset.historyQuery);
});

document.getElementById('btnSaveBookmark').addEventListener('click', saveCurrentBookmark);
document.getElementById('btnClearHistory').addEventListener('click', async () => {
  await window.dawithAPI.clearSearchHistory();
  await refreshHistory();
});
document.getElementById('btnSidebarAddRoot').addEventListener('click', addSearchRoot);
document.getElementById('btnAddRoot').addEventListener('click', addSearchRoot);
document.getElementById('btnClearScope').addEventListener('click', () => {
  scopeRoot = '';
  updateScopeUI();
  setActivePreset(searchInput.value.trim());
  executeSearch();
});
document.getElementById('btnSidebarCollapse').addEventListener('click', () => {
  workspaceSidebar.classList.toggle('is-collapsed');
});
document.getElementById('btnCopySelectedPaths').addEventListener('click', copySelectedPaths);
document.getElementById('btnBatchRename').addEventListener('click', batchRenameSelected);
document.getElementById('btnDeleteSelected').addEventListener('click', deleteSelectedItems);
document.getElementById('btnClearSelection').addEventListener('click', () => {
  selectedIndex = -1;
  selectedIndexes = new Set();
  updateSelectionUI();
  renderResults(searchResults, searchInput.value.trim());
});

document.getElementById('emptyExamples').addEventListener('click', (e) => {
  const button = e.target.closest('button[data-query]');
  if (!button) return;
  searchInput.value = button.dataset.query;
  searchInput.focus();
  executeSearch();
});

// Table Column Sorting
document.querySelectorAll('.table-header .th').forEach(th => {
  th.addEventListener('click', () => {
    const col = th.dataset.col;
    if (!col) return;
    if (currentSortBy === col) {
      currentSortOrder = currentSortOrder === 'asc' ? 'desc' : 'asc';
    } else {
      currentSortBy = col;
      currentSortOrder = 'asc';
    }
    // Update sort indicator
    document.querySelectorAll('.sort-indicator').forEach(el => el.remove());
    const indicator = document.createElement('span');
    indicator.className = 'sort-indicator';
    indicator.textContent = currentSortOrder === 'asc' ? '▲' : '▼';
    th.appendChild(indicator);

    executeSearch();
  });
});

// Quick Look Dialog buttons
document.getElementById('qlBtnClose').addEventListener('click', () => {
  quickLookModal.style.display = 'none';
});
document.getElementById('qlBtnOpen').addEventListener('click', () => {
  if (selectedIndex >= 0) openItem(searchResults[selectedIndex]);
});
document.getElementById('qlBtnOpenFolder').addEventListener('click', () => {
  if (selectedIndex >= 0) openItemFolder(searchResults[selectedIndex]);
});

// Mobile Remote Modal
document.getElementById('btnRemoteServer').addEventListener('click', async () => {
  remoteModal.style.display = 'flex';
  const res = await window.dawithAPI.startRemoteServer(8888);
  if (res.success) {
    document.getElementById('qrImage').src = res.qrDataUrl;
    document.getElementById('remoteUrlInput').value = res.url;
    document.getElementById('remoteStatusText').textContent = `서버 실행 중: ${res.url}`;
  }
});
document.getElementById('btnCloseRemote').addEventListener('click', () => {
  remoteModal.style.display = 'none';
});
document.getElementById('btnCopyRemoteUrl').addEventListener('click', () => {
  const url = document.getElementById('remoteUrlInput').value;
  window.dawithAPI.copyPath(url);
  alert('원격 접속 URL이 클립보드에 복사되었습니다: ' + url);
});

// Storage Analyzer Modal
document.getElementById('btnStorageAnalyzer').addEventListener('click', async () => {
  storageModal.style.display = 'flex';
  loadStorageOverview();
});
document.getElementById('btnCloseStorage').addEventListener('click', () => {
  storageModal.style.display = 'none';
});

const evidenceRootSelect = document.getElementById('evidenceRootSelect');
const evidenceBody = document.getElementById('evidenceBody');
const btnSaveEvidence = document.getElementById('btnSaveEvidence');
let lastEvidenceReport = null;

function formatNumber(value) {
  return Number(value || 0).toLocaleString();
}

function renderEvidenceReport(report) {
  lastEvidenceReport = report;
  btnSaveEvidence.disabled = false;
  const summary = report.summary || {};
  const coverage = report.coverage || {};
  const statusLabel = coverage.status === 'complete' ? '범위 내 분석 완료' : '부분 분석 · 제한 있음';
  const relationships = (report.relationships || []).slice(0, 80);
  const observations = (report.observations || []).filter(item => item.kind && item.kind.startsWith('electron.')).slice(0, 60);
  const unknowns = (report.unknowns || []).slice(0, 60);
  const relationItems = relationships.length
    ? relationships.map(item => `<li><span class="evidence-code">${escapeHtml(item.source)}</span> → ${escapeHtml(item.target || item.specifier)} <small>(${escapeHtml(item.resolution)})</small></li>`).join('')
    : '<li>정적 import 관계가 없습니다.</li>';
  const boundaryItems = observations.length
    ? observations.map(item => `<li><span class="evidence-code">${escapeHtml(item.location && item.location.path)}</span><br>${escapeHtml(item.description)}</li>`).join('')
    : '<li>Electron 경계 후보가 발견되지 않았습니다.</li>';
  const unknownItems = unknowns.length
    ? unknowns.map(item => `<li><span class="evidence-code">${escapeHtml(item.path || item.kind)}</span> · ${escapeHtml(item.reason || 'unknown')}</li>`).join('')
    : '<li>현재 범위에서 미확인 항목이 없습니다.</li>';

  evidenceBody.innerHTML = `
    <div class="evidence-summary-grid">
      <div class="evidence-stat"><span class="evidence-stat-label">범위</span><strong class="evidence-stat-value"><span class="evidence-status ${coverage.status === 'complete' ? '' : 'partial'}">${statusLabel}</span></strong></div>
      <div class="evidence-stat"><span class="evidence-stat-label">파일</span><strong class="evidence-stat-value">${formatNumber(summary.files)}</strong></div>
      <div class="evidence-stat"><span class="evidence-stat-label">소스</span><strong class="evidence-stat-value">${formatNumber(summary.sourceFiles)}</strong></div>
      <div class="evidence-stat"><span class="evidence-stat-label">import</span><strong class="evidence-stat-value">${formatNumber(summary.resolvedImports)} / ${formatNumber(summary.imports)}</strong></div>
      <div class="evidence-stat"><span class="evidence-stat-label">Electron 경계</span><strong class="evidence-stat-value">${formatNumber(summary.electronBoundaries)}</strong></div>
    </div>
    <div class="evidence-columns">
      <section class="evidence-panel"><h4>소스 관계 · ${formatNumber(summary.imports)}건</h4><ul class="evidence-list">${relationItems}</ul></section>
      <section class="evidence-panel"><h4>Electron 경계 · ${formatNumber(summary.electronBoundaries)}건</h4><ul class="evidence-list">${boundaryItems}</ul></section>
      <section class="evidence-panel"><h4>미확인 · ${formatNumber(coverage.unknowns)}</h4><ul class="evidence-list">${unknownItems}</ul></section>
      <section class="evidence-panel"><h4>식별 정보</h4><ul class="evidence-list"><li>대상: <span class="evidence-code">${escapeHtml(report.subject && report.subject.path)}</span></li><li>SHA-256: <span class="evidence-code">${escapeHtml(report.subject && report.subject.sha256)}</span></li><li>소요 시간: ${formatNumber(report.durationMs)} ms</li><li>로컬 처리 · 외부 전송 없음 · AI 미사용</li></ul></section>
    </div>
    <p class="evidence-footnote">정적 후보는 실행을 증명하지 않습니다. 동적 import, 생성 코드, 제외 디렉터리와 예산 초과 항목은 미확인/제외로 표시됩니다.</p>
  `;
}

function populateEvidenceRoots(roots) {
  evidenceRootSelect.innerHTML = '';
  (roots || []).forEach(root => {
    const option = document.createElement('option');
    option.value = root;
    option.textContent = root;
    option.title = root;
    evidenceRootSelect.appendChild(option);
  });
  if (scopeRoot && (roots || []).includes(scopeRoot)) evidenceRootSelect.value = scopeRoot;
}

document.getElementById('btnEvidenceAnalyzer').addEventListener('click', async () => {
  const config = await window.dawithAPI.getConfig();
  populateEvidenceRoots(config.roots || []);
  evidenceBody.innerHTML = '<div class="evidence-empty">검색 폴더를 선택하고 분석을 시작하세요.</div>';
  btnSaveEvidence.disabled = true;
  evidenceModal.style.display = 'flex';
});
document.getElementById('btnCloseEvidence').addEventListener('click', () => {
  evidenceModal.style.display = 'none';
});
document.getElementById('btnRunEvidence').addEventListener('click', async () => {
  const root = evidenceRootSelect.value;
  if (!root) {
    evidenceBody.innerHTML = '<div class="evidence-empty">먼저 설정에서 검색 폴더를 추가하세요.</div>';
    return;
  }
  evidenceBody.innerHTML = '<div class="evidence-empty">파일 목록과 증거를 수집하는 중입니다…</div>';
  const result = await window.dawithAPI.analyzePath(root);
  if (!result.success) {
    evidenceBody.innerHTML = `<div class="evidence-empty">분석 실패: ${escapeHtml(result.error)}</div>`;
    return;
  }
  renderEvidenceReport(result.report);
});
btnSaveEvidence.addEventListener('click', async () => {
  if (!lastEvidenceReport) return;
  const result = await window.dawithAPI.saveAnalysisReport();
  if (result.success) alert(`증거 보고서를 저장했습니다.\n${result.filePath}`);
  else if (!result.canceled) alert(`저장 실패: ${result.error}`);
});

async function loadStorageOverview() {
  const data = await window.dawithAPI.getStorageAnalysis();
  if (!data) return;
  const storageBody = document.getElementById('storageBody');
  const cats = data.categories;

  storageBody.innerHTML = `
    <div class="storage-summary">
      <h4>전체 색인 파일: ${data.totalFiles.toLocaleString()}개 (${formatBytes(data.totalBytes)})</h4>
      <p>카테고리별 디스크 사용량 현황입니다.</p>
    </div>
    <div class="storage-category-bar">
      <div class="storage-seg seg-doc" style="width: ${(cats.documents.bytes / data.totalBytes * 100) || 0}%" title="문서"></div>
      <div class="storage-seg seg-pic" style="width: ${(cats.pictures.bytes / data.totalBytes * 100) || 0}%" title="이미지"></div>
      <div class="storage-seg seg-video" style="width: ${(cats.videos.bytes / data.totalBytes * 100) || 0}%" title="동영상"></div>
      <div class="storage-seg seg-audio" style="width: ${(cats.audio.bytes / data.totalBytes * 100) || 0}%" title="오디오"></div>
      <div class="storage-seg seg-zip" style="width: ${(cats.compressed.bytes / data.totalBytes * 100) || 0}%" title="압축"></div>
      <div class="storage-seg seg-exe" style="width: ${(cats.executables.bytes / data.totalBytes * 100) || 0}%" title="실행"></div>
      <div class="storage-seg seg-other" style="width: ${(cats.others.bytes / data.totalBytes * 100) || 0}%" title="기타"></div>
    </div>
    <div class="storage-category-grid">
      ${Object.values(cats).map(c => `
        <div class="storage-category-card">
          <div class="storage-category-label">${c.label}</div>
          <div class="storage-category-size">${formatBytes(c.bytes)}</div>
          <div class="storage-category-count">${c.count.toLocaleString()}개 파일</div>
        </div>
      `).join('')}
    </div>
  `;
}

document.getElementById('tabStorageOverview').addEventListener('click', (e) => {
  setStorageTabActive(e.target);
  loadStorageOverview();
});

document.getElementById('tabDuplicates').addEventListener('click', async (e) => {
  setStorageTabActive(e.target);
  const storageBody = document.getElementById('storageBody');
  storageBody.innerHTML = '<div class="storage-empty">중복 파일을 확인하고 있습니다…</div>';

  const res = await window.dawithAPI.findDuplicates({ minSize: 10240 }); // > 10KB
  if (res.groups.length === 0) {
    storageBody.innerHTML = '<div class="storage-empty storage-empty-success">중복 파일이 없습니다.</div>';
    return;
  }

  storageBody.innerHTML = `
    <div class="duplicate-summary">
      발견된 중복 그룹: <strong>${res.groups.length}개</strong> · 절약 가능한 공간: <strong>${formatBytes(res.totalWastedBytes)}</strong>
    </div>
    <div class="duplicate-list">
      ${res.groups.map(grp => `
        <div class="duplicate-group">
          <div class="duplicate-group-heading">
            <span>${grp.items[0].name} (${formatBytes(grp.size)})</span>
            <span class="duplicate-count">${grp.items.length}개 중복</span>
          </div>
          ${grp.items.map(it => `
            <div class="duplicate-path-row">
              <span class="duplicate-path" title="${escapeHtml(getFullPath(it))}">${escapeHtml(getFullPath(it))}</span>
              <button class="btn btn-sm btn-ghost" type="button" data-open-duplicate-folder="${escapeHtml(getFullPath(it))}">위치</button>
            </div>
          `).join('')}
        </div>
      `).join('')}
    </div>
  `;
  storageBody.querySelectorAll('[data-open-duplicate-folder]').forEach(button => {
    button.addEventListener('click', () => window.dawithAPI.openFolder(button.dataset.openDuplicateFolder));
  });
});

document.getElementById('tabLargestFiles').addEventListener('click', async (e) => {
  setStorageTabActive(e.target);
  const data = await window.dawithAPI.getStorageAnalysis();
  const storageBody = document.getElementById('storageBody');
  storageBody.innerHTML = `
    <div style="max-height:400px; overflow-y:auto;">
      <table class="syntax-table">
        <thead><tr><th>순위</th><th>파일명</th><th>크기</th><th>경로</th></tr></thead>
        <tbody>
          ${data.topLargest.map((f, i) => `
            <tr>
              <td>#${i + 1}</td>
              <td style="font-weight:600; color:#38bdf8;">${f.name}</td>
              <td style="color:#f59e0b; font-weight:bold;">${formatBytes(f.size)}</td>
              <td style="color:#64748b; font-size:11px;">${f.path}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
});

function setStorageTabActive(btn) {
  document.querySelectorAll('.storage-tab-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
}

// Export Dialog
document.getElementById('btnExport').addEventListener('click', async () => {
  if (searchResults.length === 0) {
    alert('내보낼 검색 결과가 없습니다.');
    return;
  }
  const res = await window.dawithAPI.exportResults('csv', searchResults);
  if (res.success) {
    alert(`성공적으로 저장되었습니다:\n${res.filePath} (${res.count}개 항목)`);
  }
});

// Settings Dialog
document.getElementById('btnSettings').addEventListener('click', async () => {
  settingsModal.style.display = 'flex';
  const cfg = await window.dawithAPI.getConfig();
  renderSettingsRoots(cfg.roots || []);
});
document.getElementById('btnCloseSettings').addEventListener('click', () => {
  settingsModal.style.display = 'none';
});

const networkRootForm = document.getElementById('networkRootForm');
const networkRootInput = document.getElementById('networkRootInput');
const networkRootStatus = document.getElementById('networkRootStatus');

function closeNetworkRootForm() {
  networkRootForm.hidden = true;
  networkRootInput.value = '';
  networkRootStatus.textContent = 'Windows 공유폴더는 현재 Windows 계정의 접근 권한으로 확인합니다. macOS는 Finder에서 연결한 뒤 /Volumes 경로를 사용하세요.';
  networkRootStatus.classList.remove('error', 'success');
}

document.getElementById('btnAddNetworkRoot').addEventListener('click', () => {
  networkRootForm.hidden = false;
  networkRootInput.focus();
});
document.getElementById('btnCancelNetworkRoot').addEventListener('click', closeNetworkRootForm);
document.getElementById('btnSaveNetworkRoot').addEventListener('click', async () => {
  const input = networkRootInput.value.trim();
  if (!input) {
    networkRootStatus.textContent = '공유 폴더 경로를 입력하세요.';
    networkRootStatus.classList.add('error');
    return;
  }
  networkRootStatus.textContent = '공유 폴더 연결과 권한을 확인하는 중입니다…';
  networkRootStatus.classList.remove('error', 'success');
  const inspected = await window.dawithAPI.inspectRoot(input);
  if (!inspected.success) {
    networkRootStatus.textContent = inspected.error;
    networkRootStatus.classList.add('error');
    return;
  }
  const config = await window.dawithAPI.getConfig();
  const roots = Array.from(new Set([...(config.roots || []), inspected.path]));
  await window.dawithAPI.saveConfig({ roots });
  renderSidebarRoots(roots);
  renderSettingsRoots(roots);
  networkRootStatus.textContent = `${inspected.label} 연결 확인 완료. 색인을 시작합니다.`;
  networkRootStatus.classList.add('success');
  closeNetworkRootForm();
  // Do not keep the settings form blocked while a large or remote share is indexed.
  // The main process owns the long-running scan and will continue to publish status
  // events even when the user returns to the search workspace.
  window.dawithAPI.reindex().catch(error => {
    console.error('Failed to reindex after adding root:', error);
  });
});
networkRootInput.addEventListener('keydown', event => {
  if (event.key === 'Enter') document.getElementById('btnSaveNetworkRoot').click();
  if (event.key === 'Escape') closeNetworkRootForm();
});

document.getElementById('rootsList').addEventListener('click', async event => {
  const button = event.target.closest('[data-remove-root]');
  if (!button) return;
  const root = button.dataset.removeRoot;
  const config = await window.dawithAPI.getConfig();
  const roots = (config.roots || []).filter(item => item !== root);
  if (!roots.length) {
    alert('검색 위치는 한 곳 이상 필요합니다. 다른 위치를 먼저 추가하세요.');
    return;
  }
  await window.dawithAPI.saveConfig({ roots });
  renderSidebarRoots(roots);
  renderSettingsRoots(roots);
  await window.dawithAPI.reindex();
});
document.getElementById('btnReindexNow').addEventListener('click', async () => {
  await window.dawithAPI.reindex();
  settingsModal.style.display = 'none';
});

// Syntax Guide
document.getElementById('syntaxHintBtn').addEventListener('click', () => {
  window.dawithAPI.openGuide();
});
document.getElementById('btnCloseSyntax').addEventListener('click', () => {
  syntaxModal.style.display = 'none';
});

// Titlebar Controls
document.getElementById('btnMinimize').addEventListener('click', () => window.dawithAPI.minimizeWindow());
document.getElementById('btnMaximize').addEventListener('click', () => window.dawithAPI.maximizeWindow());
document.getElementById('btnClose').addEventListener('click', () => window.dawithAPI.closeWindow());

// Realtime Index Status
window.dawithAPI.onIndexStatus((data) => {
  if (data.status === 'indexing') {
    statusDot.className = 'status-dot indexing';
    titlebarStatus.textContent = '색인 작업 진행 중...';
  } else if (data.status === 'idle') {
    statusDot.className = 'status-dot';
    titlebarStatus.textContent = '색인 완료';
    executeSearch();
  } else if (data.status === 'updated') {
    executeSearch();
  } else if (data.status === 'error') {
    statusDot.className = 'status-dot error';
    titlebarStatus.textContent = '색인 오류';
  }
});

async function initBackendStatus() {
  try {
    const status = await window.dawithAPI.getBackendStatus();
    if (backendStatus) backendStatus.textContent = status.label || '로컬 색인';
  } catch (error) {
    if (backendStatus) backendStatus.textContent = '로컬 색인';
  }
}

// Initial Search on App Launch
initBackendStatus();
initWorkspace();
executeSearch();
