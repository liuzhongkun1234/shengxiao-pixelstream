// 渲染进程逻辑（多项目并发：主区列出所有运行中的项目，各自独立操作）
import type { LogLine, Project, ProjectRun, Settings, Status, SystemMetrics } from '../shared/types';
import { DEFAULT_SETTINGS, IDLE_STATUS } from '../shared/types';

const api = window.api;

let projects: Project[] = [];
let activeId: string | null = null;
let status: Status = { ...IDLE_STATUS };
let settings: Settings = { ...DEFAULT_SETTINGS };

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector(sel) as T;
const btn = (sel: string): HTMLButtonElement => $(sel);
const inp = (sel: string): HTMLInputElement & HTMLSelectElement => $(sel) as HTMLInputElement & HTMLSelectElement;

// ---------- 初始化 ----------

async function init(): Promise<void> {
  projects = await api.listProjects();
  status = await api.getStatus();
  settings = await api.getSettings();
  if (projects.length) activeId = projects[0].id;

  const logs = await api.getLogs();
  logs.forEach(appendLog);

  api.onStatus((s) => {
    status = s;
    if (s.activeProjectId && !projects.some((p) => p.id === activeId)) activeId = s.activeProjectId;
    renderStatus();
  });
  api.onLog(appendLog);
  api.onMetrics(renderMetrics);
  window.onProjectsChanged((list) => {
    projects = list;
    if (!projects.find((p) => p.id === activeId)) activeId = projects[0]?.id ?? null;
    renderAll();
  });

  bindEvents();
  renderAll();
}

function renderAll(): void {
  renderProjects();
  renderStatus();
}

// ---------- 侧栏项目列表 ----------

let lastProjectsKey = '';

function renderProjects(): void {
  // 渲染缓存：内容没变就不重建 DOM（状态广播很频繁，避免无谓重排造成卡顿）
  const key = JSON.stringify([activeId, projects.map((p) => p.id), status.runs.map((r) => `${r.projectId}:${r.state}`)]);
  if (key === lastProjectsKey) return;
  lastProjectsKey = key;
  const ul = $('#project-list');
  ul.innerHTML = '';
  if (!projects.length) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.style.cssText = 'padding:12px;text-align:center;font-size:13px;';
    li.textContent = '还没有项目，点上方「＋ 添加项目」选择打包好的程序';
    ul.appendChild(li);
    return;
  }
  for (const p of projects) {
    const run = status.runs.find((r) => r.projectId === p.id);
    const li = document.createElement('li');
    li.className = 'project-item' + (p.id === activeId ? ' active' : '') + (run ? ` ${run.state}` : '');
    li.innerHTML = `
      <span class="run-dot"></span>
      <span class="name"></span>
      <span class="meta"></span>
      <span class="badge ${p.engine}">${engineLabel(p.engine)}</span>
      <button class="del" title="移除项目">✕</button>`;
    (li.querySelector('.name') as HTMLElement).textContent = p.name;
    (li.querySelector('.meta') as HTMLElement).textContent = p.exePath;
    const dot = li.querySelector('.run-dot') as HTMLElement;
    dot.title = run ? (run.state === 'running' ? '运行中' : '启动中') : '未运行';
    li.addEventListener('click', () => {
      activeId = p.id;
      renderAll();
    });
    li.querySelector('.del')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`移除项目「${p.name}」？（不会删除磁盘文件）`)) return;
      projects = await api.removeProject(p.id);
      if (activeId === p.id) activeId = projects[0]?.id ?? null;
      renderAll();
    });
    ul.appendChild(li);
  }
}

function engineLabel(e: Project['engine']): string {
  return e === 'ue' ? 'UE' : e === 'unity' ? 'Unity' : '未知引擎';
}

// ---------- 主区：运行中的项目 ----------

function renderStatus(): void {
  renderRuns();
  renderProjects();

  const selectedRun = status.runs.find((r) => r.projectId === activeId);
  const start = btn('#btn-start');
  start.disabled = !activeId || Boolean(selectedRun);
  start.textContent = selectedRun ? '▶ 已在运行' : '▶ 启动';
  btn('#btn-stop-all').disabled = status.runs.length === 0;
  $('#status-msg').textContent = status.message || '';
}

let lastRunsKey = '';

function renderRuns(): void {
  const key = JSON.stringify(status.runs);
  if (key === lastRunsKey) return;
  lastRunsKey = key;
  const list = $('#runs-list');
  list.innerHTML = '';
  $('#runs-title').textContent = `运行中的项目${status.runs.length ? `（${status.runs.length}）` : ''}`;
  if (!status.runs.length) {
    const empty = document.createElement('div');
    empty.className = 'runs-empty';
    empty.textContent = projects.length
      ? '没有正在运行的项目 —— 在左侧选中项目后点「▶ 启动」'
      : '还没有项目 —— 先点左侧「＋ 添加项目」';
    list.appendChild(empty);
    return;
  }
  for (const r of status.runs) list.appendChild(runRow(r));
}

