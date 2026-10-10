import fs from "node:fs";
import path from "node:path";

const ranks = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(name, options = {}) {
  const level = options.level in ranks ? options.level : "info";
  const directory = path.resolve(options.directory || "logs-source");
  fs.mkdirSync(directory, { recursive: true });
  const retentionDays = Math.max(1, Number(options.retentionDays) || 30);
  const consoleEnabled = options.consoleEnabled !== false;
  const fileEnabled = options.fileEnabled !== false;
  const maxFileBytes = Math.max(1, Number(options.maxFileSizeMB) || 20) * 1024 * 1024;
  const cutoff = Date.now() - retentionDays * 86_400_000;
  for (const file of fs.readdirSync(directory)) {
    if (!file.endsWith(".jsonl")) continue;
    const target = path.join(directory, file);
    try { if (fs.statSync(target).mtimeMs < cutoff) fs.unlinkSync(target); } catch {}
  }
  return Object.fromEntries(Object.keys(ranks).map(kind => [kind, (event, fields = {}) => {
    if (ranks[kind] < ranks[level]) return;
    const entry = { timestamp: new Date().toISOString(), level: kind, service: name, event, ...fields };
    const line = JSON.stringify(entry);
    if (consoleEnabled) { if (kind === "error") console.error(line); else console.log(line); }
    if (fileEnabled) {
      const base = path.join(directory, `${name}-${new Date().toISOString().slice(0, 10)}.jsonl`);
      try { if (fs.existsSync(base) && fs.statSync(base).size >= maxFileBytes) fs.renameSync(base, base.replace(/\.jsonl$/, `-${Date.now()}.jsonl`)); } catch {}
      fs.appendFileSync(base, line + "\n", "utf8");
    }
  }]));
}
