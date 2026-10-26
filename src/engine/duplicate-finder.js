const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class DuplicateFinder {
  static getPartialHash(filePath, bytes = 8192) {
    return new Promise((resolve) => {
      try {
        const stream = fs.createReadStream(filePath, { start: 0, end: bytes });
        const hash = crypto.createHash('md5');
        stream.on('data', chunk => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', () => resolve(null));
      } catch (e) {
        resolve(null);
      }
    });
  }

  static getFullHash(filePath) {
    return new Promise((resolve) => {
      try {
        const stream = fs.createReadStream(filePath);
        const hash = crypto.createHash('sha256');
        stream.on('data', chunk => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', () => resolve(null));
      } catch (e) {
        resolve(null);
      }
    });
  }

  static async findDuplicates(records, options = {}) {
    const minSize = options.minSize || 1024; // ignore files < 1KB by default
    const sizeMap = new Map();

    // 1. Group by exact file size
    for (const r of records) {
      if (r.isDir || r.size < minSize) continue;
      if (!sizeMap.has(r.size)) {
        sizeMap.set(r.size, []);
      }
      sizeMap.get(r.size).push(r);
    }

    // 2. Filter groups with >= 2 files
    const candidateGroups = [];
    for (const [size, list] of sizeMap.entries()) {
      if (list.length >= 2) {
        candidateGroups.push({ size, items: list });
      }
    }

    // 3. Compare hashes within candidates
    const duplicateGroups = [];
    let totalWastedBytes = 0;

    for (const grp of candidateGroups) {
      const partialMap = new Map();
      for (const item of grp.items) {
        const fullPath = path.join(item.path, item.name);
        const pHash = await this.getPartialHash(fullPath);
        if (!pHash) continue;

        if (!partialMap.has(pHash)) {
          partialMap.set(pHash, []);
        }
        partialMap.get(pHash).push({ item, fullPath });
      }

      for (const [pHash, pList] of partialMap.entries()) {
        if (pList.length < 2) continue;

        // Verify full hash
        const fullMap = new Map();
        for (const entry of pList) {
          const fHash = await this.getFullHash(entry.fullPath);
          if (!fHash) continue;
          if (!fullMap.has(fHash)) {
            fullMap.set(fHash, []);
          }
          fullMap.get(fHash).push(entry.item);
        }

        for (const [fHash, dupList] of fullMap.entries()) {
          if (dupList.length >= 2) {
            const wasted = (dupList.length - 1) * grp.size;
            totalWastedBytes += wasted;
            duplicateGroups.push({
              hash: fHash,
              size: grp.size,
              wastedBytes: wasted,
              items: dupList
            });
          }
        }
      }
    }

    duplicateGroups.sort((a, b) => b.wastedBytes - a.wastedBytes);

    return {
      groups: duplicateGroups,
      totalDuplicates: duplicateGroups.reduce((acc, g) => acc + g.items.length, 0),
      totalWastedBytes
    };
  }
}

module.exports = DuplicateFinder;
