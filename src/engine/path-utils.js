const os = require('os');
const path = require('path');

function isWindowsPath(filePath) {
  return os.platform() === 'win32' || /^[A-Za-z]:[\\/]/.test(String(filePath || '')) || /^\\\\/.test(String(filePath || ''));
}

function getPathModule(...values) {
  return values.some(isWindowsPath) ? path.win32 : path;
}

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
  const pathModule = getPathModule(filePath);
  const normalized = pathModule.normalize(String(filePath || ''));
  return isWindowsPath(filePath) ? normalized.toLowerCase() : normalized;
}

function isPathWithinRoot(filePath, rootPath) {
  if (!filePath || !rootPath) return false;
  const pathModule = getPathModule(filePath, rootPath);
  const candidate = pathModule.resolve(String(filePath));
  const root = pathModule.resolve(String(rootPath));
  const relative = pathModule.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !pathModule.isAbsolute(relative));
}

function getPathSeparator(filePath) {
  return filePath && filePath.includes('\\') ? '\\' : path.sep;
}

module.exports = {
  getFullPath,
  normalizePathKey,
  getPathSeparator,
  isPathWithinRoot,
  isWindowsPath
};
