const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const repoRoot = path.resolve(__dirname, '..');
const electronBinary = process.env.DAWITH_E2E_BINARY || require('electron');
const runId = `${Date.now()}-${process.pid}`;
const fixtureRoot = path.join(os.tmpdir(), `dawith-search-e2e-fixture-${runId}`);
const tempHome = path.join(os.tmpdir(), `dawith-search-e2e-home-${runId}`);
const userDataDir = path.join(os.tmpdir(), `dawith-search-e2e-user-data-${runId}`);
const screenshotPath = path.join(os.tmpdir(), `dawith-search-e2e-${runId}.png`);

let appProcess;
let browserSocket;
let cdpId = 0;
const cdpPending = new Map();
const assertions = [];

function record(name, details = '') {
  assertions.push({ name, details });
  console.log(`PASS  ${name}${details ? ` — ${details}` : ''}`);
}

function fail(message) {
  throw new Error(message);
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(label, predicate, timeoutMs = 15000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await wait(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

function createFixture() {
  fs.mkdirSync(path.join(fixtureRoot, 'nested'), { recursive: true });
  fs.mkdirSync(path.join(tempHome, '.dawith-search'), { recursive: true });
  fs.mkdirSync(userDataDir, { recursive: true });

  fs.writeFileSync(
    path.join(fixtureRoot, 'contract-agreement.txt'),
    '사회복지기관 계약서\n수급자 개인정보 보호와 사례관리 업무를 위한 문서입니다.\n',
    'utf8'
  );
  fs.writeFileSync(path.join(fixtureRoot, 'budget-2026.csv'), '항목,금액\n인건비,1200000\n', 'utf8');
  fs.writeFileSync(path.join(fixtureRoot, 'photo-report.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  const duplicateContent = crypto.randomBytes(12 * 1024);
  fs.writeFileSync(path.join(fixtureRoot, 'duplicate-a.bin'), duplicateContent);
  fs.writeFileSync(path.join(fixtureRoot, 'nested', 'duplicate-b.bin'), duplicateContent);
  fs.writeFileSync(path.join(fixtureRoot, 'nested', 'case-note.md'), '# 사례관리 기록\n보호자 상담 일정\n', 'utf8');

  fs.writeFileSync(path.join(tempHome, '.dawith-search', 'config.json'), JSON.stringify({
    roots: [fixtureRoot],
    excludeFolders: [],
    excludeHidden: false,
    maxDepth: 12,
    autoStartWatcher: false,
    searchBackend: 'local'
  }, null, 2));
}

function httpRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, {
      method: options.method || 'GET',
      headers: options.headers || {},
      timeout: 5000
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks)
      }));
    });
    request.on('timeout', () => request.destroy(new Error('HTTP request timed out')));
    request.on('error', reject);
    request.end(options.body);
  });
}

async function getJson(url) {
  const response = await httpRequest(url);
  return JSON.parse(response.body.toString('utf8'));
}

async function waitForDebugTarget(port, predicate) {
  return waitFor('Electron CDP target', async () => {
    const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
    return targets.find(predicate);
  }, 20000, 200);
}

function connectCdp(webSocketUrl) {
  return new Promise((resolve, reject) => {
    browserSocket = new WebSocket(webSocketUrl);
    browserSocket.once('open', resolve);
    browserSocket.once('error', reject);
    browserSocket.on('message', message => {
      const payload = JSON.parse(message.toString());
      if (!payload.id || !cdpPending.has(payload.id)) return;
      const pending = cdpPending.get(payload.id);
      cdpPending.delete(payload.id);
      if (payload.error) pending.reject(new Error(payload.error.message));
      else pending.resolve(payload.result);
    });
  });
}

function cdp(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++cdpId;
    cdpPending.set(id, { resolve, reject });
    browserSocket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression, awaitPromise = false) {
  const result = await cdp('Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true,
    userGesture: true
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  }
  return result.result ? result.result.value : undefined;
}

