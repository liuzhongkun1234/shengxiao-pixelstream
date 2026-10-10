const DEFAULTS = Object.freeze({
  mode: "auto",
  minimumMbps: 5,
  lanP2p: [50, 40, 30],
  publicP2p: [30, 25, 20],
  turn: [20, 15, 10],
  turnMaximumMbps: 20,
  mobileLanMaximumMbps: 15,
  mobilePublicMaximumMbps: 20,
  mobileTurnMaximumMbps: 10,
  poorNetworkMbps: 8,
  fairNetworkMbps: 10,
  decreaseFactor: 0.8,
  increaseStepMbps: 2,
  recoveryStableSeconds: 25,
  increaseIntervalSeconds: 25,
  poorConfirmSamples: 2,
  decreaseIntervalSeconds: 10
});

export class BitratePolicyEngine {
  constructor(options = {}) { const legacyTurn = Array.isArray(options.turn) && options.turn.length === 3 && options.turn.every(value => Number(value) === 10) && options.turnMaximumMbps == null; this.options = { ...DEFAULTS, ...options, lanP2p: options.lanP2p || options.p2p || DEFAULTS.lanP2p, publicP2p: options.publicP2p || DEFAULTS.publicP2p, turn: legacyTurn ? DEFAULTS.turn : options.turn || DEFAULTS.turn }; }

