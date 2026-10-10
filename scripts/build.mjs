import { build } from 'esbuild';
import { mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, 'dist');

for (const d of ['main', 'preload', 'renderer']) {
  mkdirSync(join(dist, d), { recursive: true });
}

const common = { bundle: true, sourcemap: false, logLevel: 'info' };

// 主进程（Node 环境，electron 保持外部引用由 Electron 运行时提供）
await build({
  ...common,
  entryPoints: [join(root, 'src/main/index.ts')],
  outfile: join(dist, 'main/index.js'),
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['electron'],
});

// preload（同 Node 环境）
await build({
  ...common,
  entryPoints: [join(root, 'src/preload/index.ts')],
  outfile: join(dist, 'preload/index.js'),
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['electron'],
});

// 渲染进程（浏览器环境）
await build({
  ...common,
  entryPoints: [join(root, 'src/renderer/app.ts')],
  outfile: join(dist, 'renderer/app.js'),
  platform: 'browser',
  format: 'iife',
  target: 'chrome120',
});

// 静态资源
copyFileSync(join(root, 'src/renderer/index.html'), join(dist, 'renderer/index.html'));
copyFileSync(join(root, 'src/renderer/styles.css'), join(dist, 'renderer/styles.css'));

// 播放页（单文件 HTML，运行时会被写入内置服务器的 public 目录）
const playerDir = join(root, 'src/player');
if (existsSync(join(playerDir, 'index.html'))) {
  mkdirSync(join(dist, 'player'), { recursive: true });
  copyFileSync(join(playerDir, 'index.html'), join(dist, 'player/index.html'));
  console.log('player page bundled');
} else {
  console.warn('warn: src/player/index.html 不存在，将使用内置服务器的默认播放页');
}

console.log('build ok ->', dist);