function runRow(r: ProjectRun): HTMLElement {
  const row = document.createElement('div');
  row.className = `run-row ${r.state}`;

  const dot = document.createElement('span');
  dot.className = 'dot';

  const main = document.createElement('div');
  main.className = 'run-main';
  const name = document.createElement('div');
  name.className = 'run-name';
  name.textContent = r.name;
  const state = document.createElement('div');
  state.className = 'run-state';
  if (r.state === 'running') {
    state.textContent = r.streamerConnected ? '运行中 · 推流已连接，浏览器可访问' : '运行中 · 等待推流接入';
  } else {
    state.textContent = `${r.message || '启动中…'}${r.progress ? `（${r.progress}%）` : ''}`;
  }
  main.append(name, state);
  if (r.state === 'starting') {
    const bar = document.createElement('div');
    bar.className = 'run-bar';
    const fill = document.createElement('div');
    fill.style.width = `${Math.max(0, Math.min(100, r.progress))}%`;
    bar.appendChild(fill);
    main.appendChild(bar);
  }

  const actions = document.createElement('div');
  actions.className = 'run-actions';
  if (r.state === 'running' && r.localUrl) {
    const control = r.localUrl;
    const viewer = r.viewerLocalUrl ?? r.localUrl;
    actions.appendChild(miniBtn('▶ 控制端', 'primary', () => void api.openUrl(control)));
    actions.appendChild(miniBtn('👁 观看端', 'viewer', () => void api.openUrl(viewer)));
    actions.appendChild(miniBtn('复制本机', '', (el) => copyText(control, el, '复制本机')));
    if (r.lanUrl) actions.appendChild(miniBtn('复制局域网', '', (el) => copyText(r.lanUrl!, el, '复制局域网')));
    if (r.lanUrl) actions.appendChild(miniBtn('🌐 局域网控制', '', () => void api.openUrl(r.lanUrl!)));
  }
  actions.appendChild(
    miniBtn('■ 停止', 'danger', async () => {
      await api.stop(r.projectId);
      renderStatus();
    }),
  );

  row.append(dot, main, actions);
  return row;
}

function miniBtn(label: string, cls: string, onClick: (el: HTMLButtonElement) => void | Promise<void>): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = `mini-btn ${cls}`;
  b.textContent = label;
  b.addEventListener('click', () => void onClick(b));
  return b;
}

function copyText(text: string, el: HTMLButtonElement, original: string): void {
  void navigator.clipboard.writeText(text).then(() => {
    el.textContent = '✓ 已复制';
    setTimeout(() => (el.textContent = original), 1200);
  });
}

// ---------- 电脑状态（CPU / 内存 / 显存） ----------

function renderMetrics(m: SystemMetrics): void {
  setSysBar('cpu', m.cpuPercent, `${m.cpuPercent}%`);
  const memPct = m.memTotalGB > 0 ? (m.memUsedGB / m.memTotalGB) * 100 : 0;
  setSysBar('mem', memPct, `${m.memUsedGB}/${m.memTotalGB}G`);
  const gpuRow = $('#sys-gpu-row');
  if (m.gpuUsedGB != null && m.gpuTotalGB) {
    gpuRow.classList.remove('hidden');
    setSysBar('gpu', (m.gpuUsedGB / m.gpuTotalGB) * 100, `${m.gpuUsedGB}/${m.gpuTotalGB}G`);
    if (m.gpuName) gpuRow.title = m.gpuName;
  } else {
    gpuRow.classList.add('hidden');
  }
}

function setSysBar(kind: string, pct: number, text: string): void {
  const p = Math.max(0, Math.min(100, pct));
  const bar = document.getElementById(`sys-${kind}-bar`);
  const val = document.getElementById(`sys-${kind}-val`);
  if (bar) {
    bar.style.width = `${p}%`;
    bar.className = p >= 90 ? 'hot' : p >= 70 ? 'warn' : '';
  }
  if (val) val.textContent = text;
}

// ---------- 日志 ----------

const logQueue: LogLine[] = [];
let logRaf = 0;

function appendLog(l: LogLine): void {
  logQueue.push(l);
  if (!logRaf) logRaf = requestAnimationFrame(flushLogQueue);
}

/** 批量渲染（一帧一次），避免 UE 日志刷屏时每行一次重排导致界面卡顿 */
function flushLogQueue(): void {
  logRaf = 0;
  if (!logQueue.length) return;
  const view = $('#log-view');
  const atBottom = view.scrollTop + view.clientHeight >= view.scrollHeight - 40;
  const frag = document.createDocumentFragment();
  for (const l of logQueue.splice(0, logQueue.length)) {
    const div = document.createElement('div');
    div.className = `log-line ${l.source}`;
    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = new Date(l.ts).toLocaleTimeString('zh-CN', { hour12: false });
    div.appendChild(time);
    div.appendChild(document.createTextNode(l.text));
    frag.appendChild(div);
  }
  view.appendChild(frag);
  while (view.childElementCount > 600) view.removeChild(view.firstChild!);
  if (atBottom) view.scrollTop = view.scrollHeight;
}

// ---------- 事件 ----------

