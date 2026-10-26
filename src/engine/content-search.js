const fs = require('fs');
const path = require('path');

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'json', 'js', 'jsx', 'ts', 'tsx', 'html', 'css', 'scss',
  'py', 'c', 'cpp', 'h', 'hpp', 'java', 'cs', 'go', 'rs', 'php', 'rb', 'swift',
  'xml', 'yaml', 'yml', 'ini', 'cfg', 'conf', 'csv', 'tsv', 'sql', 'sh', 'bat', 'cmd', 'ps1',
  'log', 'env', 'gitignore', 'properties', 'toml'
]);

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB limit for instant content search

class ContentSearcher {
  static isTextFile(ext) {
    if (!ext) return false;
    return TEXT_EXTENSIONS.has(ext.toLowerCase());
  }

  static async matchesContent(filePath, ext, needle, caseSensitive = false) {
    if (!needle) return true;
    if (!this.isTextFile(ext)) return false;

    try {
      const stat = await fs.promises.stat(filePath);
      if (stat.size > MAX_FILE_SIZE) return false;

      const content = await fs.promises.readFile(filePath, 'utf8');
      if (caseSensitive) {
        return content.includes(needle);
      } else {
        return content.toLowerCase().includes(needle.toLowerCase());
      }
    } catch (e) {
      return false;
    }
  }
}

module.exports = ContentSearcher;
