const fs = require('fs');
const path = require('path');
const os = require('os');

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
    fs.mkdirSync(this.storageDir, { recursive: true });
  }

  load() {
    if (!fs.existsSync(this.dataFile)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.dataFile, 'utf8'));
      this.items = Array.isArray(raw.items) ? raw.items.filter(item => item && item.query) : [];
    } catch (error) {
      this.items = [];
    }
  }

  save() {
    this.ensureDir();
    fs.writeFileSync(this.dataFile, JSON.stringify({ version: 1, items: this.items }, null, 2), 'utf8');
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
