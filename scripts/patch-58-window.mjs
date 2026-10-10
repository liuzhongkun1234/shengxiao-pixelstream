import fs from 'fs';

function patchPm(path) {
  let s = fs.readFileSync(path, 'utf8');
  // Strip headless flags for PixelStreaming2 / UE 5.8+ — they break PS2 startup.
  const needle = '    applySignallingUrlArgument(args, engineUrl.toString(), request.ueVersion, request.engineAuthTicket, request.pixelStreamingProtocol, request.pixelStreamingPlugin);';
  const insert = `    applySignallingUrlArgument(args, engineUrl.toString(), request.ueVersion, request.engineAuthTicket, request.pixelStreamingProtocol, request.pixelStreamingPlugin);
    // UE 5.8 PixelStreaming2 does not start reliably with -RenderOffScreen / hidden windows.
    {
      const ver = String(request.ueVersion || "");
      const vm = ver.match(/^(\\d+)(?:\\.(\\d+))?/);
      const isPs2 = request.pixelStreamingPlugin === "PixelStreaming2" || String(request.pixelStreamingProtocol).toLowerCase() === "unified";
      const is58 = Number(vm?.[1] || 0) > 5 || (Number(vm?.[1] || 0) === 5 && Number(vm?.[2] || 0) >= 8);
      if (isPs2 || is58) {
        for (let i = args.length - 1; i >= 0; i--) {
          if (/^-RenderOffScreen$/i.test(String(args[i])) || /^-RenderOffscreen$/i.test(String(args[i]))) args.splice(i, 1);
        }
      }
    }`;
  if (s.includes('UE 5.8 PixelStreaming2 does not start reliably')) console.log('pm already', path);
  else if (s.includes(needle)) {
    s = s.replace(needle, insert);
    fs.writeFileSync(path, s);
    console.log('pm', path);
  } else console.log('pm needle missing', path);

  // Do not hide the OS window of the UE process for PS2
  s = fs.readFileSync(path, 'utf8');
  const spawnOld = 'const child = this.operations.spawn(executable, args, { cwd: path.dirname(executable), windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: childEnv });';
  const spawnNew = 'const hideOsWindow = !(request.pixelStreamingPlugin === "PixelStreaming2" || String(request.pixelStreamingProtocol).toLowerCase() === "unified" || String(request.ueVersion || "").match(/^5\\.(?:[89]|[1-9]\\d)/));\n    const child = this.operations.spawn(executable, args, { cwd: path.dirname(executable), windowsHide: hideOsWindow, stdio: ["ignore", "pipe", "pipe"], env: childEnv });';
  if (s.includes('hideOsWindow')) console.log('spawn already', path);
  else if (s.includes(spawnOld)) {
    s = s.replace(spawnOld, spawnNew);
    fs.writeFileSync(path, s);
    console.log('spawn', path);
  } else console.log('spawn missing', path);
}

