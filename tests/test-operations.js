const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const RemoteServer = require('../src/engine/remote-server');
const { readJsonWithBackup, writeJsonAtomic } = require('../src/engine/storage-utils');

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = http.request({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: options.method || 'GET',
      headers: options.headers || {}
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks)
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function main() {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dawith-operations-'));
  const root = path.join(testDir, 'shared');
  const safeFile = path.join(root, 'safe.txt');
  const secretFile = path.join(testDir, 'secret.txt');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(safeFile, 'safe content');
  fs.writeFileSync(secretFile, 'secret content');

  const stateFile = path.join(testDir, 'state.json');
  writeJsonAtomic(stateFile, { version: 1 });
  writeJsonAtomic(stateFile, { version: 2 });
  fs.writeFileSync(stateFile, '{broken');
  assert.deepStrictEqual(readJsonWithBackup(stateFile, null), { version: 1 });
  if (process.platform !== 'win32') {
    assert.strictEqual(fs.statSync(testDir).mode & 0o777, 0o700);
    assert.strictEqual(fs.statSync(`${stateFile}.bak`).mode & 0o777, 0o600);
  }
  console.log('  ✓ Atomic private storage writes and backup recovery passed');

  const indexer = {
    config: { roots: [root] },
    isWithinConfiguredRoot(filePath) {
      const candidate = path.resolve(filePath);
      const rootPath = path.resolve(root);
      const relative = path.relative(rootPath, candidate);
      return relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    },
    async search(query, options) {
      assert.strictEqual(options.forceLocal, true);
      return { results: [{ name: 'safe.txt', path: root, fullPath: safeFile }], totalMatches: 1, elapsedMs: 0 };
    }
  };
  const remote = new RemoteServer(indexer);
  const info = await remote.start(0);
  const token = new URL(info.url).searchParams.get('token');
  assert.ok(token && token.length >= 32);
  const baseUrl = `http://127.0.0.1:${info.port}`;

  const unauthorized = await request(`${baseUrl}/`);
  assert.strictEqual(unauthorized.statusCode, 401);

  const authorized = await request(`${baseUrl}/?token=${encodeURIComponent(token)}`);
  assert.strictEqual(authorized.statusCode, 200);
  const cookie = String(authorized.headers['set-cookie'][0]).split(';')[0];
  const search = await request(`${baseUrl}/api/search?q=safe`, { headers: { Cookie: cookie } });
  assert.strictEqual(search.statusCode, 200);
  const download = await request(`${baseUrl}/api/download?path=${encodeURIComponent(safeFile)}`, { headers: { Cookie: cookie } });
  assert.strictEqual(download.statusCode, 200);
  assert.strictEqual(download.body.toString(), 'safe content');
  const blocked = await request(`${baseUrl}/api/download?path=${encodeURIComponent(secretFile)}`, { headers: { Cookie: cookie } });
  assert.strictEqual(blocked.statusCode, 404);
  remote.stop();
  fs.rmSync(testDir, { recursive: true, force: true });
  console.log('  ✓ Remote token auth, local-only search, and root allowlist passed');
  console.log('✅ OPERATIONAL SECURITY TESTS PASSED (0 ERRORS)');
}

main().catch(error => {
  console.error('Operational test error:', error);
  process.exitCode = 1;
});
