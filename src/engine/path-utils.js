const os = require('os');
const path = require('path');

function getFullPath(record) {
  if (!record) return '';
  if (record.fullPath) return record.fullPath;

  const directory = record.path || '';
  if (!directory) return record.name || '';
  if (directory.endsWith('\\') || directory.endsWith('/')) {
    return `${directory}${record.name}`;
  }

  return path.join(directory, record.name || '');
}

function normalizePathKey(filePath) {
  const normalized = path.normalize(filePath);
  return os.platform() === 'win32' ? normalized.toLowerCase() : normalized;
}

function getPathSeparator(filePath) {
  return filePath && filePath.includes('\\') ? '\\' : path.sep;
}

module.exports = {
  getFullPath,
  normalizePathKey,
  getPathSeparator
};
