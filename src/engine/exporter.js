const fs = require('fs');
const path = require('path');

class Exporter {
  static formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  static toCSV(items) {
    const headers = ['Name', 'Path', 'Size (Bytes)', 'Formatted Size', 'Date Modified', 'Type'];
    const rows = [headers.join(',')];

    for (const item of items) {
      const fullPath = path.join(item.path, item.name);
      const row = [
        `"${item.name.replace(/"/g, '""')}"`,
        `"${item.path.replace(/"/g, '""')}"`,
        item.size,
        `"${this.formatBytes(item.size)}"`,
        `"${new Date(item.mtime).toISOString()}"`,
        item.isDir ? 'Folder' : (item.ext || 'File')
      ];
      rows.push(row.join(','));
    }
    return rows.join('\r\n');
  }

  static toTXT(items) {
    return items.map(item => path.join(item.path, item.name)).join('\r\n');
  }

  static toJSON(items) {
    return JSON.stringify(items.map(item => ({
      name: item.name,
      path: item.path,
      fullPath: path.join(item.path, item.name),
      size: item.size,
      mtime: item.mtime,
      ctime: item.ctime,
      isDir: item.isDir,
      ext: item.ext,
      tags: item.tags || []
    })), null, 2);
  }

  static toEFU(items) {
    // Voidtools Everything File List format (EFU)
    // Windows file time format (100-nanosecond intervals since Jan 1, 1601 UTC)
    const toWindowsFileTime = (timeMs) => {
      return BigInt(Math.floor(timeMs * 10000) + 116444736000000000).toString();
    };

    const lines = [
      'Filename,Size,Date Modified,Date Created,Attributes'
    ];

    for (const item of items) {
      const fullPath = path.join(item.path, item.name);
      const mtimeWin = toWindowsFileTime(item.mtime);
      const ctimeWin = toWindowsFileTime(item.ctime);
      const attr = item.isDir ? '16' : '32'; // 16 = Directory, 32 = Archive
      lines.push(`"${fullPath.replace(/"/g, '""')}",${item.size},${mtimeWin},${ctimeWin},${attr}`);
    }

    return lines.join('\r\n');
  }

  static exportToFile(filePath, format, items) {
    let content = '';
    const fmt = (format || path.extname(filePath).replace('.', '')).toLowerCase();

    if (fmt === 'csv') content = this.toCSV(items);
    else if (fmt === 'txt') content = this.toTXT(items);
    else if (fmt === 'json') content = this.toJSON(items);
    else if (fmt === 'efu') content = this.toEFU(items);
    else content = this.toTXT(items);

    fs.writeFileSync(filePath, content, 'utf8');
    return { filePath, count: items.length };
  }
}

module.exports = Exporter;
