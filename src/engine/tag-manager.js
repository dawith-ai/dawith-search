const fs = require('fs');
const path = require('path');
const os = require('os');
const { ensurePrivateDirectory, readJsonWithBackup, writeJsonAtomic } = require('./storage-utils');

class TagManager {
  constructor(storageDir) {
    this.storageDir = storageDir || path.join(os.homedir(), '.dawith-search');
    this.dataFile = path.join(this.storageDir, 'metadata.json');
    this.data = {
      tags: {},      // filePath -> [tag1, tag2]
      starred: {}    // filePath -> boolean
    };
    this.ensureDir();
    this.load();
  }

  ensureDir() {
    try {
      ensurePrivateDirectory(this.storageDir);
    } catch (error) {
      console.error('Failed to create storage dir:', error);
    }
  }

  load() {
    const raw = readJsonWithBackup(this.dataFile, null);
    if (raw && typeof raw === 'object') this.data = raw;
    if (!this.data.tags) this.data.tags = {};
    if (!this.data.starred) this.data.starred = {};
  }

  save() {
    try {
      writeJsonAtomic(this.dataFile, this.data);
    } catch (e) {
      console.error('Failed to save metadata:', e);
    }
  }

  getTags(filePath) {
    return this.data.tags[filePath] || [];
  }

  addTag(filePath, tag) {
    if (!tag) return;
    const cleanTag = tag.trim().replace(/^#/, '');
    if (!this.data.tags[filePath]) {
      this.data.tags[filePath] = [];
    }
    if (!this.data.tags[filePath].includes(cleanTag)) {
      this.data.tags[filePath].push(cleanTag);
      this.save();
    }
    return this.data.tags[filePath];
  }

  removeTag(filePath, tag) {
    if (!this.data.tags[filePath]) return [];
    const cleanTag = tag.trim().replace(/^#/, '');
    this.data.tags[filePath] = this.data.tags[filePath].filter(t => t !== cleanTag);
    if (this.data.tags[filePath].length === 0) {
      delete this.data.tags[filePath];
    }
    this.save();
    return this.data.tags[filePath] || [];
  }

  toggleStar(filePath) {
    if (this.data.starred[filePath]) {
      delete this.data.starred[filePath];
    } else {
      this.data.starred[filePath] = true;
    }
    this.save();
    return !!this.data.starred[filePath];
  }

  isStarred(filePath) {
    return !!this.data.starred[filePath];
  }

  getAllTags() {
    const tagSet = new Set();
    for (const list of Object.values(this.data.tags)) {
      for (const t of list) tagSet.add(t);
    }
    return Array.from(tagSet);
  }
}

module.exports = TagManager;
