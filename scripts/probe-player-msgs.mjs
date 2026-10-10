// 临时诊断：模拟播放端连接，打印收到的每一条消息（定位卡在哪一步）
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const srv = process.argv[2];
const cfg = JSON.parse(readFileSync(join(srv, 'config', 'signal.json'), 'utf8'));
const port = Number(cfg.port) || 12188;
const projectId = cfg.projects[0].id;
const { default: WebSocket } = await import(pathToFileURL(join(srv, 'node_modules', 'ws', 'index.js')).href);

const url = `ws://127.0.0.1:${port}/player?project=${encodeURIComponent(projectId)}&token=${encodeURIComponent(cfg.auth.playerToken)}&client=probe${Date.now().toString(36)}`;
console.log('CONNECT', url.replace(/token=[^&]+/, 'token=***'));
const ws = new WebSocket(url);
const seen = [];
ws.on('open', () => console.log('OPEN'));
ws.on('message', (d) => {
  const t = d.toString();
  let type = '';
  try { type = JSON.parse(t).type || ''; } catch { /* ignore */ }
  seen.push(type);
  console.log(`[${type}]`, t.slice(0, 220));
});
ws.on('close', (c, r) => console.log('CLOSE', c, String(r || '')));
ws.on('error', (e) => console.log('ERROR', e.message));

setTimeout(() => {
  console.log('--- 收到消息类型 ---', JSON.stringify(seen));
  const hasPlayerConnected = seen.includes('playerConnected');
  const hasOffer = seen.includes('offer');
  console.log(hasPlayerConnected ? 'RESULT: 服务端已发 playerConnected（播放端应据此发起 offer）' : 'RESULT: 未收到 playerConnected');
  console.log(hasOffer ? 'RESULT: 收到 offer（unified：由 UE 发起）' : 'RESULT: 未收到 offer');
  ws.close();
  setTimeout(() => process.exit(0), 300);
}, 12000);
