const fs = require('fs');
const path = require('path');
const os = require('os');

const MAX_BOOKMARKS = 100;

class BookmarkManager {
  constructor(storageDir) {
    this.storageDir = storageDir || path.join(os.homedir(), '.dawith-search');
    this.dataFile = path.join(this.storageDir, 'bookmarks.json');
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
      this.items = Array.isArray(raw.items) ? raw.items.filter(item => item && item.id && item.name && item.query !== undefined) : [];
    } catch (error) {
      this.items = [];
    }
  }

  save() {
    this.ensureDir();
    fs.writeFileSync(this.dataFile, JSON.stringify({ version: 1, items: this.items }, null, 2), 'utf8');
  }

  list() {
    return [...this.items].sort((a, b) => (b.lastUsedAt || b.createdAt || 0) - (a.lastUsedAt || a.createdAt || 0));
  }

  add(input = {}) {
    const name = String(input.name || '').trim().slice(0, 80);
    const query = String(input.query || '').trim().slice(0, 512);
    if (!name || (!query && !input.scopeRoot)) throw new Error('Bookmark name or scope root is required.');

    const now = Date.now();
    const existing = this.items.find(item => item.query === query && item.scopeRoot === (input.scopeRoot || ''));
    if (existing) {
      existing.name = name;
      existing.sortBy = input.sortBy || existing.sortBy || 'name';
      existing.sortOrder = input.sortOrder || existing.sortOrder || 'asc';
      existing.lastUsedAt = now;
      this.save();
      return existing;
    }

    const item = {
      id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      query,
      scopeRoot: String(input.scopeRoot || ''),
      sortBy: input.sortBy || 'name',
      sortOrder: input.sortOrder || 'asc',
      createdAt: now,
      lastUsedAt: now
    };
    this.items.unshift(item);
    this.items = this.items.slice(0, MAX_BOOKMARKS);
    this.save();
    return item;
  }

  touch(id) {
    const item = this.items.find(entry => entry.id === id);
    if (!item) return null;
    item.lastUsedAt = Date.now();
    this.save();
    return item;
  }

  remove(id) {
    const before = this.items.length;
    this.items = this.items.filter(item => item.id !== id);
    if (this.items.length !== before) this.save();
    return this.items.length !== before;
  }
}

module.exports = BookmarkManager;
