// 临时诊断：以 admin 角色连接，查看实例真实状态
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const srv = process.argv[2];
const cfg = JSON.parse(readFileSync(join(srv, 'config', 'signal.json'), 'utf8'));
const port = Number(cfg.port) || 12188;
const { default: WebSocket } = await import(pathToFileURL(join(srv, 'node_modules', 'ws', 'index.js')).href);

const url = `ws://127.0.0.1:${port}/admin?token=${encodeURIComponent(cfg.auth.adminToken)}`;
console.log('CONNECT admin');
const ws = new WebSocket(url);
ws.on('open', () => {
  console.log('OPEN');
  // 常见的管理命令：请求一次快照
  for (const cmd of [{ type: 'getStatus' }, { type: 'adminStatus' }, { type: 'status' }, { type: 'snapshot' }]) {
    try { ws.send(JSON.stringify(cmd)); } catch { /* ignore */ }
  }
});
ws.on('message', (d) => {
  const t = d.toString();
  console.log('MSG', t.slice(0, 1200));
});
ws.on('close', (c, r) => console.log('CLOSE', c, String(r || '')));
ws.on('error', (e) => console.log('ERROR', e.message));
setTimeout(() => { ws.close(); setTimeout(() => process.exit(0), 200); }, 6000);
