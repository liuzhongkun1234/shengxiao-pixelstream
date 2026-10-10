export function resolveCodecObservation({ client = {}, agent = {}, project = {}, accessScope = "lan", av1Cooldown = false } = {}) {
  const codecs = new Set((client.videoCodecs || []).map(x => String(x).toUpperCase()));
  const ueVersion = String(project?.metadata?.ueVersion || project?.ueVersion || "");
  const match = ueVersion.match(/^(\d+)(?:\.(\d+))?/), major = Number(match?.[1] || 0), minor = Number(match?.[2] || 0);
  const ueSupportsAv1 = major > 5 || (major === 5 && minor >= 4);
  const mobileAllowed = project?.codecPolicy?.allowMobileAv1 === true;
  const projectAllowsAv1 = project?.codecPolicy?.allowAutomaticAv1 === true || project?.codecPolicy?.experimentalAv1 === true;
  const clientRequestedAv1 = client?.requestedCodec === "AV1";
  const clientForcesH264 = client?.forcedCodec === "H264";
  const selectionMode = String(project?.codecPolicy?.mode || "manual").toLowerCase();
  const publicAuto = accessScope === "public" && ["auto", "public-auto"].includes(selectionMode);
  let recommendedCodec = "H264", currentCodec = "H264", reasonCode = "h264_compatibility", reasonText = "H.264 兼容模式";

  if (selectionMode === "h264") { reasonCode = "project_forces_h264"; reasonText = "项目固定使用 H.264"; }
  else if (!ueSupportsAv1) { reasonCode = "ue_version_no_av1"; reasonText = ueVersion ? `UE ${ueVersion} 使用 H.264 兼容模式` : "未确认 UE 版本"; }
  else if (agent?.av1Encode !== true) { reasonCode = "server_no_av1_encoder"; reasonText = agent?.gpuName ? `${agent.gpuName} 未确认 AV1 硬件编码` : "未检测到服务器 AV1 编码能力"; }
  else if (!codecs.has("AV1")) { reasonCode = "client_no_av1"; reasonText = "访问设备不支持 AV1 WebRTC 解码"; }
  else if (client.mobile && !mobileAllowed) { reasonCode = "mobile_av1_not_enabled"; reasonText = "移动设备使用 H.264 兼容模式"; }
  else {
    recommendedCodec = "AV1";
    if (!projectAllowsAv1) { reasonCode = "project_av1_disabled"; reasonText = "项目尚未允许公网自动 AV1"; }
    else if (clientForcesH264) { reasonCode = "client_forces_h264"; reasonText = "用户选择 H.264 兼容模式"; }
    else if (av1Cooldown) { reasonCode = "av1_fallback_cooldown"; reasonText = "该设备 AV1 失败冷却中，暂用 H.264"; }
    else if (publicAuto) { currentCodec = "AV1"; reasonCode = "public_auto_av1"; reasonText = "公网自动选择 AV1"; }
    else if (clientRequestedAv1) { currentCodec = "AV1"; reasonCode = "manual_av1"; reasonText = "手动选择 AV1"; }
    else { reasonCode = "av1_manual_available"; reasonText = "满足 AV1 手动试验条件"; }
  }

  const av1Eligible = recommendedCodec === "AV1";
  return {
    mode: publicAuto ? "public-auto" : projectAllowsAv1 ? "manual" : "observe",
    currentCodec, recommendedCodec, reasonCode, reasonText,
    clientCodecs: [...codecs], mobile: client.mobile === true, ueVersion: ueVersion || "unknown",
    gpuName: agent?.gpuName || "unknown", gpuDriver: agent?.driverVersion || "unknown",
    av1EncodeConfidence: agent?.av1EncodeConfidence || "unknown", wouldSelectAv1: av1Eligible,
    experimentEnabled: projectAllowsAv1, av1Requested: currentCodec === "AV1", clientRequestedAv1,
    automaticAv1: currentCodec === "AV1" && publicAuto, forcedCodec: clientForcesH264 ? "H264" : null,
    av1Cooldown: av1Cooldown === true, fallbackCodec: "H264"
  };
}

export function markAv1FallbackCooldown(cooldowns, projectId, clientId, minutes = 30, now = Date.now()) {
  if (!(cooldowns instanceof Map) || !projectId || !clientId) return 0;
  const until = now + Math.max(1, Number(minutes) || 30) * 60_000;
  cooldowns.set(`${projectId}:${clientId}`, until);
  return until;
}

export function isAv1FallbackCooldownActive(cooldowns, projectId, clientId, now = Date.now()) {
  if (!(cooldowns instanceof Map) || !projectId || !clientId) return false;
  const key = `${projectId}:${clientId}`, until = Number(cooldowns.get(key)) || 0;
  if (until <= now) { cooldowns.delete(key); return false; }
  return true;
}

export function applyCodecArgument(args = [], codec = "H264") {
  const result = args.filter(value => !/^-PixelStreamingEncoderCodec=/i.test(String(value)));
  result.push(`-PixelStreamingEncoderCodec=${String(codec).toUpperCase() === "AV1" ? "AV1" : "H264"}`);
  return result;
}
