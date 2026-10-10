// Electron 主进程入口
import { boot } from './bootlog';
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, Tray } from 'electron';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Project, Settings } from '../shared/types';
import { Store } from './store';
import { Orchestrator } from './orchestrator';
import { ensureServerHome, installPlayerPage, resetServerHome } from './serverHome';
import { collectMetrics } from './metrics';
import { TRAY_ICON_PNG_BASE64 } from './trayIcon';

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
/** 真的退出（区分"关窗口隐藏到托盘"） */
let quitting = false;
let store: Store;
let orch: Orchestrator;

function showWindow(): void {
  if (!win) {
    createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createTray(): void {
  if (tray) return;
  try {
    const icon = nativeImage.createFromDataURL(`data:image/png;base64,${TRAY_ICON_PNG_BASE64}`);
    tray = new Tray(icon.resize({ width: 16, height: 16 }));
    tray.setToolTip('圣效像素流');
    const rebuild = (): void => {
      const s = orch.getStatus();
      const running = s.signaling !== 'stopped' || s.ue !== 'stopped';
      tray?.setContextMenu(
        Menu.buildFromTemplate([
          { label: '打开主界面', click: () => showWindow() },
          {
            label: running ? `播放页（${s.message || '运行中'}）` : '播放页（未启动）',
            enabled: Boolean(s.localUrl),
            click: () => s.localUrl && void shell.openExternal(s.localUrl),
          },
          { type: 'separator' },
          { label: '停止服务', enabled: running, click: () => void orch.stop().then(() => send('status:changed', orch.getStatus())) },
          {
            label: '退出程序',
            click: () => {
              quitting = true;
              void orch.stop().then(() => app.quit());
            },
          },
        ]),
      );
    };
    rebuild();
    orch.on('status', rebuild);
    tray.on('double-click', () => showWindow());
  } catch (e) {
    boot(`tray failed: ${(e as Error).message}`);
  }
}

function createWindow(show = true): void {
  win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 940,
    minHeight: 620,
    // 浅色玻璃主题：窗口用系统亚克力（Windows 11 毛玻璃）材质，页面叠半透明白纱。
    // 系统不支持时自动退化为普通浅色窗口。
    backgroundColor: '#00FFFFFF',
    backgroundMaterial: 'acrylic',
    title: '圣效像素流',
    show,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(join(__dirname, '../renderer/index.html'));
  // 菜单已移除；保留 F12 打开开发者工具，方便现场排查问题
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win?.webContents.toggleDevTools();
  });
  // 推流运行时关窗口 = 最小化到托盘（不中断后台推流）；未运行时正常退出
  win.on('close', (e) => {
    const running = orch && (orch.getStatus().signaling !== 'stopped' || orch.getStatus().ue !== 'stopped');
    if (!quitting && running) {
      e.preventDefault();
      win?.hide();
      boot('window hidden to tray (stream still running)');
    }
  });
  win.on('closed', () => {
    win = null;
  });
}

function send(channel: string, payload: unknown): void {
  win?.webContents.send(channel, payload);
}

