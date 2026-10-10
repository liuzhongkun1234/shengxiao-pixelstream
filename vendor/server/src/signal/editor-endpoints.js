import fs from 'node:fs';
import crypto from 'node:crypto';

// Project credentials are independent of ephemeral instance identities.
export class EditorEndpoints {
  constructor(file, projects) {
    this.file = file;
    this.entries = file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    const ids = new Set(projects.filter(p => p.runtimeMode === 'external-editor').map(p => p.id));
    let changed = false;
    for (const id of Object.keys(this.entries)) if (!ids.has(id)) { delete this.entries[id]; changed = true; }
    if (changed) this.save();
  }
  save() {
    if (!this.file) return;
    fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.entries), { mode: 0o600 });
    fs.renameSync(this.file + '.tmp', this.file);
  }
  prepare(id, reset = false) {
    if (reset || !Object.hasOwn(this.entries, id)) {
      const previous = this.entries;
      this.entries = { ...previous, [id]: crypto.randomBytes(32).toString('base64url') };
      try { this.save(); } catch (error) { this.entries = previous; throw error; }
    }
    const entry = this.entries[id];
    const token = typeof entry === 'string' ? entry : entry.token;
    if (entry.paused) this.setPaused(id, false);
    return `/engine/${encodeURIComponent(id)}/editor/token=${token}`;
  }
  isPaused(id) { return Object.hasOwn(this.entries, id) && this.entries[id]?.paused === true; }
  setPaused(id, paused) {
    if (!Object.hasOwn(this.entries, id)) return;
    const previous = this.entries, entry = previous[id];
    this.entries = { ...previous, [id]: { token: typeof entry === 'string' ? entry : entry.token, paused } };
    try { this.save(); } catch (error) { this.entries = previous; throw error; }
  }
  accepts(id, supplied) {
    if (this.isPaused(id)) return false;
    const entry = Object.hasOwn(this.entries, id) ? this.entries[id] : null;
    const expected = typeof entry === 'string' ? entry : entry?.token;
    return typeof expected === 'string' && typeof supplied === 'string' && expected.length >= 32 &&
      Buffer.byteLength(expected) === Buffer.byteLength(supplied) &&
      crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(supplied));
  }
}
