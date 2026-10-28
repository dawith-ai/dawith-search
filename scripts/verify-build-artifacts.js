const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const expectedEntry = 'src/engine/root-manager.js';
const expectedAnalyzer = 'src/engine/evidence-analyzer.js';

function requireFile(filePath) {
  assert.ok(fs.existsSync(filePath), `Missing build artifact: ${path.relative(root, filePath)}`);
  assert.ok(fs.statSync(filePath).size > 0, `Empty build artifact: ${path.relative(root, filePath)}`);
}

const asarPath = process.platform === 'darwin'
  ? path.join(root, 'dist', 'mac-universal', 'Dawith Search.app', 'Contents', 'Resources', 'app.asar')
  : path.join(root, 'dist', 'win-unpacked', 'resources', 'app.asar');

requireFile(asarPath);
if (process.platform === 'darwin') {
  requireFile(path.join(root, 'dist', 'Dawith Search-1.0.4-universal.dmg'));
  requireFile(path.join(root, 'dist', 'Dawith Search-1.0.4-universal-mac.zip'));
} else if (process.platform === 'win32') {
  requireFile(path.join(root, 'dist', 'DawithSearch-1.0.4-portable.exe'));
}

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const listing = execFileSync(npx, ['--no-install', 'asar', 'list', asarPath], { encoding: 'utf8' });
assert.ok(listing.includes(expectedEntry), `Packaged app is missing ${expectedEntry}`);
assert.ok(listing.includes(expectedAnalyzer), `Packaged app is missing ${expectedAnalyzer}`);
console.log(`Build artifact verification passed on ${process.platform}: ${path.relative(root, asarPath)}`);
