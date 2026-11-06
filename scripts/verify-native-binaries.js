const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

if (process.platform !== 'win32') {
  console.log('Skipping Windows native binary smoke test on non-Windows host.');
  process.exit(0);
}

const archFlag = process.argv.indexOf('--arch');
const arch = archFlag >= 0 && process.argv[archFlag + 1] === 'arm64' ? 'arm64' : 'x64';
const root = path.join(__dirname, '..');
const binaryDir = path.join(root, 'bin', 'native', 'windows', arch);

const binaries = ['goz.exe', 'gozd.exe'];
if (arch === 'x64') binaries.push('everything-ipc.exe');
for (const binary of binaries) {
  const filePath = path.join(binaryDir, binary);
  if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) {
    throw new Error(`Missing Windows native binary: ${filePath}`);
  }
  const args = ['--version'];
  const output = execFileSync(filePath, args, { encoding: 'utf8', windowsHide: true }).trim();
  if (!output) throw new Error(`${binary} returned an empty version string.`);
  console.log(`${binary}: ${output}`);
}
