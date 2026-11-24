'use strict';
// Persists the studio (scenes, sources, settings, destinations) as JSON in
// userData. Stream keys are encrypted at rest with Windows DPAPI (safeStorage).
const fs = require('fs');
const path = require('path');
const { safeStorage } = require('electron');

class Store {
  constructor(dir) {
    this.file = path.join(dir, 'studio.json');
    this.backup = path.join(dir, 'studio.backup.json');
  }

  _encrypt(value) {
    if (!value || !safeStorage.isEncryptionAvailable()) return value;
    return `enc:${safeStorage.encryptString(value).toString('base64')}`;
  }

  _decrypt(value) {
    if (typeof value !== 'string' || !value.startsWith('enc:')) return value;
    try {
      return safeStorage.decryptString(Buffer.from(value.slice(4), 'base64'));
    } catch {
      return '';
    }
  }

  load() {
    for (const f of [this.file, this.backup]) {
      try {
        const data = JSON.parse(fs.readFileSync(f, 'utf8'));
        for (const d of data.destinations || []) d.key = this._decrypt(d.key);
        return data;
      } catch { /* try the backup */ }
    }
    return null;
  }

  save(state) {
    const copy = JSON.parse(JSON.stringify(state));
    for (const d of copy.destinations || []) d.key = this._encrypt(d.key);
    const json = JSON.stringify(copy, null, 1);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, json);
    try { fs.copyFileSync(this.file, this.backup); } catch { /* first save */ }
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { Store };
