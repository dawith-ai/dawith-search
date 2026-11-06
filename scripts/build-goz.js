const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const nativeRoot = path.join(root, 'native', 'goz');
const requestedArch = process.argv.find(value => value === '--arch')
  ? process.argv[process.argv.indexOf('--arch') + 1]
  : (process.arch === 'arm64' ? 'arm64' : 'x64');
const arch = requestedArch === 'arm64' ? 'arm64' : 'x64';
const cargoTarget = arch === 'arm64' ? 'aarch64-pc-windows-msvc' : null;
const outputDir = path.join(root, 'bin', 'native', 'windows', arch);
const binaries = ['goz.exe', 'gozd.exe'];

if (process.platform !== 'win32') {
  console.log('Skipping goz Windows build on non-Windows host.');
  process.exit(0);
}

if (!fs.existsSync(path.join(nativeRoot, 'Cargo.toml'))) {
  throw new Error('Missing vendored goz source: native/goz/Cargo.toml');
}

const cargo = process.env.CARGO || 'cargo';
const cargoArgs = [
  'build',
  '--release',
  '--manifest-path',
  path.join(nativeRoot, 'Cargo.toml'),
  '--bin',
  'goz',
  '--bin',
  'gozd'
];
if (cargoTarget) cargoArgs.splice(2, 0, '--target', cargoTarget);
execFileSync(cargo, cargoArgs, {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true
});

fs.mkdirSync(outputDir, { recursive: true });
for (const binary of binaries) {
  const releaseDir = cargoTarget
    ? path.join(nativeRoot, 'target', cargoTarget, 'release')
    : path.join(nativeRoot, 'target', 'release');
  const source = path.join(releaseDir, binary);
  const destination = path.join(outputDir, binary);
  if (!fs.existsSync(source) || fs.statSync(source).size === 0) {
    throw new Error(`goz build did not produce ${source}`);
  }
  fs.copyFileSync(source, destination);
  console.log(`Bundled ${binary}: ${fs.statSync(destination).size} bytes`);
}