async function click(selector) {
  const clicked = await evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return false;
    element.click();
    return true;
  })()`);
  assert.strictEqual(clicked, true, `Element not found: ${selector}`);
}

async function realClick(selector) {
  const box = await evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  assert.ok(box, `Element not found: ${selector}`);
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
}

async function setSearch(value) {
  await evaluate(`(() => {
    const input = document.querySelector('#searchInput');
    input.focus();
    input.value = ${JSON.stringify(value)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return input.value;
  })()`);
  await wait(250);
}

async function pageState() {
  return evaluate(`({
    title: document.title,
    hasApi: Boolean(window.dawithAPI),
    indexed: document.querySelector('#statTotalIndexed')?.textContent || '',
    matches: document.querySelector('#statMatches')?.textContent || '',
    rows: document.querySelectorAll('#tableBody .table-row').length,
    rowText: document.querySelector('#tableBody')?.textContent || '',
    bodyClass: document.body.className,
    toolsHidden: document.querySelector('#toolsMenu')?.hidden,
    quickLookDisplay: document.querySelector('#quickLookModal')?.style.display,
    remoteDisplay: document.querySelector('#remoteModal')?.style.display,
    storageDisplay: document.querySelector('#storageModal')?.style.display,
    settingsDisplay: document.querySelector('#settingsModal')?.style.display,
    commandDisplay: document.querySelector('#cmdPaletteModal')?.style.display,
    selectionHidden: document.querySelector('#selectionBar')?.hidden,
    selectionSummary: document.querySelector('#selectionSummary')?.textContent || ''
  })`);
}

async function waitForState(label, predicate, timeoutMs = 15000) {
  let latest;
  try {
    return await waitFor(label, async () => {
      latest = await pageState();
      return predicate(latest);
    }, timeoutMs, 100);
  } catch (error) {
    error.message += `\nLast page state: ${JSON.stringify(latest)}`;
    throw error;
  }
}

async function startApp(port) {
  const stdout = [];
  const stderr = [];
  const launchArgs = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--disable-gpu'
  ];
  if (!process.env.DAWITH_E2E_BINARY) launchArgs.push(repoRoot);
  appProcess = spawn(electronBinary, launchArgs, {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: tempHome,
      USERPROFILE: tempHome,
      APPDATA: path.join(tempHome, 'AppData', 'Roaming'),
      LOCALAPPDATA: path.join(tempHome, 'AppData', 'Local'),
      ELECTRON_ENABLE_LOGGING: '1',
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  appProcess.stdout.on('data', chunk => stdout.push(chunk.toString()));
  appProcess.stderr.on('data', chunk => stderr.push(chunk.toString()));
  appProcess.on('error', error => stderr.push(`spawn error: ${error.stack}\n`));

  try {
    const target = await waitForDebugTarget(port, item => item.type === 'page' && item.url.includes('index.html'));
    await connectCdp(target.webSocketDebuggerUrl);
    await cdp('Runtime.enable');
    await cdp('Page.enable');
    await waitFor('renderer DOM', async () => (await evaluate("document.readyState === 'complete' && Boolean(document.querySelector('#searchInput'))")) === true, 15000);
    return { stdout, stderr };
  } catch (error) {
    error.message += `\nElectron stdout:\n${stdout.join('')}\nElectron stderr:\n${stderr.join('')}`;
    throw error;
  }
}

async function saveScreenshot() {
  const screenshot = await cdp('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));
}

async function closeApp() {
  if (browserSocket) {
    try { browserSocket.close(); } catch (_) { /* already closed */ }
    browserSocket = null;
  }
  if (appProcess && !appProcess.killed) {
    appProcess.kill('SIGTERM');
    await waitFor('Electron exit', () => appProcess.exitCode !== null, 5000).catch(() => appProcess.kill('SIGKILL'));
  }
}

async function run() {
  createFixture();
  const port = 9200 + (process.pid % 500);
  const logs = await startApp(port);

  await waitForState(
    'indexed fixture',
    state => /색인 항목:\s*[1-9]\d*개/.test(state.indexed) && state.rows > 0,
    20000
  );
  const initialState = await pageState();
  assert.strictEqual(initialState.hasApi, true);
  assert.strictEqual(initialState.title, 'Dawith Search');
  record('앱 창·렌더러·preload API 로드', `색인 상태: ${initialState.indexed}`);

  await setSearch('contract');
  await waitForState('search results', state => state.rows > 0 && state.rowText.includes('contract-agreement.txt'));
  record('파일명 검색', 'contract-agreement.txt 검색 결과 확인');

  await setSearch('content:개인정보');
  await waitForState('content search results', state => state.rows > 0 && state.rowText.includes('contract-agreement.txt'));
  record('본문 검색', 'content:개인정보 결과 확인');

  await click('#filterTabs [data-filter="doc:"]');
  await waitForState('document filter', state => state.rows > 0 && state.rowText.includes('contract-agreement.txt'));
  record('Everything 문서 필터', 'doc: 필터 결과 확인');

  await click('#filterTabs [data-filter=""]');
  await setSearch('');
  await waitForState('all results', state => state.rows >= 6);
  await evaluate(`(() => {
    const rows = [...document.querySelectorAll('#tableBody .table-row')];
    rows[0]?.click();
    rows[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    return rows.length;
  })()`);
  await waitForState('multi selection', state => state.selectionHidden === false && state.selectionSummary.includes('2'));
  record('다중 선택·선택 작업바', '2개 선택 상태 확인');

  await setSearch('contract');
  await waitForState('quick look target', state => state.rows === 1 && state.rowText.includes('contract-agreement.txt'));
  await evaluate("document.querySelector('#tableBody .table-row')?.click()");
  await evaluate("document.querySelector('#searchInput')?.blur()");
  await evaluate("document.body.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, code: 'Space', key: ' ' }))");
  await waitForState('quick look', state => state.quickLookDisplay === 'flex');
  const quickLook = await evaluate("({ name: document.querySelector('#qlName')?.textContent, body: document.querySelector('#qlBody')?.textContent })");
  assert.ok(quickLook.name);
  assert.ok(quickLook.body.includes('사회복지기관') || quickLook.body.includes('미리보기를'));
  record('Space Quick Look', `${quickLook.name} 미리보기 확인`);
  await click('#qlBtnClose');

  await setSearch('contract');
  await evaluate("window.prompt = () => 'E2E 저장 검색'");
  await click('#btnSaveBookmark');
  await waitFor('saved bookmark', async () => (await evaluate("document.querySelectorAll('#bookmarkList [data-bookmark-id]').length")) > 0);
  const bookmarkQuery = await evaluate("document.querySelector('#bookmarkList [data-bookmark-id] small')?.textContent || ''");
  assert.ok(bookmarkQuery.includes('contract'));
  record('저장 검색·사이드바 복원 데이터', `저장 쿼리: ${bookmarkQuery}`);
  await click('#bookmarkList [data-bookmark-id]');
  await waitForState('bookmark restore', state => state.rowText.includes('contract-agreement.txt'));
  record('저장 검색 다시 실행', '사이드바 항목 클릭 후 결과 복원');

  await realClick('#tableBody .row-star');
  await waitFor('starred result state', async () => {
    const starred = await evaluate("window.dawithAPI.search('contract', { limit: 10 }).then(result => result.results.some(item => item.name === 'contract-agreement.txt' && item.starred))", true);
    return starred === true;
  });
  await waitFor('starred result render', async () => (await evaluate("document.querySelector('#tableBody .row-star')?.classList.contains('active')")) === true);
  await click('#filterTabs [data-filter="starred:"]');
  await waitForState('starred filter', state => state.rows > 0 && state.rowText.includes('contract-agreement.txt'));
  record('즐겨찾기·즐겨찾기 필터', '검색 결과 별표 및 starred: 확인');
  await click('#filterTabs [data-filter=""]');
  await setSearch('contract');

  await click('#btnAiToggle');
  const aiEnabled = await evaluate("document.querySelector('#btnAiToggle')?.classList.contains('active')");
  assert.strictEqual(aiEnabled, true);
  await click('#btnAiToggle');
  record('규칙 기반 자연어 모드 토글', '외부 API 없이 renderer 상태 전환 확인');

  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'k', code: 'KeyK', ctrlKey: true }))");
  await waitForState('command palette', state => state.commandDisplay === 'flex');
  record('Ctrl/Cmd+K 명령 팔레트', '팔레트 열림');
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape', code: 'Escape' }))");

  await click('#btnTools');
  await waitForState('tools menu', state => state.toolsHidden === false);
  record('도구 메뉴', '도구 메뉴 열림');
  await click('#btnThemeToggle');
  const darkTheme = await evaluate("document.body.classList.contains('dark-theme')");
  assert.strictEqual(darkTheme, true);
  record('라이트·다크 테마 전환', 'dark-theme 적용 확인');

  await click('#btnTools');
  await click('#btnSettings');
  await waitForState('settings modal', state => state.settingsDisplay === 'flex');
  const settingsRoot = await evaluate("document.querySelector('#rootsList')?.textContent || ''");
  assert.ok(settingsRoot.includes(path.basename(fixtureRoot)));
  record('설정·검색 루트 표시', '격리 fixture root 확인');
  await click('#btnReindexNow');
  await waitForState('manual reindex', state => state.settingsDisplay === 'none' && /색인 항목:\s*[1-9]\d*개/.test(state.indexed));
  record('수동 전체 재색인', '설정의 Reindex 완료');
  await click('#btnCloseSettings');

  await click('#btnTools');
  await click('#btnStorageAnalyzer');
  await waitForState('storage analyzer', state => state.storageDisplay === 'flex');
  await waitFor('storage summary', async () => (await evaluate("document.querySelector('#storageBody')?.textContent || ''")).includes('전체 색인 파일'));
  record('용량 분석기', '용량 현황 탭 렌더링 확인');
  await click('#tabDuplicates');
  await waitFor('duplicate analysis', async () => (await evaluate("document.querySelector('#storageBody')?.textContent || ''")).includes('중복') || (await evaluate("document.querySelector('#storageBody')?.textContent || ''")).includes('없습니다'));
  record('중복 파일 분석', '중복 탭 완료');
  await click('#tabLargestFiles');
  await waitFor('largest files', async () => (await evaluate("document.querySelector('#storageBody')?.textContent || ''")).includes('duplicate-a.bin'));
  record('대용량 파일 목록', 'TOP 50 탭 완료');
  await evaluate("document.querySelector('#btnCloseStorage').click()");

  await click('#btnTools');
  await click('#btnRemoteServer');
  await waitForState('remote modal', state => state.remoteDisplay === 'flex');
  const remoteUrl = await waitFor('remote URL', async () => evaluate("document.querySelector('#remoteUrlInput')?.value || ''"));
  assert.ok(remoteUrl.includes('token='));
  const parsedRemote = new URL(remoteUrl);
  const localRemote = `http://127.0.0.1:${parsedRemote.port}`;
  const unauthorized = await httpRequest(`${localRemote}/api/search?q=contract`);
  assert.strictEqual(unauthorized.statusCode, 401);
  const authorized = await httpRequest(`${localRemote}/api/search?q=contract&token=${encodeURIComponent(parsedRemote.searchParams.get('token'))}`);
  assert.strictEqual(authorized.statusCode, 200);
  const remoteData = JSON.parse(authorized.body.toString('utf8'));
  assert.ok(remoteData.results.some(item => item.name === 'contract-agreement.txt'));
  const filePath = path.join(fixtureRoot, 'contract-agreement.txt');
  const downloaded = await httpRequest(`${localRemote}/api/download?path=${encodeURIComponent(filePath)}&token=${encodeURIComponent(parsedRemote.searchParams.get('token'))}`);
  assert.strictEqual(downloaded.statusCode, 200);
  assert.ok(downloaded.body.toString('utf8').includes('개인정보'));
  const traversal = await httpRequest(`${localRemote}/api/download?path=${encodeURIComponent('/etc/passwd')}&token=${encodeURIComponent(parsedRemote.searchParams.get('token'))}`);
  assert.strictEqual(traversal.statusCode, 404);
  record('모바일 원격 공유·토큰 인증', `비인증 401 / 인증 검색 ${remoteData.results.length}건`);
  await click('#btnCloseRemote');

  await click('#syntaxHintBtn');
  const guideTarget = await waitForDebugTarget(port, item => item.type === 'page' && item.url.includes('guide.html'));
  const guideSocket = new WebSocket(guideTarget.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    guideSocket.once('open', resolve);
    guideSocket.once('error', reject);
  });
  let guideCdpId = 0;
  const guidePending = new Map();
  guideSocket.on('message', message => {
    const payload = JSON.parse(message.toString());
    if (!payload.id || !guidePending.has(payload.id)) return;
    const pending = guidePending.get(payload.id);
    guidePending.delete(payload.id);
    if (payload.error) pending.reject(new Error(payload.error.message));
    else pending.resolve(payload.result);
  });
  const guideCdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++guideCdpId;
    guidePending.set(id, { resolve, reject });
    guideSocket.send(JSON.stringify({ id, method, params }));
  });
  await guideCdp('Runtime.enable');
  const guideResult = await waitFor('guide document', async () => {
    const result = await guideCdp('Runtime.evaluate', {
      expression: "document.readyState === 'complete' ? ({ title: document.title, links: [...document.querySelectorAll('a')].map(a => a.href), text: document.body.innerText }) : null",
      returnByValue: true
    });
    return result.result?.value || false;
  }, 10000, 100);
  guideSocket.close();
  assert.strictEqual(guideResult.title, 'Dawith Search 사용 안내');
  assert.ok(guideResult.links.some(link => link.includes('voidtools.com/ko-kr/')));
  assert.ok(guideResult.links.some(link => link.includes('github.com/dawith-ai/dawith-search/releases/latest')));
  record('사용 안내 페이지', 'Voidtools 공식 링크·최신 앱 다운로드 링크 확인');

  await saveScreenshot();
  console.log(`E2E_SCREENSHOT=${screenshotPath}`);
  console.log(`E2E_ASSERTIONS=${assertions.length}`);
  if (logs.stderr.join('').includes('UnhandledPromiseRejection')) {
    fail(`Electron emitted an unhandled rejection:\n${logs.stderr.join('')}`);
  }
}

(async () => {
  try {
    await run();
    console.log('ELECTRON E2E PASSED');
  } catch (error) {
    console.error(`ELECTRON E2E FAILED: ${error.stack || error.message}`);
    process.exitCode = 1;
  } finally {
    await closeApp();
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
    fs.rmSync(tempHome, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
})();
