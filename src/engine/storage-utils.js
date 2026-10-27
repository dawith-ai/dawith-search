const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(directory, 0o700);
  } catch (error) {
    // Windows does not expose POSIX directory modes.
  }
}

function privateFileMode(filePath) {
  try {
    fs.chmodSync(filePath, 0o600);
  } catch (error) {
    // Windows does not expose POSIX file modes.
  }
}

function readJsonWithBackup(filePath, fallback) {
  for (const candidate of [filePath, `${filePath}.bak`]) {
    try {
      if (!fs.existsSync(candidate)) continue;
      return JSON.parse(fs.readFileSync(candidate, 'utf8'));
    } catch (error) {
      // Try the backup before returning the fallback.
    }
  }
  return fallback;
}

function writeJsonAtomic(filePath, value, options = {}) {
  const directory = path.dirname(filePath);
  ensurePrivateDirectory(directory);
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  privateFileMode(temporaryPath);

  try {
    if (options.backup !== false && fs.existsSync(filePath)) {
      fs.copyFileSync(filePath, `${filePath}.bak`);
      privateFileMode(`${filePath}.bak`);
    }
    fs.renameSync(temporaryPath, filePath);
    privateFileMode(filePath);
  } catch (error) {
    try {
      fs.unlinkSync(temporaryPath);
    } catch (cleanupError) {
      // Preserve the original write failure.
    }
    throw error;
  }
}

module.exports = {
  ensurePrivateDirectory,
  readJsonWithBackup,
  writeJsonAtomic
};
