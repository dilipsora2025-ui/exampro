const fs = require('fs');
const path = require('path');

class JsonStore {
  constructor(filePath, defaults) {
    this.filePath = filePath;
    this.data = defaults;
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        this.data = raw.trim() ? JSON.parse(raw) : this.data;
      } else {
        this._save();
      }
    } catch (e) {
      console.error('Failed to load DB file, starting fresh:', e.message);
    }
  }

  _save() {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = this.filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data), 'utf8');
    fs.renameSync(tmp, this.filePath); // atomic-ish swap, avoids half-written files on crash
  }

  // Call after any mutation to persist to disk.
  commit() {
    this._save();
  }
}

module.exports = { JsonStore };
