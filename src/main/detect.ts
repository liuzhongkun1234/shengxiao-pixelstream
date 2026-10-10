// 引擎识别与信令服务器目录探测
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import type { EngineKind, ServerKind } from '../shared/types';
import { bundledServerDir, ensureServerHome } from './serverHome';

/** 浅层查找指定后缀文件（限制深度与数量，避免扫全盘） */
function findExt(dir: string, ext: string, maxDepth: number, budget: { n: number }): boolean {
  if (budget.n <= 0 || maxDepth < 0) return false;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return false;
  }
  for (const name of entries) {
    budget.n--;
    if (budget.n <= 0) return false;
    if (name.toLowerCase().endsWith(ext)) return true;
  }
  for (const name of entries) {
    const p = join(dir, name);
    try {
      if (statSync(p).isDirectory()) {
        if (findExt(p, ext, maxDepth - 1, budget)) return true;
      }
    } catch {
      /* 忽略无权限目录 */
    }
  }
  return false;
}

/**
 * 识别打包产物所属引擎：
 * - Unity: exe 旁有 UnityPlayer.dll 或 <name>_Data 目录
 * - UE:   exe 附近存在 *.pak 或 Engine 目录
 */
export function detectEngine(exePath: string): EngineKind {
  try {
    const dir = dirname(exePath);
    const base = basename(exePath, extname(exePath));
    if (existsSync(join(dir, 'UnityPlayer.dll')) || existsSync(join(dir, `${base}_Data`))) {
      return 'unity';
    }
    if (findExt(dir, '.pak', 3, { n: 3000 })) return 'ue';
    if (existsSync(join(dir, 'Engine'))) return 'ue';
    if (existsSync(join(dir, 'Binaries')) && existsSync(join(dir, 'Content'))) return 'ue';
  } catch {
    /* fallthrough */
  }
  return 'unknown';
}

/**
 * 探测信令服务器目录（SignallingWebServer）：
 * 1. 用户手动配置的目录
 * 2. 打包目录自带：exe 同级 Engine/Plugins/Media/PixelStreaming/Resources/WebServers/SignallingWebServer
 * 3. exe 同级 SignallingWebServer /
 * 4. exe 上一级同名路径
 */
export function findSignalingDir(exePath: string, override: string): string | null {
  if (override && existsSync(override)) return override;

  const exeDir = dirname(exePath);
  const parent = dirname(exeDir);
  const rel = join('Engine', 'Plugins', 'Media', 'PixelStreaming', 'Resources', 'WebServers', 'SignallingWebServer');
  const candidates = [
    join(exeDir, rel),
    join(parent, rel),
    join(exeDir, 'SignallingWebServer'),
    join(parent, 'SignallingWebServer'),
    join(exeDir, 'signallingwebserver'),
    // 随包内置的官方信令服务（Epic PixelStreamingInfrastructure 产物），放最后作兜底
    ...bundledOfficialSignallingDirs(),
  ];
  for (const c of candidates) {
    if (existsSync(c) && resolveServerScript(c)) return c;
  }
  // 目录存在但脚本名不认识时也返回，交给启动阶段报详细错误
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

/** 随包内置的官方 SignallingWebServer 候选目录（打包后在 resources/official，开发时在 vendor/official） */
function bundledOfficialSignallingDirs(): string[] {
  const list: string[] = [];
  if (process.resourcesPath) list.push(join(process.resourcesPath, 'official', 'SignallingWebServer'));
  list.push(join(__dirname, '..', '..', 'vendor', 'official', 'SignallingWebServer'));
  return list;
}

/** 信令服务器主脚本候选（兼容不同版本的 PixelStreamingInfrastructure） */
const SERVER_SCRIPTS = ['SignallingWebServer.js', 'cirrus.js', 'server.js'];

export function resolveServerScript(dir: string): string | null {
  for (const s of SERVER_SCRIPTS) {
    const p = join(dir, s);
    if (existsSync(p)) return p;
  }
  return null;
}

// ---------- PeerStream（莽小石）服务器探测 ----------

/** 检测目录是不是 PeerStream 信令服务器源码目录（含 src/signal/index.js 与 package.json） */
export function isPeerStreamSource(dir: string): boolean {
  return existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'src', 'signal', 'index.js'));
}

function hasEpicServerScript(dir: string): boolean {
  return resolveServerScript(dir) !== null;
}

export function detectServerKind(dir: string): ServerKind {
  if (isPeerStreamSource(dir)) return 'peerstream';
  if (hasEpicServerScript(dir)) return 'epic';
  return 'unknown';
}

/**
 * 探测内置服务器源码目录，优先级：
 * 1. 设置里手动指定的目录
 * 2. 程序自带的可写工作副本（userData/server，单文件版首次运行自动解出）
 * 3. 程序自带的只读副本（resources/server 或 vendor/server）
 * 4. 兼容：机器上已有的第三方管理器目录
 */
export function findPeerStreamRoot(override: string): string | null {
  const resolveCandidate = (p: string): string | null => {
    if (!p || !existsSync(p)) return null;
    if (isPeerStreamSource(p)) return p;
    const nested = join(p, 'PeerStreamSource');
    if (existsSync(nested) && isPeerStreamSource(nested)) return nested;
    return null;
  };
  if (override) {
    const hit = resolveCandidate(override.replace(/[\\/]+$/, ''));
    if (hit) return hit;
  }

  // 自带副本（工作副本优先，便于持久保存项目配置）
  const bundled = bundledServerDir();
  if (bundled) {
    const home = ensureServerHome();
    if (home) return home;
    return bundled;
  }

  // 兼容老的第三方管理器目录
  const guesses = [
    'D:\\UEXiangMuShangHaiRuiNian\\UEPixelStreamingManager-6.1.0-beta.154-win-x64\\PeerStreamSource',
  ];
  for (const g of guesses) {
    const hit = resolveCandidate(g);
    if (hit) return hit;
  }
  return null;
}

/** PeerStreamSource 目录 → 自带 Node 运行时路径（<管理器根>/runtime/node.exe） */
export function peerStreamRuntimeNode(sourceDir: string): string | null {
  const root = dirname(sourceDir);
  const candidates = [
    join(root, 'runtime', 'node.exe'),
    join(root, 'runtimes', 'node.exe'),
    join(sourceDir, 'runtime', 'node.exe'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

/** PeerStream 管理器根目录（signal.json 所在 PeerStreamSource 的上级，日志等公用目录） */
export function peerStreamManagerRoot(sourceDir: string): string {
  return dirname(sourceDir);
}
