// 全进程共享类型定义

export type EngineKind = 'ue' | 'unity' | 'unknown';

/** 信令服务器类型：epic = Epic SignallingWebServer；peerstream = 莽小石 PeerStream 源码服务 */
export type ServerKind = 'epic' | 'peerstream' | 'unknown';

export interface Project {
  id: string;
  name: string;
  exePath: string;
  engine: EngineKind;
  createdAt: number;
}

export interface Settings {
  /** Epic SignallingWebServer 目录，空字符串 = 从打包目录自动探测 */
  signalingDir: string;
  /** PeerStream（莽小石）服务器源码目录，空字符串 = 自动探测 */
  peerStreamDir: string;
  /** 服务器模式：auto = 优先 PeerStream，找不到再试 Epic */
  serverMode: 'auto' | 'peerstream' | 'epic';
  /** PeerStream 播放端口（默认 12188，读取服务配置后自动校正） */
  httpPort: number;
  /** Streamer（UE 实例）连接的 WebSocket 端口（Epic 模式默认 8888） */
  streamerPort: number;
  /** UE 无窗口后台运行（-RenderOffscreen），最小化也不停渲 */
  renderOffscreen: boolean;
  /** 附加到 UE 启动命令后的原始参数 */
  ueExtraArgs: string;
  /** 附加到信令服务器启动命令后的原始参数 */
  signalingExtraArgs: string;
  /** 局域网模式：清空外网 STUN/TURN，只用本地候选，显著加快建连（默认开） */
  lanMode: boolean;
  /** 打开程序后自动在后台启动上次的项目（默认关：手动点启动） */
  autoStart: boolean;
  /** 启动 UE 时完全隐藏：无窗口、无控制台、不抢焦点（默认开） */
  silentUeStart: boolean;
  /** 开机自动启动（随 Windows 登录启动，静默后台运行） */
  startWithWindows: boolean;
  /** 高级：启动时保留遗留的同项目 UE 进程（默认关，通常应清理避免状态错乱） */
  keepLeftoverUe: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  signalingDir: '',
  peerStreamDir: '',
  serverMode: 'auto',
  httpPort: 80,
  streamerPort: 8888,
  renderOffscreen: true,
  ueExtraArgs: '',
  signalingExtraArgs: '',
  lanMode: true,
  autoStart: false,
  silentUeStart: true,
  startWithWindows: false,
  keepLeftoverUe: false,
};

export type ProcState = 'stopped' | 'starting' | 'running' | 'error';

/** 一个正在运行的项目实例（多项目可并发，各自独立状态与访问地址） */
export interface ProjectRun {
  /** 工具侧项目 id（store 里的 id） */
  projectId: string;
  name: string;
  state: 'starting' | 'running' | 'error';
  progress: number;
  message: string;
  streamerConnected: boolean;
  localUrl: string | null;
  lanUrl: string | null;
  viewerLocalUrl: string | null;
  viewerLanUrl: string | null;
}

export interface Status {
  signaling: ProcState;
  ue: ProcState;
  streamerConnected: boolean;
  activeProjectId: string | null;
  /** 当前生效的服务器模式 */
  serverKind: ServerKind;
  /** 本机访问地址 http://127.0.0.1:port */
  localUrl: string | null;
  /** 局域网访问地址 http://<lan-ip>:port */
  lanUrl: string | null;
  /** 观看端（只读）地址 */
  viewerLocalUrl: string | null;
  viewerLanUrl: string | null;
  message: string;
  /** 启动进度 0-100（用于界面进度条） */
  progress: number;
  /** 所有正在运行的项目（多并发） */
  runs: ProjectRun[];
}

export const IDLE_STATUS: Status = {
  signaling: 'stopped',
  ue: 'stopped',
  streamerConnected: false,
  activeProjectId: null,
  serverKind: 'unknown',
  localUrl: null,
  lanUrl: null,
  viewerLocalUrl: null,
  viewerLanUrl: null,
  message: '',
  progress: 0,
  runs: [],
};

export type LogSource = 'tool' | 'signal' | 'ue';

/** 电脑状态（CPU / 内存 / 显存），主进程每 3 秒采集一次 */
export interface SystemMetrics {
  ts: number;
  cpuPercent: number;
  memUsedGB: number;
  memTotalGB: number;
  gpuUsedGB: number | null;
  gpuTotalGB: number | null;
  gpuName: string | null;
}

export interface LogLine {
  ts: number;
  source: LogSource;
  text: string;
}

export interface StartResult {
  ok: boolean;
  error?: string;
}

/** preload 通过 contextBridge 暴露给渲染进程的 API */
export interface Api {
  listProjects(): Promise<Project[]>;
  /** 打开文件选择框选 exe，返回新建的项目或 null */
  addProject(): Promise<Project | null>;
  removeProject(id: string): Promise<Project[]>;
  updateProject(id: string, patch: Partial<Project>): Promise<Project[]>;
  getSettings(): Promise<Settings>;
  setSettings(patch: Partial<Settings>): Promise<Settings>;
  start(projectId: string): Promise<StartResult>;
  /** 停止指定项目的实例（其它运行中的项目不受影响） */
  stop(projectId: string): Promise<void>;
  /** 停止全部运行中的项目 */
  stopAll(): Promise<void>;
  getStatus(): Promise<Status>;
  getLogs(): Promise<LogLine[]>;
  pickDir(): Promise<string | null>;
  /** 一键放通 Windows 防火墙（信令 TCP 12188 + WebRTC UDP 段），会弹 UAC */
  ensureFirewall(): Promise<{ ok: boolean; message: string }>;
  /** 清除缓存：停止服务、清理遗留进程、重置内置服务配置（项目登记/token/注册表清空） */
  clearCache(): Promise<{ ok: boolean; message: string }>;
  /** 设置/取消开机自启 */
  setAutoLaunch(enabled: boolean): Promise<{ ok: boolean; message: string }>;
  openUrl(url: string): Promise<void>;
  onStatus(cb: (s: Status) => void): void;
  onLog(cb: (l: LogLine) => void): void;
  /** 电脑状态（CPU/内存/显存），主进程定时推送 */
  onMetrics(cb: (m: SystemMetrics) => void): void;
}
