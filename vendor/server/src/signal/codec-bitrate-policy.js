export function resolveCodecBitrateObservation(baseLimitMbps, codec = "H264", config = {}, requestedFactor = 1) {
  const normalizedCodec = String(codec || "H264").toUpperCase() === "AV1" ? "AV1" : "H264";
  const defaults = { H264: 1, AV1: 0.7 };
  const configured = Number(config?.codecFactors?.[normalizedCodec]);
  const observationFactor = Number.isFinite(configured) && configured > 0 && configured <= 1 ? configured : defaults[normalizedCodec];
  const allowed = normalizedCodec === "AV1" ? [1, 0.8, 0.7] : [1];
  const appliedFactor = allowed.includes(Number(requestedFactor)) ? Number(requestedFactor) : 1;
  const base = Math.max(0, Number(baseLimitMbps) || 0);
  const minimum = Math.max(1, Number(config?.minimumMbps) || 5);
  const suggested = base > 0 ? Math.min(base, Math.max(minimum, Math.round(base * observationFactor * 10) / 10)) : 0;
  const applied = base > 0 ? Math.min(base, Math.max(minimum, Math.round(base * appliedFactor * 10) / 10)) : 0;
  return { codecFactorMode: appliedFactor < 1 ? "apply" : "observe", currentCodec: normalizedCodec, networkLimitMbps: base, codecFactor: appliedFactor < 1 ? appliedFactor : observationFactor, codecSuggestedLimitMbps: suggested, codecAppliedLimitMbps: applied, codecEstimatedSavingsPercent: Math.round((1 - observationFactor) * 100), codecAppliedSavingsPercent: Math.round((1 - appliedFactor) * 100), codecFactorApplied: appliedFactor < 1 };
}
