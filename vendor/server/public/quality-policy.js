(() => {
  const normalize = mode => ['quality', 'balanced', 'smooth'].includes(mode) ? mode : 'balanced';
  function bitrate(limit, mode, route = 'unknown', settings = {}, mobile = false) {
    const ceiling = Math.max(0, Number(limit) || 0);
    if (!ceiling) return 0;
    const cap = tier(mode, route, settings, mobile).cap;
    return Math.min(ceiling, cap);
  }
  function ue53Bitrate(limit, resolution = {}) {
    const ceiling = Math.max(0, Number(limit) || 0);
    if (!ceiling) return 0;
    const width = Math.max(0, Number(resolution.width) || 0);
    const height = Math.max(0, Number(resolution.height) || 0);
    const pixels = width * height;
    const cap = width > 2560 || height > 1440 || pixels > 3_000_000 ? 16 : width > 1920 ? 12 : 10;
    return Math.min(ceiling, cap);
  }
  function projectBitrate(limit, profile = 'auto') {
    const ceiling = Math.max(0, Number(limit) || 0);
    const cap = { 'ultra-low': 10, low: 12, balanced: 15, quality: 20 }[String(profile)] || Infinity;
    return Math.min(ceiling, cap);
  }
  function resolution(base, mode, mobile = false, route = 'unknown') {
    const factor = mobile || route === 'turn' ? 1 : { quality: 1, balanced: 1, smooth: 0.78 }[normalize(mode)];
    // Scale only after route and administrator limits have been applied.
    const even = value => Math.max(2, Math.floor(value / 2) * 2);
    return { ...base, width: even(base.width * factor), height: even(base.height * factor) };
  }
  function tier(mode, route = 'unknown', settings = {}, mobile = false) {
    const value = normalize(mode);
    const scope = mobile ? 'mobile' : route === 'turn' ? 'turn' : route === 'lanP2p' ? 'lan' : 'public';
    const defaults = mobile ? { quality: 20, balanced: 20, smooth: 8 } : scope === 'turn' ? { quality: 20, balanced: 15, smooth: 10 } : scope === 'lan' ? { quality: 50, balanced: 40, smooth: 30 } : { quality: 30, balanced: 30, smooth: 8 };
    const configured = Number(settings?.[scope]?.[value]);
    return { label: { quality: '高清', balanced: '均衡', smooth: '流畅' }[value], cap: Number.isFinite(configured) && configured > 0 ? Math.min(1000, configured) : defaults[value] };
  }
  function project(profile = 'auto') {
    return { 'ultra-low': { label: '10 Mbps', cap: 10 }, low: { label: '12 Mbps', cap: 12 }, balanced: { label: '15 Mbps', cap: 15 }, quality: { label: '20 Mbps', cap: 20 } }[String(profile)] || { label: '自动', cap: 0 };
  }
  globalThis.PeerStreamQualityPolicy = Object.freeze({ normalize, bitrate, ue53Bitrate, projectBitrate, resolution, tier, project });
})();
