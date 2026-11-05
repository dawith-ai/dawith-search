const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Indexer = require('../src/engine/indexer');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dawith-local-index-'));
  const storageDir = path.join(root, '.storage');
  const nestedDir = path.join(root, 'level-1', 'level-2', 'level-3', 'level-4');
  const visibleFile = path.join(nestedDir, 'local-search-proof.txt');
  const protectedDir = path.join(root, 'protected-folder');

  fs.mkdirSync(nestedDir, { recursive: true });
  fs.writeFileSync(visibleFile, 'local index regression fixture', 'utf8');
  fs.mkdirSync(protectedDir, { recursive: true });
  fs.writeFileSync(path.join(protectedDir, 'should-not-stop-the-scan.txt'), 'permission fixture', 'utf8');

  const indexer = new Indexer({
    storageDir,
    nativeSearch: { search: async () => ({ supported: false }) }
  });
  indexer.config = {
    ...indexer.config,
    roots: [root],
    localRoots: [root],
    autoStartWatcher: false,
    maxDepth: 64
  };

  const originalMode = fs.statSync(protectedDir).mode;
  try {
    if (process.platform !== 'win32') fs.chmodSync(protectedDir, 0o000);
    await indexer.startIndexing();

    assert.ok(indexer.records.some(record => record.fullPath === visibleFile), 'deep local file was not indexed');
    assert.ok(indexer.stats.totalFiles >= 1, 'local index contains no files');
    console.log('Local indexing regression passed (deep file survives protected directory).');
  } finally {
    if (process.platform !== 'win32') fs.chmodSync(protectedDir, originalMode & 0o777);
    indexer.fileWatcher.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
