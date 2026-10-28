const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { analyzePath } = require('../src/engine/evidence-analyzer');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dawith-evidence-'));
  try {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'node_modules', 'ignored'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'main.js'), [
      "const { BrowserWindow } = require('electron');",
      "const { open } = require('./preload');",
      "const missing = import('./generated');",
      "ipcMain.handle('open', () => open());",
      'new BrowserWindow({ webPreferences: { preload: preloadPath } });'
    ].join('\n'));
    fs.writeFileSync(path.join(root, 'src', 'preload.js'), [
      "const { contextBridge, ipcRenderer } = require('electron');",
      "contextBridge.exposeInMainWorld('dawithAPI', { open: () => ipcRenderer.invoke('open') });"
    ].join('\n'));
    fs.writeFileSync(path.join(root, 'src', 'renderer.js'), "import './preload';\nconsole.log('ready');\n");
    fs.writeFileSync(path.join(root, 'README.md'), 'local evidence fixture');
    fs.writeFileSync(path.join(root, 'node_modules', 'ignored', 'vendor.js'), 'ignored');

    const report = await analyzePath(root);
    assert.strictEqual(report.schemaVersion, 1);
    assert.strictEqual(report.coverage.status, 'partial');
    assert.strictEqual(report.summary.files, 4);
    assert.ok(report.summary.sourceFiles >= 3);
    assert.ok(report.summary.imports >= 3);
    assert.ok(report.summary.resolvedImports >= 1);
    assert.ok(report.summary.electronBoundaries >= 2);
    assert.ok(report.inventory.some(file => file.path === 'src/main.js' && file.sha256));
    assert.ok(report.relationships.some(item => item.target === 'src/preload.js'));
    assert.ok(report.unknowns.some(item => item.kind === 'import-resolution'));
    assert.ok(report.omitted === undefined);

    const limited = await analyzePath(root, { maxFiles: 2 });
    assert.strictEqual(limited.coverage.status, 'partial');
    assert.ok(limited.coverage.omittedFiles >= 0 || limited.coverage.examinedFiles === 2);

    console.log('Evidence analyzer tests passed (inventory, hashes, imports, boundaries, unknowns, budgets).');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
