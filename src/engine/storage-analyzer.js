const { EXTENSION_CATEGORIES } = require('./query-parser');

class StorageAnalyzer {
  static analyze(records) {
    let totalBytes = 0;
    let totalFiles = 0;
    let totalFolders = 0;

    const categoryStats = {
      documents: { count: 0, bytes: 0, label: '문서' },
      pictures: { count: 0, bytes: 0, label: '이미지/사진' },
      videos: { count: 0, bytes: 0, label: '동영상' },
      audio: { count: 0, bytes: 0, label: '오디오' },
      compressed: { count: 0, bytes: 0, label: '압축 파일' },
      executables: { count: 0, bytes: 0, label: '실행 파일' },
      others: { count: 0, bytes: 0, label: '기타' }
    };

    const extToCategory = new Map();
    for (const [cat, exts] of Object.entries(EXTENSION_CATEGORIES)) {
      let targetCat = 'others';
      if (cat === 'doc' || cat === 'document') targetCat = 'documents';
      else if (cat === 'pic' || cat === 'picture' || cat === 'image') targetCat = 'pictures';
      else if (cat === 'video') targetCat = 'videos';
      else if (cat === 'audio') targetCat = 'audio';
      else if (cat === 'zip' || cat === 'compressed') targetCat = 'compressed';
      else if (cat === 'exe' || cat === 'executable') targetCat = 'executables';

      for (const e of exts) {
        extToCategory.set(e, targetCat);
      }
    }

    const filesOnly = [];

    for (const r of records) {
      if (r.isDir) {
        totalFolders++;
      } else {
        totalFiles++;
        totalBytes += r.size;
        filesOnly.push(r);

        const targetCat = extToCategory.get(r.ext) || 'others';
        categoryStats[targetCat].count++;
        categoryStats[targetCat].bytes += r.size;
      }
    }

    // Top 50 largest files
    filesOnly.sort((a, b) => b.size - a.size);
    const topLargest = filesOnly.slice(0, 50);

    return {
      totalBytes,
      totalFiles,
      totalFolders,
      categories: categoryStats,
      topLargest
    };
  }
}

module.exports = StorageAnalyzer;
