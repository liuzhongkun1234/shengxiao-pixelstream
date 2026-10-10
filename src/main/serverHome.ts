// 内置服务器（信令 + 进程代理）的定位与部署
// 打包后服务器在 resources/server；首次运行时复制到 userData/server（可写、可持久保存项目配置）
import { app } from 'electron';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

function readSafe(p: string): string {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

function isServerDir(dir: string): boolean {
  return existsSync(join(dir, 'src', 'signal', 'index.js')) && existsSync(join(dir, 'config', 'signal.json'));
}

/**
 * 计算服务器源码指纹：用于判断已解包的工作副本是否需要刷新。
 * 覆盖 src 与 config 的全部内容，这样连补丁（例如修状态机竞态）也能生效。
 */
function serverFingerprint(dir: string): string {
  const hash = createHash('sha1');
  const walk = (rel: string): void => {
    const abs = join(dir, rel);
    let entries: string[] = [];
    try {
      entries = readdirSync(abs).sort();
    } catch {
      return;
    }
    for (const name of entries) {
      const childRel = rel ? join(rel, name) : name;
      const childAbs = join(dir, childRel);
      try {
        if (statSync(childAbs).isDirectory()) walk(childRel);
        else {
          hash.update(childRel);
          hash.update(readFileSync(childAbs));
        }
      } catch {
        /* 忽略读不了的文件 */
      }
    }
  };
  hash.update(readSafe(join(dir, 'package.json')));
  walk('src');
  walk('config');
  return hash.digest('hex');
}

/** 随程序分发的只读服务器副本：打包后在 resources/server，开发时在 vendor/server */
export function bundledServerDir(): string | null {
  const candidates: string[] = [];
  if (process.resourcesPath) candidates.push(join(process.resourcesPath, 'server'));
  candidates.push(join(app.getAppPath(), 'vendor', 'server'));
  candidates.push(join(__dirname, '..', '..', 'vendor', 'server'));
  for (const c of candidates) {
    if (c && isServerDir(c)) return c;
  }
  return null;
}

/**
 * 可写的服务器工作副本：
 * - 首次运行（或内置版本变化）时从只读副本复制到 userData/server
 * - 项目登记、token、会话策略等运行时改动都落在这个副本里，重启后仍然有效
 */
export function ensureServerHome(): string | null {
  const home = join(app.getPath('userData'), 'server');
  const src = bundledServerDir();
  const marker = join(home, '.version');
  if (src) {
    const want = serverFingerprint(src);
    const has = readSafe(marker).trim();
    if (!isServerDir(home) || has !== want) {
      mkdirSync(home, { recursive: true });
      cpSync(src, home, { recursive: true, force: true });
      writeFileSync(marker, want, 'utf8');
    }
    // 依赖兜底：副本缺 node_modules（或 ws）而随包副本有 → 补上。
    // 信令服务用 ESM 解析 ws，缺失时会以 ERR_MODULE_NOT_FOUND 直接退出。
    const nm = join(home, 'node_modules');
    if (!existsSync(join(nm, 'ws')) && existsSync(join(src, 'node_modules'))) {
      try {
        cpSync(join(src, 'node_modules'), nm, { recursive: true, force: true });
      } catch {
        /* 补依赖失败不阻塞启动，启动时会报错并写日志 */
      }
    }
  }
  return isServerDir(home) ? home : null;
}

/**
 * 重置内置服务器工作副本（"清除缓存"）：
 * 只清掉会累积的历史状态——config（项目登记/token/白名单/会话策略）与 logs（实例注册表/用量），
 * 然后从打包的只读副本重新解包。**绝不删除整个 server 目录**：node_modules 是运行必需依赖
 * （随包只带 ws，本机不一定能重新获取），删掉会导致信令服务 ERR_MODULE_NOT_FOUND 起不来。
 */
export function resetServerHome(): string | null {
  const home = join(app.getPath('userData'), 'server');
  for (const sub of ['config', 'logs']) {
    try {
      rmSync(join(home, sub), { recursive: true, force: true });
    } catch {
      /* 删不掉时 ensureServerHome 会用随包副本覆盖 */
    }
  }
  return ensureServerHome();
}

/**
 * 把自研播放页写入服务器 public 目录，供浏览器访问：
 * <serverDir>/public/shengxiao.html
 * 这样页面与信令共用同一个端口（12188），局域网只需放通一个端口。
 */
export function installPlayerPage(serverDir: string): string | null {
  const sources = [
    join(process.resourcesPath ?? '', 'player', 'index.html'),
    join(app.getAppPath(), 'dist', 'player', 'index.html'),
    join(app.getAppPath(), 'src', 'player', 'index.html'),
    join(__dirname, '..', 'player', 'index.html'),
  ];
  const src = sources.find((p) => p && existsSync(p));
  if (!src) return null;
  const destDir = join(serverDir, 'public');
  const dest = join(destDir, 'shengxiao.html');
  try {
    const content = readFileSync(src, 'utf8');
    if (readSafe(dest) !== content) {
      mkdirSync(destDir, { recursive: true });
      writeFileSync(dest, content, 'utf8');
    }
    return dest;
  } catch {
    return null;
  }
}
