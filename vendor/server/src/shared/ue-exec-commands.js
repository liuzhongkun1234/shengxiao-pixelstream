// Only inspect ExecCmds; every other argv entry is preserved byte-for-byte.
export function mergeExecCommands(args, overrides = {}) {
  const commands = [], rest = [];
  for (const arg of args) {
    const match = String(arg).match(/^-ExecCmds=(.*)$/is);
    if (!match) { rest.push(arg); continue; }
    let text = match[1];
    if (text.startsWith('"') && text.endsWith('"')) text = text.slice(1, -1);
    let quoted = false, start = 0;
    for (let i = 0; i <= text.length; i++) {
      if (text[i] === '"' && text[i - 1] !== '\\') quoted = !quoted;
      if (i === text.length || text[i] === ',' && !quoted) {
        const command = text.slice(start, i).trim();
        if (command) commands.push(command);
        start = i + 1;
      }
    }
  }
  const keys = new Set(Object.keys(overrides).map(x => x.toLowerCase()));
  const merged = commands.filter(x => !keys.has(x.split(/[\s=]/, 1)[0].toLowerCase()));
  merged.push(...Object.entries(overrides).map(([key, value]) => `${key} ${value}`));
  if (merged.length) rest.push(`-ExecCmds=${merged.join(',')}`);
  return rest;
}
