const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { classifyRoot, inspectRoot } = require('../src/engine/root-manager');

async function main() {
  assert.strictEqual(classifyRoot('\\\\server\\share\\department').kind, 'windows-unc');
  assert.strictEqual(classifyRoot('Z:\\agency\\documents').kind, 'windows-drive');
  assert.strictEqual(classifyRoot('/Volumes/agency-share').kind, 'mac-mounted-share');
  assert.strictEqual(classifyRoot('relative/folder').kind, 'invalid');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dawith-root-'));
  const filePath = path.join(root, 'not-a-folder.txt');
  fs.writeFileSync(filePath, 'fixture');
  try {
    const valid = await inspectRoot(root);
    assert.strictEqual(valid.success, true);
    assert.strictEqual(valid.reachable, true);
    const invalid = await inspectRoot(filePath);
    assert.strictEqual(invalid.success, false);
    const relative = await inspectRoot('relative/folder');
    assert.strictEqual(relative.success, false);
    console.log('Root manager tests passed (UNC, mapped drive, mounted share, reachability, validation).');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
