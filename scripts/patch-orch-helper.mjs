import fs from 'fs';
const path = 'F:/shuzhiLuanShengHouDuan/xiangShuLiu/src/main/orchestrator.ts';
let s = fs.readFileSync(path, 'utf8');
if (s.includes('private shouldShowUeWindow')) {
  console.log('already has helper');
} else {
  const anchor = '  private async waitForWarmEngine';
  const helper = `  /** UE 5.8 PixelStreaming2 必须保留可见窗口，否则预热超时（-RenderOffScreen/藏窗会卡死）。 */
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
    const is58 = /^5\\.(?:[89]|\\d{2,})/.test(ver);
    return isPs2 || is58;
  }

  private async waitForWarmEngine`;
  if (!s.includes(anchor)) {
    console.log('anchor missing');
  } else {
    s = s.replace(anchor, helper);
    fs.writeFileSync(path, s);
    console.log('helper inserted');
  }
}

// Prefer reg.entry plugin/version when deciding to keep the window
s = fs.readFileSync(path, 'utf8');
const oldHide = `    // PeerStream 模式下 execue 负责拉起 UE。5.8/PS2 藏窗会导致引擎起不来，跳过。
    if (!this.shouldShowUeWindow(project)) this.hideUeWindows(project.exePath);`;
const newHide = `    // PeerStream 模式下 execue 负责拉起 UE。5.8/PS2 藏窗会导致引擎起不来，跳过。
    {
      const entry = reg.entry as { pixelStreamingPlugin?: string; metadata?: { ueVersion?: string } } | undefined;
      const ver = String(entry?.metadata?.ueVersion ?? '');
      const isPs2 = entry?.pixelStreamingPlugin === 'PixelStreaming2' || /^5\\.(?:[89]|\\d{2,})/.test(ver);
      if (!isPs2) this.hideUeWindows(project.exePath);
    }`;
if (s.includes(oldHide)) {
  s = s.replace(oldHide, newHide);
  fs.writeFileSync(path, s);
  console.log('hide uses reg.entry');
} else {
  console.log('hide block not exact, ok if already patched');
}
