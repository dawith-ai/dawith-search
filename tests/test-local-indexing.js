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
  const progressDir = path.join(root, 'progress-fixture');
  fs.mkdirSync(progressDir, { recursive: true });
  for (let index = 0; index < 260; index += 1) {
    fs.writeFileSync(path.join(progressDir, `indexed-${String(index).padStart(3, '0')}.txt`), `fixture ${index}`, 'utf8');
  }
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
  const progressEvents = [];
  indexer.on('indexing-progress', stats => progressEvents.push(stats));
  try {
    if (process.platform !== 'win32') fs.chmodSync(protectedDir, 0o000);
    await indexer.startIndexing();

    assert.ok(indexer.records.some(record => record.fullPath === visibleFile), 'deep local file was not indexed');
    assert.ok(indexer.stats.totalFiles >= 1, 'local index contains no files');
    assert.ok(progressEvents.length > 0, 'large local scans must publish partial indexing progress');
    assert.ok(progressEvents.some(stats => stats.totalFiles >= 250), 'partial progress must expose indexed files before completion');
    console.log(`Local indexing regression passed (deep file, protected directory, and ${progressEvents.length} partial progress event(s)).`);
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
