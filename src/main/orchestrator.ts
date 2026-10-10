// 编排器：负责信令服务器 + UE 实例的启动/停止/健康检查
// 事件: 'status' -> Status, 'log' -> LogLine
import { EventEmitter } from 'node:events';
import { ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import net from 'node:net';
import http from 'node:http';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import type { LogLine, Project, ProjectRun, Settings, StartResult, Status } from '../shared/types';
import { IDLE_STATUS } from '../shared/types';
import {
  findPeerStreamRoot,
  findSignalingDir,
  peerStreamRuntimeNode,
  resolveServerScript,
} from './detect';
import { installPlayerPage } from './serverHome';

const MAX_LOGS = 500;

/** 一个项目的运行状态（多项目并发：signal/execue 共享，实例与状态各自独立） */
interface RunState {
  /** 工具侧项目 id（store） */
  storeId: string;
  project: Project;
  /** 信令服务里的项目 ID */
  peerId: string;
  name: string;
  state: 'starting' | 'running' | 'error';
  progress: number;
  message: string;
  streamer: boolean;
  seenStreamer: boolean;
  startFailures: number;
  startFailureCode: string | null;
  localUrl: string | null;
  lanUrl: string | null;
  viewerLocalUrl: string | null;
  viewerLanUrl: string | null;
  /** 收窗方式（5.8/PS2 透明化，其余藏窗） */
  concealKind: 'transparent' | 'hide' | null;
}

export class Orchestrator extends EventEmitter {
  private sig: ChildProcess | null = null;
  private ue: ChildProcess | null = null;
  private execue: ChildProcess | null = null;
  private installer: ChildProcess | null = null;
  private status: Status = { ...IDLE_STATUS };
  private logs: LogLine[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private sigScript: string | null = null;
  private ueLogPath: string | null = null;
  private ueLogWatch: ReturnType<typeof setInterval> | null = null;
  private ueLogOffset = 0;
  private stopping = false;
  /** 运行中的项目（storeId -> 状态） */
  private runs = new Map<string, RunState>();
  /** 信令项目 ID -> storeId（日志事件按它路由） */
  private peerToStore = new Map<string, string>();

  getStatus(): Status {
    return { ...this.status };
  }

  getLogs(): LogLine[] {
    return [...this.logs];
  }

  private log(source: LogLine['source'], text: string): void {
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const entry: LogLine = { ts: Date.now(), source, text: line.slice(0, 2000) };
      this.logs.push(entry);
      if (this.logs.length > MAX_LOGS) this.logs.splice(0, this.logs.length - MAX_LOGS);
      this.emit('log', entry);

      // 推流连接状态从信令日志推断（多项目并发：带 projectId 的事件路由到对应项目）
      // Epic: "Streamer connected: ..."; PeerStream(JSON日志): "instance.engine_connected" / "engine_endpoint_confirmed"
      if (source === 'signal') {
        const peerId = /"projectId":"([^"]+)"/.exec(line)?.[1] ?? '';
        const run = peerId ? this.runByPeer(peerId) : null;
        if (/streamer connected|engine_connected|engine_endpoint_confirmed/i.test(line)) {
          if (run) {
            run.seenStreamer = true;
            run.streamer = true;
            run.progress = Math.max(run.progress, 95);
            run.message = 'UE 已接入信令，正在准备画面…';
            this.emitRuns();
          } else if (!peerId) {
            this.seenStreamer = true;
            this.patch({ streamerConnected: true, progress: 95, message: 'UE 已接入信令，正在准备画面…' });
          }
        } else if (/streamer.*(disconnect|closed|lost|removed)|engine.*disconnect/i.test(line)) {
          if (run) {
            run.seenStreamer = false;
            run.streamer = false;
            this.emitRuns();
          } else if (!peerId) {
            this.seenStreamer = false;
            this.patch({ streamerConnected: false });
          }
        }
        // UE 进程刚起来：进度推进到 70%，并在界面上给出"正在加载引擎"的反馈
        if (/"event":"instance\.ue_process_started"/.test(line) && run) {
          run.progress = Math.max(run.progress, 70);
          run.message = 'UE 引擎加载中（首次约 30~60 秒）…';
          this.emitRuns();
        }
        // 实例结束（引擎断开 / 被停）→ 该项目推流灯熄灭
        if (/"event":"instance\.ended"/.test(line) && run) {
          run.streamer = false;
          run.seenStreamer = false;
          this.emitRuns();
        }
        // 局域网直连模式不配 TURN，这条"未获得中继地址"是正常提示，补一句说明免得误判
        if (/"event":"instance\.engine_turn_candidate_missing"/.test(line)) {
          this.log('tool', '提示：局域网直连模式未配置 TURN 中继，该提示属正常，画面走 P2P 直连。');
        }
      }

      // UE 启动失败（execue 日志）：记录到对应项目，连续失败两次即判定启动不了
      if (source === 'ue' && /"event":"instance\.exited"/.test(line)) {
        const reason = /"reasonCode":"([^"]+)"/.exec(line)?.[1] ?? '';
        const peerId = /"projectId":"([^"]+)"/.exec(line)?.[1] ?? '';
        const run = peerId ? this.runByPeer(peerId) : null;
        if (reason === 'ue_start_failed' && run) {
          const code = /"exitCode":(-?\d+)/.exec(line)?.[1] ?? null;
          run.startFailureCode = code;
          run.startFailures++;
          this.log('tool', `「${run.name}」UE 实例启动失败（退出码 ${code ?? '未知'}，reasonCode=${reason}，第 ${run.startFailures} 次）`);
        } else if (reason === 'ue_start_failed') {
          this.log('tool', `（未登记项目 ${peerId || '未知'} 的预热失败，已忽略）`);
        }
      }
    }
  }

  private patch(patch: Partial<Status>): void {
    const next = { ...this.status, ...patch };
    if (JSON.stringify(next) !== JSON.stringify(this.status)) {
      this.status = next;
      this.emit('status', this.getStatus());
    }
  }

  // ---------- 启动 ----------

  async start(project: Project, settings: Settings): Promise<StartResult> {
    this.lastSettings = settings;
    if (!existsSync(project.exePath)) {
      return { ok: false, error: `找不到程序：${project.exePath}` };
    }
    if (project.engine === 'unity') {
      return { ok: false, error: 'P1 版本暂只支持 UE 打包项目，Unity 支持将在 P2 加入' };
    }
    if (this.runs.has(project.id)) {
      return { ok: false, error: `「${project.name}」已在运行` };
    }
    this.stopping = false;

    // 按设置与自动探测决定服务器模式
    const peerStreamDir = settings.serverMode === 'epic' ? null : findPeerStreamRoot(settings.peerStreamDir);
    if (peerStreamDir) {
      // 内置服务模式：支持多项目并发（共享一个信令服务 + 进程代理，每个项目一个独立实例）
      return this.startPeerStream(project, settings, peerStreamDir);
    }

    // Epic 模式：一个项目一套信令端口，暂不支持并发
    if (this.runs.size > 0) {
      return { ok: false, error: 'Epic 模式暂不支持同时运行多个项目，请先停止正在运行的项目' };
    }
    if (this.sig || this.ue || this.installer) {
      return { ok: false, error: '已有实例在运行，请先停止' };
    }
    this.seenStreamer = false;
    this.concealTick = 0;
    this.patch({ activeProjectId: project.id, message: '正在准备…', signaling: 'starting', progress: 5 });
    return this.startEpic(project, settings);
  }

  // ---------- 内置服务模式（signal + execue + preload） ----------
  //
  // 采用官方三段式：signal（信令）+ execue（进程代理）+ 项目 preload（预热）
  // signal 负责信令协商与实例登记；execue 负责实际拉起/回收 UE 进程；
  // preload=true 让 UE 在后台常驻预热，观众离开后不销毁、反复打开浏览器都能连上。

  private async startPeerStream(project: Project, settings: Settings, srcDir: string): Promise<StartResult> {
    const firstRun = this.runs.size === 0;
    this.log('tool', `服务器模式: 内置服务 · ${srcDir}${firstRun ? '' : '（复用已运行的共享服务）'}`);
    this.lastSourceDir = srcDir;
    if (firstRun) {
      this.sigAutoRestarts = 0;
      this.execueAutoRestarts = 0;
    }

    // 1. 读取 signal.json：端口、项目登记、token
    const cfgFile = join(srcDir, 'config', 'signal.json');
    let cfg: PeerStreamConfig;
    try {
      cfg = JSON.parse(readFileSync(cfgFile, 'utf8')) as PeerStreamConfig;
    } catch (e) {
      return { ok: false, error: `读取 signal.json 失败：${cfgFile}（${(e as Error).message}）` };
    }
    const port = Number(cfg.port) || settings.httpPort || 12188;
    this.activePort = port;

    // 2. 项目登记（含 preload 预热标记；多项目并发 = 允许多个项目同时 preload）
    const reg = ensureProjectRegistered(cfg, cfgFile, project, [...this.peerToStore.keys()]);
    if (!reg.ok || !reg.projectId) return { ok: false, error: reg.error ?? '项目登记失败' };
    const peerId: string = reg.projectId;
    const entry = reg.entry as { pixelStreamingPlugin?: string; metadata?: { ueVersion?: string } } | undefined;
    this.log('tool', `项目「${project.name}」ID: ${peerId}${entry ? `（${String(entry.pixelStreamingPlugin ?? '未知插件')} / UE ${String(entry.metadata?.ueVersion ?? '未知')}）` : ''}`);
    for (const n of reg.notes ?? []) this.log('tool', `配置校正：${n}`);

    // 2b. 预热会话策略：观众离开后不立刻销毁实例，避免每次重新连接都要等 40 秒冷启动
    const warm = ensureWarmSessionPolicy(cfg, cfgFile);
    if (warm.changed) this.log('tool', `已调整会话策略为保持预热：${warm.detail}`);

    // 2c. 局域网模式：清空外网 STUN/TURN。局域网内 host 候选足够，
    //     而外网 STUN 无法响应时 ICE 收集会卡住数秒（这就是"局域网加载很慢"的主因之一）
    if (settings.lanMode) {
      const lan = ensureLanIce(cfg, cfgFile);
      if (lan.changed) this.log('tool', `局域网模式：已停用外网 STUN/TURN（${lan.detail}），建连更快`);
    }

    // 3. execue 白名单登记（execue 只允许启动登记过的 exe）
    const execueCfgFile = join(srcDir, 'config', 'execue.json');
    const ex = ensureExecueAllowed(execueCfgFile, peerId, project.exePath);
    if (!ex.ok) return { ok: false, error: ex.error ?? 'execue 配置写入失败' };

    // 3b. 清理本项目上一次遗留的 UE 进程：
    //     残留进程会抢先重连信令，导致实例状态错乱、观众卡住
    await this.killLeftoverUe(project, settings);

    // 建立运行记录（日志事件按 peerId 路由到它）
    const ver = String(entry?.metadata?.ueVersion ?? '');
    const isPs2 = entry?.pixelStreamingPlugin === 'PixelStreaming2' || /^5\.(?:[89]|\d{2,})/.test(ver);
    const run: RunState = {
      storeId: project.id, project, peerId, name: project.name,
      state: 'starting', progress: 5, message: '正在准备…',
      streamer: false, seenStreamer: false, startFailures: 0, startFailureCode: null,
      localUrl: null, lanUrl: null, viewerLocalUrl: null, viewerLanUrl: null,
      concealKind: isPs2 ? 'transparent' : 'hide',
    };
    this.runs.set(project.id, run);
    this.peerToStore.set(peerId, project.id);
    this.emitRuns();

    // 4. 共享信令服务：首个项目启动时全新建；已有项目在跑则复用同一个服务
    if (firstRun) {
      // 清理上次异常退出（没走正常停止）遗留的信令/进程代理：
      // 信号服务只在启动时读一次项目配置、之后不再重读；复用一个旧信号会继续预热
      // 上次的项目（表现为"不论选哪个项目都启动旧项目"），失败时还每 30 秒无限重启。
      await this.killLeftoverServer(port);
      await sleep(500);
    }
    if (!this.sig && !(await tcpProbe(port))) {
      run.progress = 15; run.message = '正在启动信令服务…'; this.emitRuns();
      const sigResult = this.spawnPeerStreamSignal(srcDir);
      if (!sigResult.ok) return this.abortRun(run, sigResult.error ?? '信令服务启动失败');
      const up = await waitFor(() => tcpProbe(port), 20_000, 500);
      if (!up) return this.abortRun(run, `信令服务启动超时，端口 ${port} 未就绪，详见日志`);
      this.log('tool', `信令服务已就绪：端口 ${port}`);
    } else if (!this.sig) {
      this.sigExternal = true;
      this.log('tool', `端口 ${port} 已有信令服务在运行（外部管理器），直接复用`);
    }

    // 5. 进程代理（execue）：所有项目共享一个
    run.progress = 30; run.message = '正在启动进程代理…'; this.emitRuns();
    const h0 = await httpJson(port, '/health');
    if (!h0 || Number(h0.agents) < 1) {
      const exeResult = this.spawnExecue(srcDir);
      if (!exeResult.ok) return this.abortRun(run, exeResult.error ?? 'execue 启动失败');
      const agentsUp = await waitFor(async () => {
        const h = await httpJson(port, '/health');
        return Boolean(h && Number(h.agents) >= 1);
      }, 20_000, 1000);
      if (!agentsUp) return this.abortRun(run, 'execue 未连接信令服务，详见日志');
      this.log('tool', 'execue 已连接信令服务');
    } else if (firstRun) {
      this.log('tool', '已有 execue 在运行，直接复用');
    }

    // 6. 等待本项目实例接入信令（其它项目同时启动时互不影响）
    run.progress = 45; run.message = `正在启动 UE 实例（${project.name}），首次约需 30~60 秒…`; this.emitRuns();
    this.startHealth();
    const outcome = await this.waitForWarmEngine(run, 120_000);
    if (outcome === 'ue_failed') {
      const code = run.startFailureCode;
      return this.abortRun(
        run,
        `UE 实例启动失败（退出码 ${code ?? '未知'}）。请先手动双击运行该打包程序 ${project.exePath} 确认它自身能启动；` +
          '常见原因：打包产物不完整/损坏、显存不足（同时跑多个项目时尤其注意）、缺少运行库。',
      );
    }
    if (outcome === 'timeout') {
      return this.abortRun(run, 'UE 实例预热超时（120 秒）。若同时运行多个项目，请确认显卡显存是否够用，详见日志。');
    }
    this.log('tool', `「${project.name}」UE 实例已预热并接入信令`);
    // 收窗策略（2026-10-10 实测）：
    // - 5.8/PS2 只能"透明化"：SW_HIDE / 最小化 / 移出屏幕，引擎都会在 2.5~4 分钟内
    //   engine_disconnected（预热实例被反复销毁）；窗口必须留在显示器上被 DWM 合成才稳定。
    //   WS_EX_LAYERED + alpha=0 后用户看不到窗口，任务栏/Alt+Tab 也没有它，推流不受影响。
    // - 5.3/经典插件照常延时 SW_HIDE 藏窗（实测无碍）。
    if (run.concealKind === 'transparent') this.transparentizeUeWindows(project.exePath, 1500);
    else this.hideUeWindows(project.exePath, 1500);

    // 7. 播放页：与信令共用端口；多项目通过 URL 的 project 参数区分
    const pagePath = installPlayerPage(srcDir);

    // 8. 访问地址（控制端 + 观看端，官方 Multiple Player Endpoints 方案）
    const q = `?project=${encodeURIComponent(peerId)}&token=${encodeURIComponent(cfg.auth?.playerToken ?? '')}`;
    const viewerQ = `?project=${encodeURIComponent(peerId)}&token=${encodeURIComponent(cfg.auth?.viewerToken ?? '')}&viewOnly=1`;
    const page = pagePath ? 'shengxiao.html' : 'index.html';
    const lan = lanIp();
    run.localUrl = `http://127.0.0.1:${port}/${page}${q}`;
    run.viewerLocalUrl = `http://127.0.0.1:${port}/${page}${viewerQ}`;
    run.lanUrl = lan ? `http://${lan}:${port}/${page}${q}` : null;
    run.viewerLanUrl = lan ? `http://${lan}:${port}/${page}${viewerQ}` : null;
    run.state = 'running';
    run.progress = 100;
    run.message = '已就绪，浏览器可访问';
    this.patch({ serverKind: 'peerstream' });
    this.emitRuns();
    this.log('tool', `「${project.name}」已就绪：${run.localUrl}`);
    return { ok: true };
  }

  /** 启动失败：撤销该项目（关预热标记、移除状态）；没有其它项目在跑时顺带停掉共享服务 */
  private abortRun(run: RunState, error: string): StartResult {
    this.log('tool', `「${run.name}」启动失败：${error}`);
    this.setProjectPreload(run.peerId, false);
    this.runs.delete(run.storeId);
    this.peerToStore.delete(run.peerId);
    if (this.runs.size === 0) {
      this.killShared();
      this.stopHealth();
      this.patch({ ...IDLE_STATUS, message: error });
    } else {
      this.emitRuns();
    }
    return { ok: false, error };
  }

  /** 把 runs 汇总进 status 并广播；顶层字段取聚合值以兼容旧逻辑 */
  private emitRuns(): void {
    const runs: ProjectRun[] = [...this.runs.values()].map((r) => ({
      projectId: r.storeId,
      name: r.name,
      state: r.state,
      progress: r.progress,
      message: r.message,
      streamerConnected: r.streamer,
      localUrl: r.localUrl,
      lanUrl: r.lanUrl,
      viewerLocalUrl: r.viewerLocalUrl,
      viewerLanUrl: r.viewerLanUrl,
    }));
    const anyRunning = runs.find((r) => r.state === 'running');
    const last = runs[runs.length - 1];
    this.patch({
      runs,
      signaling: this.sig || this.sigExternal ? 'running' : runs.length ? 'starting' : 'stopped',
      ue: anyRunning ? 'running' : runs.length ? 'starting' : 'stopped',
      streamerConnected: runs.some((r) => r.streamerConnected),
      activeProjectId: last ? last.projectId : null,
      localUrl: last?.localUrl ?? null,
      lanUrl: last?.lanUrl ?? null,
      viewerLocalUrl: last?.viewerLocalUrl ?? null,
      viewerLanUrl: last?.viewerLanUrl ?? null,
      message: runs.length ? (runs.some((r) => r.state === 'starting') ? '正在启动…' : `运行中（${runs.length} 个项目）`) : this.status.message,
      progress: last?.progress ?? 0,
    });
  }

  private runByPeer(peerId: string): RunState | null {
    const storeId = this.peerToStore.get(peerId);
    return storeId ? this.runs.get(storeId) ?? null : null;
  }

  /** 写回 signal.json 里某个项目的 preload（停止项目必须关掉，否则信令服务会把它再拉起来） */
  private setProjectPreload(peerId: string, value: boolean): void {
    const srcDir = this.lastSourceDir;
    if (!srcDir) return;
    const file = join(srcDir, 'config', 'signal.json');
    try {
      const cfg = JSON.parse(readFileSync(file, 'utf8')) as PeerStreamConfig;
      const p = cfg.projects?.find((x) => x.id === peerId);
      if (!p) return;
      const meta = { ...(p.metadata ?? {}) };
      if (meta.preload === value) return;
      meta.preload = value;
      p.metadata = meta;
      writeFileSync(file, JSON.stringify(cfg, null, 2), 'utf8');
    } catch {
      /* 忽略：不影响停止流程 */
    }
  }

  /**
   * 等待 UE 引擎真正接入信令服务。
   * 判据用"引擎已连接"，不用 /health 的 instances 计数——启动失败的实例也会被计数。
   * execue 报 ue_start_failed 时容忍一次重试，连续两次失败即判定为启动不了并立即返回。
   */
  /** UE 5.8 PixelStreaming2 必须保留可见窗口，否则预热超时（-RenderOffScreen/藏窗会卡死）。 */
  private shouldShowUeWindow(project: Project): boolean {
    const anyP = project as unknown as {
      engine?: string;
      pixelStreamingPlugin?: string;
      metadata?: { ueVersion?: string };
      ueVersion?: string;
    };
    const plugin = String(anyP.pixelStreamingPlugin ?? '');
    const ver = String(anyP.metadata?.ueVersion ?? anyP.ueVersion ?? '');
    const isPs2 = plugin === 'PixelStreaming2';
    const is58 = /^5\.(?:[89]|\d{2,})/.test(ver);
    return isPs2 || is58;
  }

  private async waitForWarmEngine(run: RunState, timeoutMs: number): Promise<'ready' | 'ue_failed' | 'timeout'> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (run.seenStreamer) return 'ready';
      if (run.startFailures >= 2) return 'ue_failed';
      await sleep(1000);
    }
    return run.seenStreamer ? 'ready' : 'timeout';
  }

  /**
   * 结束上一次遗留的、与本项目同一个 exe 的 UE 进程。
   * 只针对当前项目的可执行文件（含 UE 的 <名字>-Win64-Shipping.exe 变体），不动其它程序。
   */
  async killLeftoverUe(project: Project, settings: Settings): Promise<void> {
    if (settings.keepLeftoverUe) return;
    // 覆盖引导 exe 和真实游戏体（<名>-Win64-Shipping.exe），两者是不同路径
    const exeDir = dirname(project.exePath).replace(/'/g, "''");
    const base = basename(project.exePath).replace(/\.exe$/i, '').replace(/'/g, "''");
    try {
      const ps = [
        `Get-CimInstance Win32_Process | Where-Object {`,
        `  ($_.ExecutablePath -and $_.ExecutablePath.StartsWith('${exeDir}', [StringComparison]::OrdinalIgnoreCase))`,
        `  -and ($_.Name -match '^${base}')`,
        `} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; "$($_.ProcessId)" }`,
      ].join(' ');
      const killed = (await this.runPowerShell(ps, 15000)).trim();
      if (killed) this.log('tool', `已清理遗留 UE 进程：PID ${killed.replace(/\s+/g, ', ')}`);
    } catch {
      /* 清理失败不阻塞启动 */
    }
  }

  /**
   * 清理上次异常退出遗留的信令服务 / 进程代理进程。
   * 信号服务只在启动时读一次项目配置，之后不再重读——复用它会导致"预热旧项目"，
   * 失败时还每 30 秒无限重启。启动前把它们杀掉，保证每次都是全新信号读到最新配置。
   */
  async killLeftoverServer(port: number): Promise<void> {
    const ps = `
$killed = @()
try {
  Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique |
    ForEach-Object {
      if ($_ -ne $PID) { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue; $killed += $_ }
    }
} catch {}
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like '*execue/index.js*' } |
  ForEach-Object {
    if ($_.ProcessId -ne $PID) { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $killed += $_.ProcessId }
  }
if ($killed.Count) { Write-Output ("killed=" + ($killed -join ',')) } else { Write-Output "killed=" }
`;
    try {
      const text = (await this.runPowerShell(ps, 15000)).trim();
      if (text && text !== 'killed=') {
        this.log('tool', `已清理上次遗留的信令/代理进程：PID ${text.replace('killed=', '').split(',').join(', ')}`);
      }
    } catch {
      /* 清理失败不阻塞启动 */
    }
  }

  /**
   * 异步执行 PowerShell 并返回 stdout。
   * 注意：绝不能用 spawnSync —— 它会在主进程里同步等待（几百毫秒到十几秒），期间界面完全卡住。
   */
  private runPowerShell(ps: string, timeoutMs = 12000): Promise<string> {
    return new Promise((resolve) => {
      let out = '';
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        resolve(out);
      };
      try {
        const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        child.stdout?.on('data', (b: Buffer) => (out += b.toString()));
        child.on('error', finish);
        child.on('close', finish);
        setTimeout(() => {
          try {
            child.kill();
          } catch {
            /* ignore */
          }
          finish();
        }, timeoutMs).unref?.();
      } catch {
        finish();
      }
    });
  }

  /**
   * 启动成功后隐藏 UE 窗口。delayMs 供 5.8/PS2 在 engine_connected 后多等一会再藏。
   * 主窗口常在 <Game>-Win64-Shipping.exe 上，不只在 Bootstrap exe 上。
   */
  private hideUeWindows(exePath: string, delayMs = 1500): void {
    this.log('tool', `UE 窗口将在 ${(delayMs / 1000).toFixed(1)}s 后隐藏…`);
    const run = async (attempt: number): Promise<void> => {
      if (this.stopping) return;
      try {
        const exeDir = dirname(exePath).replace(/'/g, "''");
        const pkgRoot = dirname(exeDir).replace(/'/g, "''");
        const base = basename(exePath).replace(/\.exe$/i, '').replace(/'/g, "''");
        const ps = `
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;using System.Collections.Generic;public class SW{
  [DllImport("user32.dll")]public static extern bool ShowWindow(IntPtr h,int c);
  [DllImport("user32.dll")]public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")]public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr p);
  [DllImport("user32.dll")]public static extern int GetWindowThreadProcessId(IntPtr h, out uint p);
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr p);
  public static List<IntPtr> Visible = new List<IntPtr>();
  public static bool Cb(IntPtr h, IntPtr p){ if(IsWindowVisible(h)) Visible.Add(h); return true; }
  public static void Collect(){ Visible.Clear(); EnumWindows(Cb, IntPtr.Zero); }
}'
$roots = @('${exeDir}', '${pkgRoot}')
$targets = @()
foreach ($p in Get-Process -ErrorAction SilentlyContinue) {
  try {
    if (-not $p.Path) { continue }
    foreach ($r in $roots) {
      if ($p.Path.StartsWith($r, [StringComparison]::OrdinalIgnoreCase)) { $targets += $p; break }
    }
  } catch {}
}
[SW]::Collect()
$hidden = 0
foreach ($h in [SW]::Visible) {
  [uint]$pid2 = 0
  [void][SW]::GetWindowThreadProcessId($h, [ref]$pid2)
  $owner = Get-Process -Id ([int]$pid2) -ErrorAction SilentlyContinue
  if (-not $owner) { continue }
  $ok = $false
  if ($targets | Where-Object { $_.Id -eq $owner.Id }) { $ok = $true }
  if (-not $ok -and $owner.Name -like "*${base}*") { $ok = $true }
  if ($ok) {
    [void][SW]::ShowWindow($h, 0)
    $hidden++
  }
}
Write-Output "hidden_count=$hidden procs=$($targets.Count) names=$(($targets | Select-Object -ExpandProperty Name -Unique) -join ',')"
`;
        const text = (await this.runPowerShell(ps, 10000)).trim();
        if (text.includes('hidden_count=') && !text.includes('hidden_count=0')) {
          this.log('tool', `已隐藏 UE 窗口（${text}）`);
          return;
        }
        if (attempt < 2) {
          this.log('tool', `UE 窗口未藏到（${text || 'no output'}），${2}s 后重试`);
          setTimeout(() => run(attempt + 1), 2000);
        } else {
          this.log('tool', `UE 窗口隐藏失败（${text || 'no output'}）`);
        }
      } catch (e) {
        this.log('tool', `隐藏 UE 窗口异常: ${(e as Error).message}`);
      }
    };
    setTimeout(() => run(0), delayMs);
  }

  /**
   * 5.8/PS2 的收窗方式：全透明（WS_EX_LAYERED + alpha=0 + WS_EX_TOOLWINDOW）。
   * 实测（2026-10-10）：SW_HIDE / 最小化 / 移出屏幕，引擎都会在 2.5~4 分钟内
   * engine_disconnected —— 窗口必须留在显示器上被 DWM 合成，引擎才稳定；
   * 而 alpha=0 后用户完全看不到窗口，任务栏与 Alt+Tab 也没有它，推流正常。
   * 幂等：已是透明状态的窗口计入 unchanged，不重复打日志。
   */
  private transparentizeUeWindows(exePath: string, delayMs = 0, quiet = false): void {
    const run = async (attempt: number): Promise<void> => {
      if (this.stopping) return;
      try {
        const exeDir = dirname(exePath).replace(/'/g, "''");
        const pkgRoot = dirname(exeDir).replace(/'/g, "''");
        const ps = `
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class TW{
  [DllImport("user32.dll")]public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll",EntryPoint="SetWindowLongPtrW")]public static extern IntPtr SetWindowLongPtr(IntPtr h,int n,IntPtr v);
  [DllImport("user32.dll",EntryPoint="GetWindowLongPtrW")]public static extern IntPtr GetWindowLongPtr(IntPtr h,int n);
  [DllImport("user32.dll")]public static extern bool SetLayeredWindowAttributes(IntPtr h,uint c,uint a,uint f);
  [DllImport("user32.dll")]public static extern bool GetLayeredWindowAttributes(IntPtr h,out uint c,out byte a,out uint f);
  [DllImport("user32.dll")]public static extern bool SetWindowPos(IntPtr h,IntPtr a,int x,int y,int cx,int cy,uint f);
}'
$roots = @('${exeDir}', '${pkgRoot}')
$converted = 0; $unchanged = 0; $failed = 0; $total = 0
foreach ($p in Get-Process -ErrorAction SilentlyContinue) {
  try {
    if (-not $p.Path -or $p.MainWindowHandle -eq 0) { continue }
    $isTarget = $false
    foreach ($r in $roots) { if ($p.Path.StartsWith($r, [StringComparison]::OrdinalIgnoreCase)) { $isTarget = $true; break } }
    if (-not $isTarget) { continue }
    $h = $p.MainWindowHandle
    if (-not [TW]::IsWindowVisible($h)) { continue }
    $total++
    $style = [TW]::GetWindowLongPtr($h, -20).ToInt64()
    [uint32]$ca = 0; [byte]$aa = 0; [uint32]$fa = 0
    [void][TW]::GetLayeredWindowAttributes($h, [ref]$ca, [ref]$aa, [ref]$fa)
    $already = (($style -band 0x80000) -ne 0) -and (($style -band 0x80) -ne 0) -and (($style -band 0x40000) -eq 0) -and $aa -eq 0
    if ($already) { $unchanged++; continue }
    $new = ($style -bor 0x80000 -bor 0x80) -band (-bnot 0x40000)
    [void][TW]::SetWindowLongPtr($h, -20, [IntPtr]$new)
    [void][TW]::SetLayeredWindowAttributes($h, 0, 0, 0x2)
    [void][TW]::SetWindowPos($h, [IntPtr]::Zero, 0, 0, 0, 0, 0x37)
    [uint32]$cb = 0; [byte]$ab = 0; [uint32]$fb = 0
    [void][TW]::GetLayeredWindowAttributes($h, [ref]$cb, [ref]$ab, [ref]$fb)
    $ok = ($ab -eq 0) -and (([TW]::GetWindowLongPtr($h, -20).ToInt64() -band 0x80000) -ne 0) -and [TW]::IsWindowVisible($h)
    if ($ok) { $converted++ } else { $failed++ }
  } catch { $failed++ }
}
Write-Output "converted=$converted unchanged=$unchanged failed=$failed total=$total"
`;
        const text = (await this.runPowerShell(ps, 10000)).trim();
        const m = /converted=(\d+) unchanged=(\d+) failed=(\d+) total=(\d+)/.exec(text);
        if (m) {
          const converted = Number(m[1]);
          const unchanged = Number(m[2]);
          const failed = Number(m[3]);
          const total = Number(m[4]);
          if (total > 0 && failed === 0) {
            if (converted > 0 && !quiet) this.log('tool', 'UE 窗口已透明化（桌面/任务栏不可见，推流保持稳定）');
            return;
          }
        }
        if (attempt < 2) {
          setTimeout(() => run(attempt + 1), 2000);
        } else if (!quiet) {
          this.log('tool', `UE 窗口透明化未完成（${text || 'no output'}）`);
        }
      } catch (e) {
        if (!quiet) this.log('tool', `透明化 UE 窗口异常: ${(e as Error).message}`);
      }
    };
    if (delayMs > 0) setTimeout(() => run(0), delayMs);
    else run(0);
  }

  private spawnExecue(srcDir: string): StartResult {    const nodeExe = peerStreamRuntimeNode(srcDir);
    const cmd = nodeExe ?? process.execPath;
    const args = nodeExe ? [join('src', 'execue', 'index.js')] : [join(srcDir, 'src', 'execue', 'index.js')];
    const env = nodeExe ? { ...process.env } : { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
    this.log('tool', `启动进程代理: ${cmd} ${args.join(' ')}`);
    try {
      const child = spawn(cmd, args, {
        cwd: srcDir,
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.execue = child;
      // execue 的输出里含 UE 的启动与运行日志，归到 UE 通道
      child.stdout?.on('data', (b: Buffer) => this.log('ue', b.toString()));
      child.stderr?.on('data', (b: Buffer) => this.log('ue', b.toString()));
      child.on('error', (err) => {
        this.execue = null;
        this.log('tool', `execue 进程错误: ${err.message}`);
        this.patch({ ue: 'error', message: `execue 错误: ${err.message}` });
      });
      child.on('exit', (code) => {
        this.execue = null;
        if (!this.stopping) {
          this.log('tool', `execue 已退出 (code=${code})，UE 实例随之结束`);
          this.patch({ ue: 'stopped', streamerConnected: false, message: `execue 已退出 (${code})` });
        }
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: `execue 启动异常: ${(e as Error).message}` };
    }
  }

  private spawnPeerStreamSignal(srcDir: string): StartResult {
    const nodeExe = peerStreamRuntimeNode(srcDir);
    // 优先用管理器自带 Node（版本匹配），否则用 Electron 内置 Node（ELECTRON_RUN_AS_NODE）
    const cmd = nodeExe ?? process.execPath;
    const args = nodeExe
      ? [join('src', 'signal', 'index.js')]
      : [join(srcDir, 'src', 'signal', 'index.js')];
    const env = nodeExe ? { ...process.env } : { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
    this.log('tool', `启动信令服务: ${cmd} ${args.join(' ')}`);
    try {
      const child = spawn(cmd, args, {
        cwd: srcDir,
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.sig = child;
      child.stdout?.on('data', (b: Buffer) => this.log('signal', b.toString()));
      child.stderr?.on('data', (b: Buffer) => this.log('signal', b.toString()));
      child.on('error', (err) => {
        this.sig = null;
        this.log('tool', `信令服务进程错误: ${err.message}`);
        this.patch({ signaling: 'error', message: `信令服务错误: ${err.message}` });
      });
      child.on('exit', (code) => {
        this.sig = null;
        if (!this.stopping) {
          this.log('tool', `信令服务已退出 (code=${code})`);
          this.patch({ signaling: code === 0 ? 'stopped' : 'error', streamerConnected: false, message: `信令服务已退出 (${code})` });
        }
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: `信令服务启动异常: ${(e as Error).message}` };
    }
  }

  // ---------- Epic SignallingWebServer 模式（兼容保留） ----------

  private async startEpic(project: Project, settings: Settings): Promise<StartResult> {
    // 1. 定位信令服务器
    const sigDir = findSignalingDir(project.exePath, settings.signalingDir);
    if (!sigDir) {
      return {
        ok: false,
        error:
          '未找到内置信令服务目录。请在「设置」里指定它的位置（含 src/signal/index.js 的目录）。',
      };
    }
    const script = resolveServerScript(sigDir);
    if (!script) {
      return { ok: false, error: `信令目录缺少主脚本（SignallingWebServer.js / cirrus.js）：${sigDir}` };
    }
    this.sigScript = script;
    this.log('tool', `服务器模式: Epic · 信令服务器: ${script}`);

    // 2a. 官方 SignallingWebServer（cirrus.js）的端口读自 config.json，先把设置里的端口写进去
    this.applyOfficialSignallingConfig(sigDir, settings);

    // 2. 依赖检查（缺 node_modules 时尝试 npm install）
    if (!existsSync(join(sigDir, 'node_modules'))) {
      this.patch({ message: '首次运行：正在安装信令服务器依赖 (npm install)…' });
      const inst = await this.ensureDeps(sigDir);
      if (!inst.ok) return inst;
    }

    // 3. 启动信令服务器
    this.patch({ message: '正在启动信令服务器…' });
    const sigResult = this.spawnSignaling(sigDir, script, settings);
    if (!sigResult.ok) return sigResult;

    // 4. 启动 UE 实例（后台带参，参考 PeerStream 管理器 process-manager.js）
    this.patch({ message: `正在启动 ${project.name}…` });
    const epicArgs = [
      '-AudioMixer',
      '-Unattended',
      '-ResX=1920',
      '-ResY=1080',
      '-PixelStreamingIP=127.0.0.1',
      `-PixelStreamingPort=${settings.streamerPort}`,
    ];
    // 参考 PeerStream 管理器：-RenderOffScreen（大写 S）+ windowsHide:true
    if (settings.renderOffscreen) epicArgs.push('-RenderOffScreen');
    const ueResult = this.spawnUe(project, settings, epicArgs);
    if (!ueResult.ok) {
      await this.stop();
      this.patch({ signaling: 'stopped', ue: 'stopped', message: ueResult.error ?? 'UE 启动失败' });
      return ueResult;
    }

    // 5. 隐藏 UE 窗口（-RenderOffscreen 不一定生效的后备方案）；5.8/PS2 不藏
    if (!this.shouldShowUeWindow(project)) this.hideUeWindows(project.exePath);

    // 6. 健康检查
    this.startHealth();
    this.patch({
      signaling: 'running',
      ue: 'running',
      serverKind: 'epic',
      localUrl: `http://127.0.0.1:${settings.httpPort}`,
      lanUrl: lanIp() ? `http://${lanIp()}:${settings.httpPort}` : null,
      message: '运行中，等待浏览器连接…',
    });
    return { ok: true };
  }

  private fail(msg: string): void {
    this.log('tool', `错误: ${msg}`);
    this.patch({ signaling: 'stopped', ue: 'stopped', activeProjectId: null, message: msg, progress: 0 });
    this.killAll();
  }

  private ensureDeps(sigDir: string): Promise<StartResult> {
    this.log('tool', `信令服务器依赖未安装，执行 npm install: ${sigDir}`);
    return new Promise((resolve) => {
      const child = spawn('npm install --no-audit --no-fund', {
        cwd: sigDir,
        shell: true,
        windowsHide: true,
      });
      this.installer = child;
      const collect = (buf: Buffer) => this.log('signal', buf.toString());
      child.stdout?.on('data', collect);
      child.stderr?.on('data', collect);
      child.on('error', (err) => {
        this.installer = null;
        resolve({
          ok: false,
          error: `无法执行 npm install（${err.message}）。请先安装 Node.js，或手动在目录执行 npm install：${sigDir}`,
        });
      });
      child.on('exit', (code) => {
        this.installer = null;
        if (code === 0) {
          this.log('tool', '依赖安装完成');
          resolve({ ok: true });
        } else {
          resolve({
            ok: false,
            error: `npm install 失败 (exit ${code})。可手动在目录执行：${sigDir}`,
          });
        }
      });
    });
  }

  /**
   * 官方 SignallingWebServer（cirrus.js）的端口不是命令行参数，而是读 config.json 的
   * HttpPort / StreamerPort；启动前把设置里的端口写进去。
   */
  private applyOfficialSignallingConfig(sigDir: string, settings: Settings): void {
    const file = join(sigDir, 'config.json');
    try {
      if (!existsSync(file)) return;
      const cfg = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
      if (!('HttpPort' in cfg)) return; // 不是官方格式的配置，交给命令行参数
      let changed = false;
      if (Number(cfg.HttpPort) !== settings.httpPort) {
        cfg.HttpPort = settings.httpPort;
        changed = true;
      }
      if (Number(cfg.StreamerPort) !== settings.streamerPort) {
        cfg.StreamerPort = settings.streamerPort;
        changed = true;
      }
      if (changed) {
        writeFileSync(file, JSON.stringify(cfg, null, '\t'), 'utf8');
        this.log('tool', `官方信令配置：端口 → HTTP ${settings.httpPort} / Streamer ${settings.streamerPort}`);
      }
    } catch {
      /* 写不进去时保持原配置，启动阶段会报错 */
    }
  }

  private spawnSignaling(sigDir: string, script: string, settings: Settings): StartResult {
    const args = [script];
    const isModern = /SignallingWebServer\.js$/i.test(script);
    if (isModern) {
      args.push(`--httpPort=${settings.httpPort}`, `--playerPort=${settings.httpPort}`, `--streamerPort=${settings.streamerPort}`);
    } else {
      // 旧版 cirrus.js
      args.push(`--port=${settings.httpPort}`);
    }
    if (settings.signalingExtraArgs.trim()) {
      args.push(...tokenize(settings.signalingExtraArgs));
    }

    try {
      // 用 Electron 自带的 Node 运行（ELECTRON_RUN_AS_NODE），无需用户另装 Node 即可启动服务
      const child = spawn(process.execPath, args, {
        cwd: sigDir,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.sig = child;
      child.stdout?.on('data', (b: Buffer) => this.log('signal', b.toString()));
      child.stderr?.on('data', (b: Buffer) => this.log('signal', b.toString()));
      child.on('error', (err) => {
        this.log('tool', `信令服务器进程错误: ${err.message}`);
        this.patch({ signaling: 'error', message: `信令服务器错误: ${err.message}` });
      });
      child.on('exit', (code) => {
        this.sig = null;
        if (!this.stopping) {
          this.log('tool', `信令服务器已退出 (code=${code})`);
          this.patch({ signaling: code === 0 ? 'stopped' : 'error', streamerConnected: false, message: `信令服务器已退出 (${code})` });
        }
      });
      this.log('tool', `信令服务器已启动，端口 http=${settings.httpPort} streamer=${settings.streamerPort}`);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: `信令服务器启动异常: ${(e as Error).message}` };
    }
  }

  /** baseArgs 由调用方给出（PeerStream 模式来自 signal.json，Epic 模式为 IP/Port 参数） */
  private spawnUe(project: Project, settings: Settings, baseArgs: string[]): StartResult {
    const args: string[] = [...baseArgs];
    if (settings.renderOffscreen && !this.shouldShowUeWindow(project) && !args.some((a) => /^-RenderOffScreen$/i.test(a))) {
      args.push('-RenderOffScreen');
    }
    if (this.shouldShowUeWindow(project)) {
      for (let i = args.length - 1; i >= 0; i--) {
        if (/^-RenderOffScreen$/i.test(String(args[i]))) args.splice(i, 1);
      }
    }
    // 日志落盘便于诊断（Shipping 包部分日志会裁剪）
    const logDir = join(process.env.LOCALAPPDATA ?? dirname(project.exePath), 'xiangshu-logs');
    try {
      mkdirSync(logDir, { recursive: true });
      this.ueLogPath = join(logDir, `${sanitize(project.name)}.log`);
      args.push(`-abslog=${this.ueLogPath}`);
    } catch {
      this.ueLogPath = null;
    }
    if (settings.ueExtraArgs.trim()) {
      args.push(...tokenize(settings.ueExtraArgs));
    }

    try {
      // 参考 PeerStream 管理器 process-manager.js:47 的 spawn 方式
      const noProxy = [process.env.NO_PROXY, process.env.no_proxy, '127.0.0.1', 'localhost', '::1'].filter(Boolean).join(',');
      const child = spawn(project.exePath, args, {
        cwd: dirname(project.exePath),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NO_PROXY: noProxy, no_proxy: noProxy },
      });
      this.ue = child;
      child.stdout?.on('data', (b: Buffer) => this.log('ue', b.toString()));
      child.stderr?.on('data', (b: Buffer) => this.log('ue', b.toString()));
      child.on('error', (err) => {
        this.ue = null;
        this.log('tool', `UE 进程错误: ${err.message}`);
        this.patch({ ue: 'error', streamerConnected: false, message: `UE 错误: ${err.message}` });
      });
      child.on('exit', (code) => {
        this.ue = null;
        this.stopUeLogWatch();
        if (!this.stopping) {
          this.log('tool', `UE 实例已退出 (code=${code})`);
          this.patch({ ue: 'error', streamerConnected: false, message: `UE 实例已退出 (${code})` });
        }
      });
      this.log('tool', `UE 已启动: ${project.exePath} ${args.join(' ')}`);
      this.startUeLogWatch();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: `UE 启动异常: ${(e as Error).message}` };
    }
  }

  // UE 日志文件 tail（-abslog 输出的内容补进日志面板）
  private startUeLogWatch(): void {
    this.stopUeLogWatch();
    this.ueLogOffset = 0;
    this.ueLogWatch = setInterval(() => {
      if (!this.ueLogPath || !existsSync(this.ueLogPath)) return;
      try {
        const size = statSync(this.ueLogPath).size;
        if (size <= this.ueLogOffset) return;
        // 简单实现：只读新增部分（文件过大时从头读末尾 64KB）
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { readFileSync } = require('node:fs') as typeof import('node:fs');
        const start = size > 65536 ? Math.max(this.ueLogOffset, size - 65536) : this.ueLogOffset;
        const fd = readFileSync(this.ueLogPath, { encoding: 'utf8' });
        const chunk = fd.slice(start);
        this.ueLogOffset = size;
        if (chunk.trim()) this.log('ue', chunk);
      } catch {
        /* 日志文件被占用时跳过 */
      }
    }, 2000);
  }

  private stopUeLogWatch(): void {
    if (this.ueLogWatch) {
      clearInterval(this.ueLogWatch);
      this.ueLogWatch = null;
    }
  }

  // ---------- 健康检查 ----------

  private startHealth(): void {
    this.stopHealth();
    this.timer = setInterval(async () => {
      const s = this.lastSettings;
      if (!s) return;

      // 5.8/PS2 透明收窗周期兜底（仅预热成功、健康检查启动后才会走到这里）：
      // 实例热重启出来的新窗口默认可见，约 16 秒内重新透明化；已是透明状态则幂等跳过。
      if (++this.concealTick >= 8) {
        this.concealTick = 0;
        for (const run of this.runs.values()) {
          if (run.concealKind === 'transparent' && run.state === 'running') {
            this.transparentizeUeWindows(run.project.exePath, 0, true);
          }
        }
      }

      const port = this.activePort ?? s.httpPort;
      const peerMode = this.status.serverKind === 'peerstream';

      if (peerMode) {
        const h = await httpJson(port, '/health');
        if (!h) {
          // 信令服务无响应 → 尝试自动重启（最多 3 次）
          if (this.sigAutoRestarts < 3 && !this.stopping) {
            this.sigAutoRestarts++;
            this.log('tool', `信令服务无响应，自动重启（第 ${this.sigAutoRestarts} 次）`);
            const srcDir = this.lastSourceDir;
            if (srcDir) {
              this.sigExternal = false;
              const r = this.spawnPeerStreamSignal(srcDir);
              if (!r.ok) this.log('tool', `信令重启失败：${r.error}`);
            }
          }
          this.patch({ signaling: 'error', message: '信令服务无响应，自动恢复中…' });
        } else {
          const instances = Number(h.instances) || 0;
          const agents = Number(h.agents) || 0;
          const sessions = Number(h.sessions) || 0;

          // execue 掉线 → 自动重启
          if (agents < 1 && this.execueAutoRestarts < 3 && !this.stopping && this.lastSourceDir) {
            this.execueAutoRestarts++;
            this.log('tool', `execue 掉线，自动重启（第 ${this.execueAutoRestarts} 次）`);
            const r = this.spawnExecue(this.lastSourceDir);
            if (!r.ok) this.log('tool', `execue 重启失败：${r.error}`);
          }

          this.patch({ signaling: agents >= 1 ? 'running' : 'starting' });
          void instances;
          void sessions;
        }
      } else {
        const sigAlive = await tcpProbe(port);
        const streamerAlive = await tcpProbe(s.streamerPort);
        const signaling: Status['signaling'] = !this.sig && !this.sigExternal ? 'stopped' : sigAlive ? 'running' : 'starting';
        const connected = this.seenStreamer && streamerAlive;
        if (this.ue && (this.sig || this.sigExternal)) {
          this.patch({
            signaling,
            streamerConnected: connected,
            message: connected ? '运行中，浏览器可访问' : '启动中，等待 UE 接入信令服务…',
          });
        }
      }

      if (this.runs.size === 0 && !this.sig && !this.sigExternal && !this.ue && !this.execue && !this.installer) {
        this.stopHealth();
        this.patch({ activeProjectId: null, localUrl: null, lanUrl: null, viewerLocalUrl: null, viewerLanUrl: null, runs: [] });
      }
    }, 2000);
  }

  private stopHealth(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private lastSettings: Settings | null = null;
  /** 信令日志里是否见过 Streamer connected（断开后置 false，UE 重启重连再置 true） */
  private seenStreamer = false;
  /** 信令服务是外部已在运行的（外部管理器启动的），停止时不杀它 */
  private sigExternal = false;
  /** 当前实际生效的播放端口（PeerStream 取 signal.json 的 port） */
  private activePort: number | null = null;
  /** 信令服务自动重启计数（防止无限重启） */
  private sigAutoRestarts = 0;
  /** execue 自动重启计数 */
  private execueAutoRestarts = 0;
  /** 记住内置服务器目录（自动恢复时用） */
  private lastSourceDir: string | null = null;
  /** 透明化收窗的周期兜底节流计数 */
  private concealTick = 0;

  // ---------- 停止 ----------

  /**
   * 停止指定项目（不传 projectId = 停止全部）。
   * 停止单个项目：关掉它在 signal.json 里的预热标记 → 杀掉它的 UE 进程；
   * 其它项目不受影响；全部停完后才关闭共享的信令/代理服务。
   */
  async stop(projectId?: string): Promise<void> {
    if (projectId) {
      const run = this.runs.get(projectId);
      if (!run) return;
      this.log('tool', `正在停止「${run.name}」…`);
      // 先关预热标记：否则信令服务检测到实例消失后会自动把它再拉起来
      this.setProjectPreload(run.peerId, false);
      const s = this.lastSettings;
      if (s) await this.killLeftoverUe(run.project, { ...s, keepLeftoverUe: false });
      this.runs.delete(projectId);
      this.peerToStore.delete(run.peerId);
      this.emitRuns();
      if (this.runs.size === 0) await this.stopAll();
      else this.log('tool', `「${run.name}」已停止（其余项目继续运行）`);
      return;
    }
    await this.stopAll();
  }

  async stopAll(): Promise<void> {
    this.stopping = true;
    this.concealTick = 0;
    this.stopHealth();
    this.stopUeLogWatch();

    // 关闭所有项目的预热标记，避免共享服务重启后又把它们拉起来
    for (const run of this.runs.values()) this.setProjectPreload(run.peerId, false);
    this.runs.clear();
    this.peerToStore.clear();
    this.killShared();

    this.patch({ ...IDLE_STATUS, message: '已停止' });
    this.log('tool', '已停止所有实例');
  }

  /** 关闭共享的信令服务与进程代理（execue 是 UE 的父进程，杀它连带结束所有 UE 实例） */
  private killShared(): void {
    if (this.ue) {
      this.killTree(this.ue);
      this.ue = null;
    }
    if (this.execue) {
      this.killTree(this.execue);
      this.execue = null;
    }
    if (this.sig && !this.sigExternal) {
      this.killTree(this.sig);
    }
    if (this.sigExternal) {
      this.log('tool', '保留外部信令服务（不关闭）');
    }
    this.sig = null;
    this.sigExternal = false;
    this.activePort = null;
    if (this.installer) {
      this.killTree(this.installer);
      this.installer = null;
    }
  }

  private killAll(): void {
    if (this.ue) this.killTree(this.ue);
    if (this.execue) this.killTree(this.execue);
    if (this.sig && !this.sigExternal) this.killTree(this.sig);
    if (this.installer) this.killTree(this.installer);
    this.ue = null;
    this.sig = null;
    this.execue = null;
    this.installer = null;
  }

  private killTree(child: ChildProcess): void {
    if (child.pid == null) return;
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      } else {
        child.kill('SIGTERM');
      }
    } catch (e) {
      this.log('tool', `终止进程失败: ${(e as Error).message}`);
    }
  }
}

// ---------- 工具函数 ----------

/** PeerStream signal.json 的关键字段（只用到的那些） */
interface PeerStreamProjectEntry {
  id: string;
  name?: string;
  executable?: string;
  enabled?: boolean;
  args?: string[];
  pixelStreamingPlugin?: string;
  pixelStreamingProtocol?: string;
  metadata?: { ueVersion?: string; [k: string]: unknown };
  [k: string]: unknown;
}

interface PeerStreamConfig {
  port?: number;
  auth?: { engineToken?: string; playerToken?: string; viewerToken?: string };
  projects?: PeerStreamProjectEntry[];
  session?: Record<string, unknown>;
  iceServers?: unknown[];
  [k: string]: unknown;
}

interface PeerStreamExecueConfig {
  allowedProjects?: Array<{ id: string; executable: string }>;
  [k: string]: unknown;
}

/**
 * 从打包产物反推引擎版本与像素流插件类型（决定信令 URL 参数名与握手协议）：
 * 1. 读上级目录的 <项目>.uproject：EngineAssociation = 引擎版本，Plugins = 插件
 * 2. 兜底：打包内 Samples 目录（PixelStreaming2 / PixelStreaming）
 */
function parseUeVersion(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const match = String(value).match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return undefined;
  return `${match[1]}.${match[2]}${match[3] ? `.${match[3]}` : ''}`;
}

function parentDirs(start: string, maxDepth = 6): string[] {
  const dirs: string[] = [];
  let current = start;
  for (let i = 0; i < maxDepth; i++) {
    dirs.push(current);
    const next = dirname(current);
    if (!next || next === current) break;
    current = next;
  }
  return dirs;
}

function readPackageJsonMeta(file: string): { ueVersion?: string; plugin?: 'PixelStreaming' | 'PixelStreaming2' } | null {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8')) as {
      EngineAssociation?: string;
      Plugins?: Array<{ Name?: string; Enabled?: boolean }>;
      MajorVersion?: number;
      MinorVersion?: number;
      PatchVersion?: number;
      BuildVersion?: string;
      VersionName?: string;
    };
    const out: { ueVersion?: string; plugin?: 'PixelStreaming' | 'PixelStreaming2' } = {};
    out.ueVersion =
      parseUeVersion(j.EngineAssociation) ??
      parseUeVersion(j.BuildVersion) ??
      parseUeVersion(j.VersionName) ??
      (Number.isInteger(j.MajorVersion) && Number.isInteger(j.MinorVersion)
        ? `${j.MajorVersion}.${j.MinorVersion}${Number.isInteger(j.PatchVersion) ? `.${j.PatchVersion}` : ''}`
        : undefined);
    const enabled = (j.Plugins ?? []).filter((p) => p?.Enabled !== false).map((p) => p?.Name);
    if (enabled.includes('PixelStreaming2')) out.plugin = 'PixelStreaming2';
    else if (enabled.includes('PixelStreaming')) out.plugin = 'PixelStreaming';
    return out.ueVersion || out.plugin ? out : null;
  } catch {
    return null;
  }
}

function findJsonMetaNearExecutable(exePath: string): { ueVersion?: string; plugin?: 'PixelStreaming' | 'PixelStreaming2' } {
  const exeDir = dirname(exePath);
  const exeName = basename(exePath).replace(/\.exe$/i, '');
  const out: { ueVersion?: string; plugin?: 'PixelStreaming' | 'PixelStreaming2' } = {};
  for (const dir of parentDirs(exeDir)) {
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    const preferred = entries.filter((name) => name.toLowerCase() === `${exeName.toLowerCase()}.uproject`);
    const candidates = [
      ...preferred,
      ...entries.filter((name) => /\.(uproject|target)$/i.test(name)),
      ...entries.filter((name) => /^Build\.version$/i.test(name)),
    ];
    for (const name of candidates) {
      const meta = readPackageJsonMeta(join(dir, name));
      if (!meta) continue;
      out.ueVersion ??= meta.ueVersion;
      out.plugin ??= meta.plugin;
      if (out.ueVersion && out.plugin) return out;
    }
  }
  return out;
}

function findPackagedStreamingPlugin(exePath: string): 'PixelStreaming' | 'PixelStreaming2' | undefined {
  const roots = parentDirs(dirname(exePath));
  let sawLegacy = false;
  let budget = 6000;
  const visit = (dir: string, depth: number): 'PixelStreaming2' | undefined => {
    if (budget-- <= 0 || depth < 0) return undefined;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return undefined;
    }
    for (const name of entries) {
      if (/^PixelStreaming2$/i.test(name)) return 'PixelStreaming2';
      if (/^PixelStreaming$/i.test(name)) sawLegacy = true;
    }
    for (const name of entries) {
      if (['Content', 'Saved', 'Logs', 'Movies'].includes(name)) continue;
      const child = join(dir, name);
      try {
        if (statSync(child).isDirectory()) {
          const hit = visit(child, depth - 1);
          if (hit) return hit;
        }
      } catch {
        /* 忽略无权限目录 */
      }
    }
    return undefined;
  };
  for (const root of roots) {
    const hit = visit(root, 4);
    if (hit) return hit;
  }
  return sawLegacy ? 'PixelStreaming' : undefined;
}

function detectPackageMeta(exePath: string): { ueVersion?: string; plugin?: 'PixelStreaming' | 'PixelStreaming2' } {
  const exeDir = dirname(exePath);
  const name = basename(exePath).replace(/\.exe$/i, '');
  const out = findJsonMetaNearExecutable(exePath);

  if (!out.plugin) {
    const samples = [join(exeDir, name, 'Samples'), ...parentDirs(exeDir).map((dir) => join(dir, name, 'Samples'))];
    for (const sampleDir of samples) {
      if (existsSync(join(sampleDir, 'PixelStreaming2'))) {
        out.plugin = 'PixelStreaming2';
        break;
      }
      if (existsSync(join(sampleDir, 'PixelStreaming'))) out.plugin = 'PixelStreaming';
    }
  }
  if (!out.plugin) {
    const plugin = findPackagedStreamingPlugin(exePath);
    if (plugin) out.plugin = plugin;
  }
  if (!out.plugin) {
    const samples = join(exeDir, name, 'Samples');
    if (existsSync(join(samples, 'PixelStreaming2'))) out.plugin = 'PixelStreaming2';
    else if (existsSync(join(samples, 'PixelStreaming'))) out.plugin = 'PixelStreaming';
  }
  if (!out.ueVersion && out.plugin) {
    // 经典插件只存在于 UE5.3 及更早；PS2 插件在 UE5.8 仍使用通用 URL 参数。
    out.ueVersion = out.plugin === 'PixelStreaming' ? '5.3' : '5.8';
  }
  return out;
}

/**
 * UE 像素流最简必需参数（只补缺失的，不动已有参数）。
 * 完整参数模板参考 PeerStream 管理器 signal.json，包含 WebRTC 端口段、码率等。
 * 注意：不要加 -ForceRes（可能导致 UE 5.3 崩溃），不要删减已有参数。
 */
const REQUIRED_UE_ARGS = [
  '-RenderOffScreen',
  '-Unattended',
  '-AudioMixer',
  '-AllowPixelStreamingCommands',
  '-PixelStreamingWebRTCFps=30',
  '-PixelStreamingWebRTCMinPort=49160',
  '-PixelStreamingWebRTCMaxPort=49259',
  '-ResX=1920',
  '-ResY=1080',
];

/**
 * 确保 signal.json 的 projects 里登记了本项目：
 * - 已有同路径项目 → 用它的 id，并按包内信息校正插件/引擎版本
 * - 没有 → 追加一条（沿用模板参数，替换 exe），写回配置文件
 * - 两种情况都会补全缺失的 UE 启动参数
 */
function ensureProjectRegistered(
  cfg: PeerStreamConfig,
  cfgFile: string,
  project: Project,
  keepPreloadIds: Iterable<string> = [],
): { ok: boolean; projectId?: string; entry?: PeerStreamProjectEntry; notes: string[]; error?: string } {
  const notes: string[] = [];
  if (!Array.isArray(cfg.projects)) cfg.projects = [];
  const target = project.exePath.toLowerCase();
  let hit = cfg.projects.find((p) => String(p.executable ?? '').toLowerCase() === target);
  let changed = false;

  const detected = detectPackageMeta(project.exePath);

  if (!hit) {
    // 生成短 ID（PeerStream 习惯形如 PCC3476A），参数沿用现有项目作模板
    const id = `P${randomBytes(4).toString('hex').toUpperCase().slice(0, 7)}`;
    const template = cfg.projects[0];
    hit = {
      ...(template ?? {}),
      id,
      name: project.name,
      executable: project.exePath,
      execueId: 'local',
      enabled: true,
      runtimeMode: 'packaged',
      args: Array.isArray(template?.args) ? [...template.args.map(String)] : [],
      pixelStreamingPlugin: detected.plugin ?? 'PixelStreaming2',
      pixelStreamingProtocol: 'auto',
      metadata: { ...(template?.metadata ?? {}), ueVersion: detected.ueVersion ?? '5.8' },
    };
    cfg.projects.push(hit);
    changed = true;
    notes.push(`新登记项目 ${id}（${hit.pixelStreamingPlugin} / UE ${String(hit.metadata?.ueVersion)}）`);
  } else if (detected.plugin || detected.ueVersion) {
    // 只在插件类型未设置时自动填充，已有值不动（防止 .uproject 和实际打包插件不一致时改错）
    const pluginNow = String(hit.pixelStreamingPlugin ?? '');
    const versionNow = String(hit.metadata?.ueVersion ?? '');
    if (!pluginNow && detected.plugin) {
      hit.pixelStreamingPlugin = detected.plugin;
      changed = true;
      notes.push(`插件类型自动识别为 ${detected.plugin}`);
    }
    if (detected.ueVersion && detected.ueVersion !== versionNow) {
      hit.metadata = { ...(hit.metadata ?? {}), ueVersion: detected.ueVersion };
      changed = true;
      notes.push(`引擎版本由 ${versionNow || '未设置'} 校正为 ${detected.ueVersion}`);
    }
  }

  // 预热标记：当前项目打开预热；"本次会话其它正在运行的项目"保持预热；
  // 其余一律关掉——避免上次异常退出残留的 preload 让信令服务自动拉起没人要的项目。
  const keepPreload = new Set<string>([hit.id, ...keepPreloadIds]);
  for (const p of cfg.projects) {
    const shouldPreload = keepPreload.has(p.id);
    const meta = { ...(p.metadata ?? {}) };
    if ((meta.preload === true) !== shouldPreload) {
      meta.preload = shouldPreload;
      p.metadata = meta;
      changed = true;
    }
  }

  // 补全 UE 启动参数（参考 PeerStream 管理器 process-manager.js）
  let args = Array.isArray(hit.args) ? [...hit.args.map(String)] : [];

  // 5.8/PS2 不能带 -RenderOffScreen（会直接启动失败，退出码 3）：
  // 已有参数里的一律移除，补全时也跳过，避免依赖 process-manager 的启动期剥离兜底。
  const entryHeadlessUnsafe =
    hit.pixelStreamingPlugin === 'PixelStreaming2' || /^5\.(?:[89]|\d{2,})/.test(String(hit.metadata?.ueVersion ?? ''));
  if (entryHeadlessUnsafe) {
    const filtered = args.filter((a) => !/^-RenderOffScreen$/i.test(a));
    if (filtered.length !== args.length) {
      args = filtered;
      hit.args = args;
      changed = true;
      notes.push('已移除 -RenderOffScreen（UE 5.8/PS2 不支持无头启动）');
    }
  }

  const needArgs: string[] = [];
  for (const req of REQUIRED_UE_ARGS) {
    const name = req.split('=')[0];
    if (entryHeadlessUnsafe && name.toLowerCase() === '-renderoffscreen') continue;
    if (!args.some((a) => a.toLowerCase().startsWith(name.toLowerCase()))) {
      needArgs.push(req);
    }
  }
  if (needArgs.length) {
    hit.args = [...args, ...needArgs];
    changed = true;
    notes.push(`UE 参数补充：${needArgs.join(' ')}`);
  }

  if (changed) {
    try {
      writeFileSync(cfgFile, JSON.stringify(cfg, null, 2), 'utf8');
    } catch (e) {
      return { ok: false, notes, error: `写入 signal.json 失败（可能需要管理员权限）：${(e as Error).message}` };
    }
  }
  return { ok: true, projectId: hit.id, entry: hit, notes };
}

/**
 * 确保 execue.json 的 allowedProjects 含本项目：
 * execue 只允许启动白名单内的 exe，缺登记会导致实例启动被拒。
 */
function ensureExecueAllowed(cfgFile: string, projectId: string, exePath: string): { ok: boolean; error?: string } {
  let cfg: PeerStreamExecueConfig;
  try {
    cfg = JSON.parse(readFileSync(cfgFile, 'utf8')) as PeerStreamExecueConfig;
  } catch (e) {
    return { ok: false, error: `读取 execue.json 失败：${cfgFile}（${(e as Error).message}）` };
  }
  if (!Array.isArray(cfg.allowedProjects)) cfg.allowedProjects = [];
  const hit = cfg.allowedProjects.find((x) => x.id === projectId);
  if (hit) {
    if (String(hit.executable ?? '').toLowerCase() !== exePath.toLowerCase()) {
      hit.executable = exePath;
      try {
        writeFileSync(cfgFile, JSON.stringify(cfg, null, 2), 'utf8');
      } catch (e) {
        return { ok: false, error: `写入 execue.json 失败：${(e as Error).message}` };
      }
    }
    return { ok: true };
  }
  cfg.allowedProjects.push({ id: projectId, executable: exePath });
  try {
    writeFileSync(cfgFile, JSON.stringify(cfg, null, 2), 'utf8');
  } catch (e) {
    return { ok: false, error: `写入 execue.json 失败：${(e as Error).message}` };
  }
  return { ok: true };
}

function tcpProbe(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (!settled) {
        settled = true;
        resolve(ok);
      }
    };
    try {
      const sock = net.connect({ port, host: '127.0.0.1', timeout: 700 });
      sock.on('connect', () => {
        sock.end();
        done(true);
      });
      sock.on('error', () => {
        sock.destroy();
        done(false);
      });
      sock.on('timeout', () => {
        sock.destroy();
        done(false);
      });
    } catch {
      done(false);
    }
  });
}

function lanIp(): string | null {
  const ifs = os.networkInterfaces();
  const preferred: string[] = [];
  const others: string[] = [];
  for (const list of Object.values(ifs)) {
    for (const ni of list ?? []) {
      if (ni.family !== 'IPv4' || ni.internal) continue;
      if (ni.address.startsWith('192.168.') || ni.address.startsWith('10.')) preferred.push(ni.address);
      else others.push(ni.address);
    }
  }
  return preferred[0] ?? others[0] ?? null;
}

/** 简单的命令行分词：支持双引号 */
function tokenize(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

function sanitize(name: string): string {
  return name.replace(/[^\w\-一-龥]/g, '_').slice(0, 60);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 轮询等待条件成立 */
async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs: number, intervalMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await pred()) return true;
    } catch {
      /* 忽略瞬时错误，继续重试 */
    }
    if (Date.now() >= deadline) return false;
    await sleep(intervalMs);
  }
}

/**
 * 预热会话策略：
 * - mode=shared：所有观看者（本机 + 局域网 + 手机）**共用一个 UE 实例**，
 *   避免每来一个人就新起一个实例（既慢又吃显存）
 * - lastPlayerExitPolicy=idle + 空闲窗口：最后一个人离开后实例继续存活，下次秒连
 */
function ensureWarmSessionPolicy(cfg: PeerStreamConfig, cfgFile: string): { changed: boolean; detail: string } {
  const session = { ...((cfg.session as Record<string, unknown>) ?? {}) };
  const before = `${String(session.mode ?? 'one2one')}/${String(session.lastPlayerExitPolicy ?? 'grace')}/${String(session.idleInstanceSeconds ?? 120)}`;
  let changed = false;

  if (session.mode !== 'shared') {
    session.mode = 'shared';
    changed = true;
  }
  const shared = Number(session.maxSharedPlayers);
  if (!Number.isFinite(shared) || shared < 10) {
    session.maxSharedPlayers = 10;
    changed = true;
  }
  if (session.lastPlayerExitPolicy !== 'idle') {
    session.lastPlayerExitPolicy = 'idle';
    changed = true;
  }
  const idle = Number(session.idleInstanceSeconds);
  if (!Number.isFinite(idle) || idle < 1800) {
    session.idleInstanceSeconds = 1800;
    changed = true;
  }
  if (!changed) return { changed: false, detail: before };
  cfg.session = session;
  try {
    writeFileSync(cfgFile, JSON.stringify(cfg, null, 2), 'utf8');
  } catch {
    return { changed: false, detail: '写入失败' };
  }
  return { changed: true, detail: `${before} → shared/10/idle/${String(session.idleInstanceSeconds)}` };
}

/**
 * 局域网模式：把 signal.json 的 iceServers 清空。
 * 局域网内浏览器与 UE 在同一网段，host 候选即可直连；保留外网 STUN 时，
 * 若 STUN 不可达（常见于内网/无外网），ICE 收集要等超时，表现为"打开很慢"。
 */
function ensureLanIce(cfg: PeerStreamConfig, cfgFile: string): { changed: boolean; detail: string } {
  const cur = cfg.iceServers;
  const alreadyEmpty = Array.isArray(cur) && cur.length === 0;
  if (alreadyEmpty) return { changed: false, detail: '已是空配置' };
  const count = Array.isArray(cur) ? cur.length : 0;
  cfg.iceServers = [];
  try {
    writeFileSync(cfgFile, JSON.stringify(cfg, null, 2), 'utf8');
  } catch {
    return { changed: false, detail: '写入失败' };
  }
  return { changed: true, detail: `移除 ${count} 组 STUN/TURN` };
}

/** 读取信令服务的 /health（失败返回 null） */
function httpJson(port: number, path: string): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    try {
      const req = http.get({ host: '127.0.0.1', port, path, timeout: 1500 }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body) as Record<string, unknown>);
          } catch {
            resolve(null);
          }
        });
      });
      req.on('timeout', () => {
        req.destroy();
        resolve(null);
      });
      req.on('error', () => resolve(null));
    } catch {
      resolve(null);
    }
  });
}
