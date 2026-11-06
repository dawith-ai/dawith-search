const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const version = require(path.join(root, 'package.json')).version;
const expectedEntry = 'src/engine/root-manager.js';
const expectedAnalyzer = 'src/engine/evidence-analyzer.js';
const expectedGozClient = 'bin/native/windows/x64/goz.exe';
const expectedGozDaemon = 'bin/native/windows/x64/gozd.exe';
const expectedEverythingIpc = 'bin/native/windows/x64/everything-ipc.exe';

function requireFile(filePath) {
  assert.ok(fs.existsSync(filePath), `Missing build artifact: ${path.relative(root, filePath)}`);
  assert.ok(fs.statSync(filePath).size > 0, `Empty build artifact: ${path.relative(root, filePath)}`);
}

const asarPath = process.platform === 'darwin'
  ? path.join(root, 'dist', 'mac-universal', 'Dawith Search.app', 'Contents', 'Resources', 'app.asar')
  : path.join(root, 'dist', 'win-unpacked', 'resources', 'app.asar');

requireFile(asarPath);
if (process.platform === 'darwin') {
  requireFile(path.join(root, 'dist', `Dawith Search-${version}-universal.dmg`));
  requireFile(path.join(root, 'dist', `Dawith Search-${version}-universal-mac.zip`));
} else if (process.platform === 'win32') {
  requireFile(path.join(root, 'dist', `DawithSearch-${version}-portable.exe`));
  requireFile(path.join(root, 'dist', 'nsis-web', `DawithSearch-${version}-web-setup.exe`));
}

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const listing = execFileSync(npx, ['--no-install', 'asar', 'list', asarPath], {
  encoding: 'utf8',
  // Windows exposes npx as a .cmd shim, which requires a shell when spawned
  // from Node's execFileSync API.
  shell: process.platform === 'win32'
}).replace(/\\/g, '/');
assert.ok(listing.includes(expectedEntry), `Packaged app is missing ${expectedEntry}`);
assert.ok(listing.includes(expectedAnalyzer), `Packaged app is missing ${expectedAnalyzer}`);
if (process.platform === 'win32') {
  assert.ok(listing.includes(expectedGozClient), `Packaged app is missing ${expectedGozClient}`);
  assert.ok(listing.includes(expectedGozDaemon), `Packaged app is missing ${expectedGozDaemon}`);
  assert.ok(listing.includes(expectedEverythingIpc), `Packaged app is missing ${expectedEverythingIpc}`);
}
console.log(`Build artifact verification passed on ${process.platform}: ${path.relative(root, asarPath)}`);