function bindEvents(): void {
  $('#btn-add').addEventListener('click', async () => {
    const p = await api.addProject();
    if (p) {
      projects = await api.listProjects();
      activeId = p.id;
      renderAll();
      if (p.engine === 'unknown') {
        $('#status-msg').textContent = '提示：未能自动识别引擎类型，将按 UE 方式启动';
      }
    }
  });

  $('#btn-start').addEventListener('click', async () => {
    if (!activeId) return;
    btn('#btn-start').disabled = true;
    const r = await api.start(activeId);
    if (!r.ok && r.error) {
      $('#status-msg').textContent = r.error;
      $('#log-view').appendChild(Object.assign(document.createElement('div'), { className: 'log-line err', textContent: `启动失败: ${r.error}` }));
    }
    renderStatus();
  });

  $('#btn-stop-all').addEventListener('click', async () => {
    if (!confirm('停止所有正在运行的项目？')) return;
    btn('#btn-stop-all').disabled = true;
    await api.stopAll();
    renderStatus();
  });

  $('#btn-clear-log').addEventListener('click', () => {
    $('#log-view').innerHTML = '';
  });

  // ---- 设置弹窗 ----
  const mask = $('#modal-mask');
  $('#btn-settings').addEventListener('click', () => {
    void api.getSettings().then((s) => {
      settings = s;
      inp('#set-mode').value = s.serverMode;
      inp('#set-psdir').value = s.peerStreamDir;
      inp('#set-sigdir').value = s.signalingDir;
      inp('#set-httpport').value = String(s.httpPort);
      inp('#set-streamport').value = String(s.streamerPort);
      inp('#set-offscreen').checked = s.renderOffscreen;
      inp('#set-lanmode').checked = s.lanMode;
      inp('#set-autostart').checked = s.autoStart;
      inp('#set-silentue').checked = s.silentUeStart;
      inp('#set-autolaunch').checked = s.startWithWindows;
      inp('#set-ueargs').value = s.ueExtraArgs;
      inp('#set-sigargs').value = s.signalingExtraArgs;
      mask.classList.remove('hidden');
    });
  });

  $('#btn-pick-dir').addEventListener('click', async () => {
    const dir = await api.pickDir();
    if (dir) inp('#set-sigdir').value = dir;
  });

  $('#btn-pick-psdir').addEventListener('click', async () => {
    const dir = await api.pickDir();
    if (dir) inp('#set-psdir').value = dir;
  });

  $('#btn-settings-close').addEventListener('click', () => mask.classList.add('hidden'));

  // 一键放通防火墙（会弹 UAC 授权）
  $('#btn-firewall').addEventListener('click', async () => {
    const el = btn('#btn-firewall');
    el.disabled = true;
    el.textContent = '正在处理…';
    const r = await api.ensureFirewall();
    el.disabled = false;
    el.textContent = '放通防火墙（局域网）';
    $('#status-msg').textContent = r.message;
  });

  // 清除缓存：停止服务 + 清理遗留进程 + 重置内置服务配置
  $('#btn-clear-cache').addEventListener('click', async () => {
    if (!confirm('清除缓存会停止所有服务，并重置内置服务配置（清空项目登记、token、实例注册表等历史状态，下次启动按当前项目重新登记）。确定继续？')) return;
    const el = btn('#btn-clear-cache');
    el.disabled = true;
    el.textContent = '正在清除…';
    const r = await api.clearCache();
    el.disabled = false;
    el.textContent = '清除缓存';
    mask.classList.add('hidden');
    $('#status-msg').textContent = r.message;
  });

  $('#btn-settings-save').addEventListener('click', async () => {
    const mode = inp('#set-mode').value;
    const patch: Partial<Settings> = {
      serverMode: (mode === 'peerstream' || mode === 'epic' ? mode : 'auto') as Settings['serverMode'],
      peerStreamDir: inp('#set-psdir').value.trim(),
      signalingDir: inp('#set-sigdir').value.trim(),
      httpPort: clampPort(inp('#set-httpport').value, 80),
      streamerPort: clampPort(inp('#set-streamport').value, 8888),
      renderOffscreen: inp('#set-offscreen').checked,
      lanMode: inp('#set-lanmode').checked,
      autoStart: inp('#set-autostart').checked,
      silentUeStart: inp('#set-silentue').checked,
      startWithWindows: inp('#set-autolaunch').checked,
      ueExtraArgs: inp('#set-ueargs').value.trim(),
      signalingExtraArgs: inp('#set-sigargs').value.trim(),
    };
    settings = await api.setSettings(patch);
    // 开机自启交给系统注册表处理
    const wantAuto = patch.startWithWindows === true;
    const r = await api.setAutoLaunch(wantAuto);
    mask.classList.add('hidden');
    $('#status-msg').textContent = r.ok ? '设置已保存' : r.message;
  });

  mask.addEventListener('click', (e) => {
    if (e.target === mask) mask.classList.add('hidden');
  });
}

function clampPort(v: string, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1 || n > 65535) return fallback;
  return Math.floor(n);
}

void init();
