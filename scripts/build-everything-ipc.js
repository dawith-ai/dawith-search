const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const sdkRoot = path.join(root, 'native', 'everything-sdk');
const outputDir = path.join(root, 'bin', 'native', 'windows', 'x64');
const output = path.join(outputDir, 'everything-ipc.exe');

if (process.platform !== 'win32') {
  console.log('Skipping Everything SDK IPC helper build on non-Windows host.');
  process.exit(0);
}
if (process.argv.includes('--arch') && process.argv[process.argv.indexOf('--arch') + 1] === 'arm64') {
  console.log('Skipping x64-only Everything SDK IPC helper for the ARM64 package.');
  process.exit(0);
}

const cl = process.env.CC || 'cl.exe';
const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dawith-everything-ipc-'));
fs.mkdirSync(outputDir, { recursive: true });

execFileSync(cl, [
  '/nologo',
  '/O2',
  '/MT',
  '/EHsc',
  '/W3',
  '/DUNICODE',
  '/D_UNICODE',
  `/I${sdkRoot}`,
  `/Fo${buildDir}${path.sep}`,
  sdkRoot + path.sep + 'everything-ipc.cpp',
  sdkRoot + path.sep + 'src' + path.sep + 'Everything.c',
  `/Fe${output}`,
  '/link',
  'user32.lib',
  'shell32.lib',
  'advapi32.lib'
], { cwd: root, stdio: 'inherit', windowsHide: true });

if (!fs.existsSync(output) || fs.statSync(output).size === 0) {
  throw new Error(`Everything SDK IPC helper was not produced: ${output}`);
}
console.log(`Bundled everything-ipc.exe: ${fs.statSync(output).size} bytes`);
