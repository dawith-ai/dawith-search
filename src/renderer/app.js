/**
 * Dawith Search - Renderer Application
 */

// State
let searchResults = [];
let selectedIndex = -1;
let currentFilter = '';
let isAiMode = false;
let currentSortBy = 'name';
let currentSortOrder = 'asc';
let searchDebounceTimer = null;
let currentContextItem = null;

// DOM Elements
const searchInput = document.getElementById('searchInput');
const clearBtn = document.getElementById('btnClear');
const aiToggleBtn = document.getElementById('btnAiToggle');
const tableBody = document.getElementById('tableBody');
const emptyState = document.getElementById('emptyState');
const statMatches = document.getElementById('statMatches');
const statElapsed = document.getElementById('statElapsed');
const statTotalIndexed = document.getElementById('statTotalIndexed');
const titlebarStatus = document.getElementById('titlebarStatusText');
const statusDot = document.querySelector('.status-dot');

// Modals
const quickLookModal = document.getElementById('quickLookModal');
const remoteModal = document.getElementById('remoteModal');
const storageModal = document.getElementById('storageModal');
const settingsModal = document.getElementById('settingsModal');
const syntaxModal = document.getElementById('syntaxModal');
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

// Perform Search
async function executeSearch() {
  const rawInput = searchInput.value.trim();
  const query = (currentFilter ? currentFilter + ' ' : '') + rawInput;

  clearBtn.style.display = rawInput ? 'block' : 'none';

  try {
    const res = await window.dawithAPI.search(query, {
      useAI: isAiMode,
      sortBy: currentSortBy,
      sortOrder: currentSortOrder,
      limit: 1000
    });

    searchResults = res.results || [];
    selectedIndex = searchResults.length > 0 ? 0 : -1;
    renderResults(searchResults, rawInput);

    statMatches.textContent = `${res.totalMatches.toLocaleString()}개 항목 발견`;
    statElapsed.textContent = `${res.elapsedMs} ms`;
    statTotalIndexed.textContent = `색인 항목: ${res.totalIndexed.toLocaleString()}개`;
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
    return;
  }
  emptyState.style.display = 'none';

  const fragment = document.createDocumentFragment();

  items.forEach((item, idx) => {
    const row = document.createElement('div');
    row.className = `table-row ${idx === selectedIndex ? 'selected' : ''}`;
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
      selectRow(idx);
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
  const rows = tableBody.children;
  for (let i = 0; i < rows.length; i++) {
    rows[i].classList.toggle('selected', i === selectedIndex);
  }
  scrollToSelected();
}

function scrollToSelected() {
  const selectedEl = tableBody.querySelector('.table-row.selected');
  if (selectedEl) {
    selectedEl.scrollIntoView({ block: 'nearest' });
  }
}

// File Actions
function getFullPath(item) {
  return item.path + (item.path.endsWith('\\') ? '' : '\\') + item.name;
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
  const fileUrl = 'file:///' + encodeURI(full.replace(/\\/g, '/')).replace(/#/g, '%23');

  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(ext)) {
    bodyEl.innerHTML = `<img src="${fileUrl}" alt="Preview" />`;
    return;
  }

  // Handle Audio / Video
  if (['mp4', 'webm', 'ogg'].includes(ext)) {
    bodyEl.innerHTML = `<video controls autoplay style="max-width:100%; max-height:100%;"><source src="${fileUrl}" type="video/${ext}"></video>`;
    return;
  }
  if (['mp3', 'wav'].includes(ext)) {
    bodyEl.innerHTML = `<audio controls autoplay><source src="${fileUrl}" type="audio/${ext}"></audio>`;
    return;
  }

  // Handle Text / Code / Documents
  const res = await window.dawithAPI.getFileContent(full);
  if (res.success) {
    bodyEl.innerHTML = `<pre>${escapeHtml(res.content)}</pre>`;
  } else {
    bodyEl.innerHTML = `<div style="text-align:center; color:#94a3b8;">미리보기를 지원하지 않는 바이너리 파일입니다.<br><button class="btn btn-primary mt-2" onclick="openItem(searchResults[selectedIndex])">기본 프로그램으로 열기</button></div>`;
  }
}

// Command Palette Implementation (Ctrl+K)
const cmdPaletteModal = document.getElementById('cmdPaletteModal');
const cmdPaletteInput = document.getElementById('cmdPaletteInput');
const cmdPaletteList = document.getElementById('cmdPaletteList');

function openCommandPalette() {
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
  } else if (action === 'open-remote') {
    document.getElementById('btnRemoteServer').click();
  } else if (action === 'open-storage') {
    document.getElementById('btnStorageAnalyzer').click();
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
    contextMenu.style.display = 'none';
    return;
  }

  // Focus search input on Ctrl+F
  if (e.ctrlKey && e.key === 'f') {
    searchInput.focus();
    searchInput.select();
    e.preventDefault();
    return;
  }

  // Command Palette on Ctrl+K
  if (e.ctrlKey && e.key === 'k') {
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
      if (e.ctrlKey) {
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
  } else if (e.ctrlKey && e.key === 'c' && document.activeElement !== searchInput && selectedIndex >= 0) {
    const full = getFullPath(searchResults[selectedIndex]);
    window.dawithAPI.copyPath(full);
  }
});

// Rename / Delete
async function renameItemPrompt(item) {
  if (!item) return;
  const oldFull = getFullPath(item);
  const newName = prompt('새 파일/폴더 이름을 입력하세요:', item.name);
  if (newName && newName !== item.name) {
    const newFull = item.path + (item.path.endsWith('\\') ? '' : '\\') + newName;
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
    executeSearch();
  }
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

async function loadStorageOverview() {
  const data = await window.dawithAPI.getStorageAnalysis();
  if (!data) return;
  const storageBody = document.getElementById('storageBody');
  const cats = data.categories;

  storageBody.innerHTML = `
    <div style="margin-bottom:14px;">
      <h4 style="color:#f3f4f6; margin-bottom:4px;">전체 색인 파일: ${data.totalFiles.toLocaleString()}개 (${formatBytes(data.totalBytes)})</h4>
      <p style="color:#94a3b8; font-size:11px;">카테고리별 디스크 사용량 현황입니다.</p>
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
    <div style="display:grid; grid-template-columns:repeat(2, 1fr); gap:8px; margin-top:16px;">
      ${Object.values(cats).map(c => `
        <div style="background:#1e293b; padding:10px; border-radius:6px; border:1px solid #334155;">
          <div style="font-weight:600; color:#e2e8f0;">${c.label}</div>
          <div style="color:#38bdf8; font-size:14px; font-weight:700;">${formatBytes(c.bytes)}</div>
          <div style="color:#64748b; font-size:11px;">${c.count.toLocaleString()}개 파일</div>
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
  storageBody.innerHTML = '<div style="padding:20px; text-align:center; color:#94a3b8;">중복 파일 해시 분석 중... (잠시만 기다려주세요)</div>';

  const res = await window.dawithAPI.findDuplicates({ minSize: 10240 }); // > 10KB
  if (res.groups.length === 0) {
    storageBody.innerHTML = '<div style="padding:20px; text-align:center; color:#10b981;">축하합니다! 발견된 중복 파일이 없습니다.</div>';
    return;
  }

  storageBody.innerHTML = `
    <div style="margin-bottom:12px; color:#f3f4f6;">
      발견된 중복 그룹: <strong>${res.groups.length}개</strong> (절약 가능한 공간: <span style="color:#ef4444; font-weight:bold;">${formatBytes(res.totalWastedBytes)}</span>)
    </div>
    <div style="max-height:350px; overflow-y:auto; display:flex; flex-direction:column; gap:10px;">
      ${res.groups.map(grp => `
        <div style="background:#1e293b; border:1px solid #334155; border-radius:6px; padding:10px;">
          <div style="display:flex; justify-content:space-between; font-weight:600; margin-bottom:6px;">
            <span>${grp.items[0].name} (${formatBytes(grp.size)})</span>
            <span style="color:#f59e0b;">${grp.items.length}개 중복</span>
          </div>
          ${grp.items.map(it => `
            <div style="font-size:11px; color:#94a3b8; display:flex; justify-content:space-between; padding:3px 0; border-top:1px solid #283548;">
              <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:500px;" title="${getFullPath(it)}">${getFullPath(it)}</span>
              <button class="btn btn-sm btn-ghost" onclick="window.dawithAPI.openFolder('${getFullPath(it).replace(/\\/g, '\\\\')}')">위치</button>
            </div>
          `).join('')}
        </div>
      `).join('')}
    </div>
  `;
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
  const rootsList = document.getElementById('rootsList');
  rootsList.innerHTML = (cfg.roots || []).map(r => `<div style="padding:4px 8px; background:#1e293b; border-radius:4px; margin-bottom:4px; font-family:monospace;">📁 ${r}</div>`).join('');
});
document.getElementById('btnCloseSettings').addEventListener('click', () => {
  settingsModal.style.display = 'none';
});
document.getElementById('btnReindexNow').addEventListener('click', async () => {
  await window.dawithAPI.reindex();
  settingsModal.style.display = 'none';
});

// Syntax Guide
document.getElementById('syntaxHintBtn').addEventListener('click', () => {
  syntaxModal.style.display = 'flex';
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
  }
});

// Initial Search on App Launch
executeSearch();
