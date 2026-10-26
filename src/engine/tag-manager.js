const fs = require('fs');
const path = require('path');
const os = require('os');

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
    if (!fs.existsSync(this.storageDir)) {
      try {
        fs.mkdirSync(this.storageDir, { recursive: true });
      } catch (e) {
        console.error('Failed to create storage dir:', e);
      }
    }
  }

  load() {
    if (fs.existsSync(this.dataFile)) {
      try {
        const raw = fs.readFileSync(this.dataFile, 'utf8');
        this.data = JSON.parse(raw);
        if (!this.data.tags) this.data.tags = {};
        if (!this.data.starred) this.data.starred = {};
      } catch (e) {
        console.error('Failed to load metadata:', e);
      }
    }
  }

  save() {
    try {
      this.ensureDir();
      fs.writeFileSync(this.dataFile, JSON.stringify(this.data, null, 2), 'utf8');
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
