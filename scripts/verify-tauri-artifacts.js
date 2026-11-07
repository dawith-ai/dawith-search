const fs = require('fs');
const path = require('path');

const bundleRoot = path.join('src-tauri', 'target', 'release', 'bundle');
if (!fs.existsSync(bundleRoot)) {
  throw new Error(`Tauri bundle directory does not exist: ${bundleRoot}`);
}

const files = [];
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(fullPath);
    else files.push(fullPath);
  }
}
walk(bundleRoot);

const expected = process.platform === 'win32'
  ? files.filter(file => file.toLowerCase().endsWith('.exe'))
  : process.platform === 'darwin'
    ? files.filter(file => file.toLowerCase().endsWith('.dmg') || file.endsWith('.app'))
    : files;

if (!expected.length) {
  throw new Error(`No Tauri release artifact found for ${process.platform}.`);
}
const summary = expected.map(file => `${file} (${fs.statSync(file).size} bytes)`);
console.log(`Tauri artifacts passed (${expected.length}):\n${summary.join('\n')}`);