  evaluate(sample, previous = {}, now = Date.now()) {
    const isTurn = String(sample.connectionType || "").toLowerCase().includes("turn");
    const directRoute = sample.localCandidateType === "host" && sample.remoteCandidateType === "host" ? "lanP2p" : "publicP2p";
    const route = isTurn ? "turn" : sample.accessScope === "public" ? directRoute : "lanP2p";
    const count = Math.max(1, Number(sample.activeCount) || 1);
    const tier = count === 1 ? 0 : count === 2 ? 1 : 2;
    const configuredMaximum = Math.max(0, Number(sample.maximumMbps) || Infinity);
    const mobileMaximum = route === "turn" ? this.options.mobileTurnMaximumMbps : route === "publicP2p" ? this.options.mobilePublicMaximumMbps : this.options.mobileLanMaximumMbps;
    const qualityMode = ["quality", "balanced", "smooth"].includes(sample.qualityMode) ? sample.qualityMode : "balanced";
    const mobileTier = Number(this.options.qualityTiers?.mobile?.[qualityMode]) || ({ quality: 20, balanced: 20, smooth: 8 })[qualityMode];
    const deviceMaximum = sample.mobile === true ? Math.min(Math.max(1, Number(mobileMaximum) || 20), Math.max(1, mobileTier)) : Infinity;
    const routeMaximum = route === "turn" ? Math.max(1, Number(this.options.turnMaximumMbps) || 20) : Infinity;
    const turnQualityMaximum = route === "turn" && sample.mobile !== true ? Math.max(1, Number(this.options.qualityTiers?.turn?.[qualityMode]) || ({ quality: 20, balanced: 15, smooth: 10 })[qualityMode]) : Infinity;
    const instanceLimit = Math.min(Number(this.options[route][tier]), configuredMaximum, deviceMaximum, routeMaximum, turnQualityMaximum);
    const minimum = Math.min(instanceLimit, Math.max(1, Number(this.options.minimumMbps) || 5));
    const lossRate = Math.max(0, Number(sample.lossRate) || 0);
    const dropRate = Math.max(0, Number(sample.dropRate) || 0);
    const rttMs = Math.max(0, Number(sample.rttMs) || 0);
    const previousRtt = previous.route === route ? Number(previous.rttMs) || 0 : 0;
    const delayRising = previousRtt > 0 && rttMs >= previousRtt + 30 && rttMs >= previousRtt * 1.5;
    const poor = lossRate >= .05 || dropRate >= .08 || rttMs >= 160;
    const fair = !poor && (lossRate >= .02 || dropRate >= .03 || rttMs >= 80 || delayRising);
    const measured = Number(sample.bitrateMbps) > 0 && Number(sample.framesDecodedDelta) > 0;
    const healthy = !poor && !fair && rttMs > 0 && (route !== "publicP2p" && route !== "turn" || measured);
    const networkLimit = poor ? this.options.poorNetworkMbps : fair ? this.options.fairNetworkMbps : instanceLimit;
    const target = Math.min(instanceLimit, Math.max(minimum, networkLimit));
    const mobileInitial = route === "lanP2p" ? 10 : 8;
    if (previous.route && previous.route !== route) previous = {};
    const oldLimit = Number(previous.recommendedLimitMbps) || (sample.mobile === true ? Math.min(instanceLimit, mobileInitial) : route === "publicP2p" ? Math.min(instanceLimit, 12) : route === "turn" ? Math.min(instanceLimit, 10) : instanceLimit);
    let recommended = Math.min(oldLimit, instanceLimit), adaptiveState = "稳定", reasonCode = sample.mobile === true && deviceMaximum <= Math.min(Number(this.options[route][tier]), configuredMaximum) ? "mobile_protection" : route === "turn" ? "turn_protection" : route === "publicP2p" ? "public_p2p_protection" : count > 1 ? "multi_instance" : "single_instance";
    let stableSince = Number(previous.stableSince) || 0, lastAdjustmentAt = Number(previous.lastAdjustmentAt) || 0;
    const poorSampleCount = poor ? Math.max(0, Number(previous.poorSampleCount) || 0) + 1 : 0;
    const poorConfirmed = poorSampleCount >= Math.max(2, Number(this.options.poorConfirmSamples) || 2);
    const fairSampleCount = fair ? Math.max(0, Number(previous.fairSampleCount) || 0) + 1 : 0;
    const fairConfirmed = fairSampleCount >= 2;
    const networkPressureSeen = previous.networkPressureSeen === true || poorConfirmed || fairConfirmed;
    const initialProbe = (route === "publicP2p" || route === "turn") && !networkPressureSeen;

    if (poor && !poorConfirmed) {
      recommended = Math.min(oldLimit, instanceLimit);
      adaptiveState = "检测到网络波动，继续观察"; reasonCode = "network_fluctuation";
      stableSince = 0;
    } else if (poorConfirmed) {
      const decreaseIntervalMs = Math.max(5, Number(this.options.decreaseIntervalSeconds) || 10) * 1000;
      if (!lastAdjustmentAt || now - lastAdjustmentAt >= decreaseIntervalMs) {
        recommended = Math.max(minimum, Math.min(target, Math.floor(oldLimit * this.options.decreaseFactor)));
        if (recommended !== oldLimit) lastAdjustmentAt = now;
        adaptiveState = "持续丢包，正在降低";
      } else {
        recommended = oldLimit;
        adaptiveState = "降档后观察中";
      }
      reasonCode = lossRate >= .05 ? "high_packet_loss" : dropRate >= .08 ? "high_frame_drop" : "high_rtt";
      stableSince = 0;
    } else if (fair && !fairConfirmed) {
      recommended = Math.min(oldLimit, instanceLimit); adaptiveState = "检测到网络波动，继续观察"; reasonCode = "network_fluctuation"; stableSince = 0;
    } else if (fairConfirmed) {
      recommended = Math.min(oldLimit, target); adaptiveState = "网络质量一般"; reasonCode = "fair_network"; stableSince = 0;
      if (recommended !== oldLimit) lastAdjustmentAt = now;
    } else if (healthy && oldLimit < target) {
      stableSince ||= now;
      const recoverySeconds = initialProbe ? (qualityMode === "quality" ? 5 : 10) : Number(this.options.recoveryStableSeconds) || 25;
      const increaseSeconds = initialProbe ? (qualityMode === "quality" ? 5 : 10) : Number(this.options.increaseIntervalSeconds) || 25;
      const stableMs = now - stableSince, intervalMs = now - lastAdjustmentAt;
      if (stableMs >= recoverySeconds * 1000 && intervalMs >= increaseSeconds * 1000) {
        recommended = Math.min(target, oldLimit + (initialProbe ? (sample.mobile === true ? 2 : 4) : this.options.increaseStepMbps)); lastAdjustmentAt = now; adaptiveState = initialProbe ? "首次连接，快速试探画质" : "网络恢复，逐步提高"; reasonCode = initialProbe ? "initial_quality_probe" : "network_recovering";
      } else { recommended = oldLimit; adaptiveState = "等待网络稳定"; reasonCode = "recovery_hysteresis"; }
    } else {
      recommended = healthy ? target : Math.min(oldLimit, target); stableSince = healthy ? (stableSince || now) : 0;
      if ((route === "publicP2p" || route === "turn") && !healthy) { adaptiveState = "等待有效视频采样"; reasonCode = "awaiting_media_sample"; }
    }

    recommended = Math.min(instanceLimit, Math.max(minimum, recommended));
    return {
      recommendedLimitMbps: recommended, instanceLimitMbps: instanceLimit,
      routeLimitMbps: instanceLimit, networkLimitMbps: networkLimit,
      route, routeLabel: route === "turn" ? "公网 TURN 中继" : route === "publicP2p" ? "公网 P2P 直连" : "局域网 P2P 直连",
      reasonCode, reasonText: reasonText(reasonCode, count, route), adaptiveState,
      networkQuality: poor ? "较差" : fair ? "一般" : healthy ? "良好" : "检测中",
      native4kEligible: (route === "publicP2p" || route === "turn" && qualityMode === "quality") && sample.mobile !== true && recommended >= (route === "turn" ? 18 : 24) && ((healthy && stableSince > 0 && now - stableSince >= (initialProbe ? 15000 : 30000)) || (previous.native4kEligible === true && measured && !fair && !poorConfirmed)),
      qualityMode, networkPressureSeen, rttMs, stableSince, lastAdjustmentAt, poorSampleCount, fairSampleCount, calculatedAt: now, mode: ["fixed", "observe", "auto"].includes(this.options.mode) ? this.options.mode : "auto"
    };
  }
}

function reasonText(code, count, route) {
  const values = {
    initial_quality_probe: "首次连接健康，逐档试探更高清画质",
    awaiting_media_sample: "等待有效视频采样，不提升带宽上限",
    network_fluctuation: "检测到一次网络波动，继续观察", high_packet_loss: "链路持续丢包，正在降低码率和分辨率", high_frame_drop: "持续丢帧，正在降低码率和分辨率", high_rtt: "网络延迟持续较高，正在降低码率",
    fair_network: "当前网络质量一般", network_recovering: "网络恢复，正在逐步提高", recovery_hysteresis: "网络恢复观察中，等待稳定",
    turn_protection: count === 1 ? "公网TURN中继带宽保护" : `${count === 2 ? "双实例" : "多实例"} + 公网中继`,
    public_p2p_protection: count === 1 ? "公网P2P上行带宽保护" : `${count === 2 ? "双实例" : "多实例"} + 公网P2P保护`,
    mobile_protection: "手机流畅度保护",
    multi_instance: "多实例性能保护", single_instance: "单实例高画质"
  };
  return values[code] || (route === "turn" ? "公网中继带宽保护" : route === "publicP2p" ? "公网P2P带宽保护" : "连接策略");
}