function registerIpc(): void {
  // ---- 项目 ----
  ipcMain.handle('projects:list', () => store.listProjects());

  ipcMain.handle('projects:add', async () => {
    const r = await dialog.showOpenDialog(win!, {
      title: '选择打包好的 UE 主程序 (exe)',
      filters: [{ name: '可执行文件', extensions: ['exe'] }],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const project = store.addProject(r.filePaths[0]);
    send('projects:changed', store.listProjects());
    return project;
  });

  ipcMain.handle('projects:remove', (_e, id: string) => {
    if (orch.getStatus().activeProjectId === id) {
      void orch.stop();
    }
    return store.removeProject(id);
  });

  ipcMain.handle('projects:update', (_e, id: string, patch: Partial<Project>) => store.updateProject(id, patch));

  // ---- 设置 ----
  ipcMain.handle('settings:get', () => store.getSettings());
  ipcMain.handle('settings:set', (_e, patch: Partial<Settings>) => store.setSettings(patch));

  ipcMain.handle('settings:pickDir', async () => {
    const r = await dialog.showOpenDialog(win!, {
      title: '选择 SignallingWebServer 目录',
      properties: ['openDirectory'],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    return r.filePaths[0];
  });

  // ---- 运行 ----
  ipcMain.handle('run:start', async (_e, projectId: string) => {
    const project = store.getProject(projectId);
    if (!project) return { ok: false, error: '项目不存在' };
    store.setLastProjectId(projectId);
    const result = await orch.start(project, store.getSettings());
    send('status:changed', orch.getStatus());
    return result;
  });

  ipcMain.handle('run:stop', async (_e, projectId: string) => {
    await orch.stop(projectId);
    send('status:changed', orch.getStatus());
  });

  ipcMain.handle('run:stopAll', async () => {
    await orch.stopAll();
    send('status:changed', orch.getStatus());
  });

  ipcMain.handle('status:get', () => orch.getStatus());
  ipcMain.handle('logs:get', () => orch.getLogs());

  // 主界面显示/隐藏（静默启动后可从托盘或这里打开）
  ipcMain.handle('window:show', () => showWindow());
  // 开机自启：便携版的进程路径是临时解包目录，必须记录原始 exe
  ipcMain.handle('system:setAutoLaunch', (_e, enabled: boolean) => {
    const exePath = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
    try {
      app.setLoginItemSettings({ openAtLogin: Boolean(enabled), path: exePath, args: ['--silent'] });
      return { ok: true, message: enabled ? `已设置开机自启：${exePath}` : '已取消开机自启' };
    } catch (e) {
      return { ok: false, message: `设置失败：${(e as Error).message}` };
    }
  });

  // ---- 杂项 ----
  ipcMain.handle('shell:open', (_e, url: string) => {
    // 只允许打开 http(s)，防止任意协议调用
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
  });

  // 一键放通防火墙：局域网设备要能访问信令端口与 WebRTC 端口
  ipcMain.handle('system:firewall', async () => {
    const ruleName = 'ShengXiaoPixelStream';
    const ruleVideo = 'ShengXiaoPixelStreamVideo';
    const inner = [
      `netsh advfirewall firewall delete rule name="${ruleName}" >nul 2>&1`,
      `netsh advfirewall firewall delete rule name="${ruleVideo}" >nul 2>&1`,
      `netsh advfirewall firewall add rule name="${ruleName}" dir=in action=allow protocol=TCP localport=12188`,
      `netsh advfirewall firewall add rule name="${ruleVideo}" dir=in action=allow protocol=UDP localport=49160-49259`,
    ].join(' & ');
    return await new Promise<{ ok: boolean; message: string }>((resolve) => {
      try {
        // 需要管理员权限：弹 UAC，用户确认后执行
        const child = spawn(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', `Start-Process -FilePath cmd.exe -ArgumentList '/c ${inner}' -Verb RunAs -Wait -WindowStyle Hidden`],
          { windowsHide: true },
        );
        child.on('error', (e) => resolve({ ok: false, message: `调用失败：${e.message}` }));
        child.on('exit', (code) =>
          resolve(
            code === 0
              ? { ok: true, message: '防火墙规则已添加（TCP 12188 / UDP 49160-49259）' }
              : { ok: false, message: `未完成（退出码 ${code}）：可能取消了 UAC 授权，或以非管理员身份运行` },
          ),
        );
      } catch (e) {
        resolve({ ok: false, message: `调用异常：${(e as Error).message}` });
      }
    });
  });

  // 清除缓存：停止服务、清理遗留进程、重置内置服务配置（清空累积的项目登记/注册表）
  ipcMain.handle('system:clear-cache', async () => {
    await orch.stop();
    let port = 12188;
    try {
      const sig = JSON.parse(readFileSync(join(app.getPath('userData'), 'server', 'config', 'signal.json'), 'utf8')) as { port?: number };
      if (Number.isInteger(sig.port) && (sig.port as number) > 0) port = sig.port as number;
    } catch {
      /* 用默认端口 */
    }
    await orch.killLeftoverServer(port);
    for (const p of store.listProjects()) await orch.killLeftoverUe(p, store.getSettings());
    const home = resetServerHome();
    const ok = Boolean(home);
    send('status:changed', orch.getStatus());
    return {
      ok,
      message: ok
        ? '已清除缓存并重置内置服务，下次启动会按所选项目重新登记'
        : '已清除缓存，但内置服务重建失败，请重启程序后重试',
    };
  });
}

// 单实例锁：避免重复启动导致端口冲突
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showWindow();
  });

  void app.whenReady().then(() => {
    // 移除默认应用菜单（File / Edit / View / Window / Help）——交付工具用不到
    Menu.setApplicationMenu(null);
    boot('app ready');
    store = new Store(app.getPath('userData'));
    boot(`store ready, userData=${app.getPath('userData')}`);
    orch = new Orchestrator();
    orch.on('status', (s) => send('status:changed', s));
    orch.on('log', (l) => send('log:new', l));
    registerIpc();
    // 启动器正常显示窗口（不隐藏）
    createWindow(true);
    createTray();
    boot('window + tray created');

    // 电脑状态（CPU / 内存 / 显存）每 3 秒采集并推送到界面（异步，不阻塞）
    setInterval(() => {
      void collectMetrics()
        .then((m) => send('metrics:changed', m))
        .catch(() => {});
    }, 3000);

    // 首次运行预热：把内置服务器解包到可写目录，并部署播放页（首次点「启动」就更快）
    setTimeout(() => {
      try {
        const dir = ensureServerHome();
        if (dir) installPlayerPage(dir);
      } catch {
        /* 预热失败不影响正常使用，点启动时会重试 */
      }
    }, 500);

    // 自动后台启动：打开程序即拉起上次的项目，用户打开浏览器时画面已经准备好
    setTimeout(() => {
      try {
        const settings = store.getSettings();
        const lastId = store.getLastProjectId();
        if (!settings.autoStart) {
          boot('autoStart disabled');
          return;
        }
        if (!lastId) {
          boot('autoStart skipped: no last project');
          return;
        }
        const project = store.getProject(lastId);
        if (!project) return;
        if (orch.getStatus().activeProjectId) {
          boot('autoStart skipped: already running');
          return;
        }
        boot(`autoStart project=${project.name}`);
        void orch.start(project, settings).then((r) => {
          if (!r.ok && r.error) boot(`autoStart failed: ${r.error}`);
        });
      } catch (e) {
        boot(`autoStart error: ${(e as Error).message}`);
      }
    }, 2000);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  // 关窗口时：若在推流则隐藏到托盘（静默后台继续跑）；否则退出
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    void orch?.stop();
  });
}