function patchOrch(path) {
  let s = fs.readFileSync(path, 'utf8');
  // 1) skip hideUeWindows after PeerStream warmup for PS2/5.8
  const hideCall = `    // PeerStream 模式下 execue 负责拉起 UE，我们同样隐藏可能弹出的窗口
    this.hideUeWindows(project.exePath);`;
  const hideCallNew = `    // PeerStream 模式下 execue 负责拉起 UE。5.8/PS2 藏窗会导致引擎起不来，跳过。
    if (!this.shouldShowUeWindow(project)) this.hideUeWindows(project.exePath);`;
  if (s.includes('shouldShowUeWindow')) console.log('orch hide already', path);
  else if (s.includes(hideCall)) {
    s = s.replace(hideCall, hideCallNew);
  } else console.log('orch hideCall missing', path);

  // 2) spawnUe: do not force RenderOffScreen for PS2/5.8
  const addOff = `    if (settings.renderOffscreen && !args.some((a) => /^-RenderOffScreen$/i.test(a))) {
      args.push('-RenderOffScreen');
    }`;
  const addOffNew = `    if (settings.renderOffscreen && !this.shouldShowUeWindow(project) && !args.some((a) => /^-RenderOffScreen$/i.test(a))) {
      args.push('-RenderOffScreen');
    }
    if (this.shouldShowUeWindow(project)) {
      for (let i = args.length - 1; i >= 0; i--) {
        if (/^-RenderOffScreen$/i.test(String(args[i]))) args.splice(i, 1);
      }
    }`;
  if (s.includes('shouldShowUeWindow(project)') && s.includes("args.splice(i, 1)")) console.log('orch off already', path);
  else if (s.includes(addOff)) {
    s = s.replace(addOff, addOffNew);
  } else console.log('orch addOff missing', path);

  // 3) helper method
  if (!s.includes('shouldShowUeWindow(project')) {
    const helper = `
  /** UE 5.8 PixelStreaming2 必须保留可见窗口，否则预热超时（-RenderOffScreen/藏窗会卡死）。 */
  private shouldShowUeWindow(project: Project): boolean {
    const anyP = project as unknown as { engine?: string; pixelStreamingPlugin?: string; metadata?: { ueVersion?: string } };
    const plugin = String(anyP.pixelStreamingPlugin ?? '');
    const ver = String(anyP.metadata?.ueVersion ?? '');
    const isPs2 = plugin === 'PixelStreaming2' || /unified/i.test(String((project as unknown as { protocol?: string }).protocol ?? ''));
    const is58 = /^5\\.(?:[89]|\\d{2,})/.test(ver) || /5\\.(?:[89]|\\d{2,})/.test(ver);
    return isPs2 || is58;
  }

  private async waitForWarmEngine`;
    s = s.replace('\n  private async waitForWarmEngine', helper);
  }

  // 4) Epic path hideUeWindows after launch
  const epicHide = `    // 5. 隐藏 UE 窗口（-RenderOffscreen 不一定生效的后备方案）
    this.hideUeWindows(project.exePath);`;
  const epicHideNew = `    // 5. 隐藏 UE 窗口（-RenderOffscreen 不一定生效的后备方案）；5.8/PS2 不藏
    if (!this.shouldShowUeWindow(project)) this.hideUeWindows(project.exePath);`;
  if (s.includes(epicHide)) s = s.replace(epicHide, epicHideNew);

  fs.writeFileSync(path, s);
  console.log('orch', path);
}

for (const p of [
  'F:/shuzhiLuanShengHouDuan/xiangShuLiu/vendor/server/src/execue/process-manager.js',
  'C:/Users/Administrator/AppData/Roaming/圣效像素流/server/src/execue/process-manager.js',
]) patchPm(p);
for (const p of [
  'F:/shuzhiLuanShengHouDuan/xiangShuLiu/src/main/orchestrator.ts',
]) patchOrch(p);

// strip RenderOffScreen from 5.8 project args in signal.json
for (const p of [
  'C:/Users/Administrator/AppData/Roaming/圣效像素流/server/config/signal.json',
  'F:/shuzhiLuanShengHouDuan/xiangShuLiu/vendor/server/config/signal.json',
]) {
  try {
    const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
    let changed = false;
    for (const proj of cfg.projects || []) {
      const is58 = String(proj?.metadata?.ueVersion || '').startsWith('5.8') || proj.pixelStreamingPlugin === 'PixelStreaming2';
      if (is58 && Array.isArray(proj.args)) {
        const next = proj.args.filter((a) => !/^-RenderOffScreen$/i.test(String(a)));
        if (next.length !== proj.args.length) { proj.args = next; changed = true; }
      }
    }
    if (changed) {
      fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n');
      console.log('signal.json', p);
    } else console.log('signal.json no change', p);
  } catch (e) { console.log('signal.json skip', p, e.message); }
}
