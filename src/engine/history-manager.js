const fs = require('fs');
const path = require('path');
const os = require('os');
const { ensurePrivateDirectory, readJsonWithBackup, writeJsonAtomic } = require('./storage-utils');

const MAX_HISTORY = 40;

class HistoryManager {
  constructor(storageDir) {
    this.storageDir = storageDir || path.join(os.homedir(), '.dawith-search');
    this.dataFile = path.join(this.storageDir, 'search-history.json');
    this.items = [];
    this.ensureDir();
    this.load();
  }

  ensureDir() {
    ensurePrivateDirectory(this.storageDir);
  }

  load() {
    const raw = readJsonWithBackup(this.dataFile, null);
    this.items = raw && Array.isArray(raw.items) ? raw.items.filter(item => item && item.query) : [];
  }

  save() {
    writeJsonAtomic(this.dataFile, { version: 1, items: this.items });
  }

  list() {
    return [...this.items].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  }

  add(query) {
    const cleanQuery = String(query || '').trim().slice(0, 512);
    if (!cleanQuery) return null;
    const now = Date.now();
    const existing = this.items.find(item => item.query === cleanQuery);
    if (existing) {
      existing.lastUsedAt = now;
      existing.count = (existing.count || 1) + 1;
    } else {
      this.items.push({ query: cleanQuery, lastUsedAt: now, count: 1 });
    }
    this.items.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
    this.items = this.items.slice(0, MAX_HISTORY);
    this.save();
    return this.items.find(item => item.query === cleanQuery);
  }

  clear() {
    this.items = [];
    this.save();
  }
}

module.exports = HistoryManager;
