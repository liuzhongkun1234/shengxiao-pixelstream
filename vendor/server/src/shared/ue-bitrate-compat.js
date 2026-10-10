export function isUe53(project = {}) {
  return /^5\.3(?:\D|$)/.test(String(project?.metadata?.ueVersion || project?.ueVersion || ""));
}

export function projectBitrateCap(project = {}) {
  return { "ultra-low": 10, low: 12, balanced: 15, quality: 20 }[String(project?.bitrateProfile || "auto")] || 0;
}

export function applyProjectStartupBitrate(args, project = {}) {
  const cap = projectBitrateCap(project);
  if (!cap) return args;
  const prefixes = ["-PixelStreamingWebRTCMaxBitrate=", "-PixelStreaming2WebRTCMaxBitrate="];
  const configured = readArgumentNumber(args, prefixes) / 1_000_000;
  const target = Math.max(1, Math.floor(Math.min(configured || cap, cap)));
  return [...args.filter(arg => !prefixes.some(prefix => String(arg).toLowerCase().startsWith(prefix.toLowerCase()))), `-PixelStreamingWebRTCMaxBitrate=${target * 1_000_000}`];
}

export function applyUe53StartupBitrate(args, project, requestedMbps = 0) {
  const clean = args.filter(arg => !/^-PeerStreamBitrateTest=/i.test(String(arg)));
  if (!isUe53(project)) return clean;
  const configured = readArgumentNumber(clean, ["-PixelStreamingWebRTCMaxBitrate="]) / 1_000_000;
  const requested = Number(requestedMbps) > 0 ? Number(requestedMbps) : 30;
  const target = Math.max(1, Math.floor(Math.min(configured || requested, requested, 16)));
  const managed = /^-PixelStreaming(?:2)?(?:WebRTC(?:MinBitrate|StartBitrate|MaxBitrate)|EncoderTargetBitrate)=/i;
  return [...clean.filter(arg => !managed.test(String(arg))),
    "-PixelStreamingEncoderTargetBitrate=-1",
    "-PixelStreamingWebRTCMinBitrate=100000",
    `-PixelStreamingWebRTCStartBitrate=${Math.min(1_000_000, target * 1_000_000)}`,
    `-PixelStreamingWebRTCMaxBitrate=${target * 1_000_000}`];
}

function readArgumentNumber(args, prefixes) {
  for (const arg of args) for (const prefix of prefixes)
    if (String(arg).toLowerCase().startsWith(prefix.toLowerCase())) return Number(String(arg).slice(prefix.length)) || 0;
  return 0;
}
