import { applyProjectStartupBitrate, applyUe53StartupBitrate, isUe53 } from '../shared/ue-bitrate-compat.js';
import { resolveStreamingProtocol, resolveStreamingPlugin } from "../shared/streaming-compatibility.js";
import crypto from "node:crypto";
import { mergeExecCommands } from "../shared/ue-exec-commands.js";
import { execFileSync } from "node:child_process";
import { message, sendJson, Types } from "../shared/protocol.js";
import { applyCodecArgument } from "./codec-policy.js";

export class InstanceManager {
  constructor(projects, logger, policies = {}) {
    this.projects = new Map(projects.map(x => [x.id, x]));
    this.logger = logger;
    this.policies = policies;
    this.instances = new Map();
    this.agents = new Map();
    this.agentCapabilities = new Map();
    this.onReady = () => {};
    this.onProtocolFallback = () => false;
    this.onCodecFallback = () => false;
    this.onCapacityAvailable = () => {};
    this.onQualityLimitChanged = () => {};
    this.onGpuLearned = () => {};
    this.onStartFailed = () => {};
    this.onEnded = () => {};
    this.onAgentStatus = () => {};
    this.preloadPending = new Set();
    this.preloadSuppressedProjects = new Set();
    this.preloadRetryAfter = new Map();
    this.preloadFailures = new Map();
    this.preloadFailureCount = new Map();
    this.hasConnectedEngine = false;
  }

  get(id) { return this.instances.get(id); }
  list() { return [...this.instances.values()]; }
  getAgentCapabilities(id) { return this.agentCapabilities.get(id) || null; }

  /** 热重载项目登记（服务运行中启动器新增/关闭项目时调用） */
  setProjects(projects) {
    this.projects = new Map((projects || []).map((x) => [x.id, x]));
  }

  addAgent(id, socket) {
    this.agents.set(id, socket);
    this.logger.info("agent.connected", { execueId: id });
  }

  removeAgent(id, socket) {
    if (this.agents.get(id) === socket) { this.agents.delete(id); this.agentCapabilities.delete(id); }
    this.logger.warn("agent.disconnected", { execueId: id });
  }

  canAccept(instance, mode, session = {}, maxSharedPlayers = 20) {
    const capacity = mode === "shared" ? Math.max(1, Number(maxSharedPlayers) || 20) : 1;
    return ["starting", "running", "recovering"].includes(instance.state) && instance.players.size < capacity && (!instance.recoveryOwner || instance.recoveryOwner === session.recoveryKey);
  }

  findAvailable(projectId, mode, codec = "H264", session = {}, maxSharedPlayers = 20) {
    return [...this.instances.values()].find(x => x.projectId === projectId && (x.codec || "H264") === codec && (["running", "recovering"].includes(x.state) || (x.state === "starting" && (mode === "shared" || x.preloaded || x.recoveryOwner === session.recoveryKey && x.recoveryOwner))) && this.canAccept(x, mode, session, maxSharedPlayers));
  }

  isPreloadProject(projectId) {
    const project = this.projects.get(projectId);
    return project?.enabled === true && project?.metadata?.preload === true;
  }

  shouldKeepPreloaded(instance) {
    return Boolean(instance?.preloaded && instance.state === "running" && this.isPreloadProject(instance.projectId) && !this.preloadSuppressedProjects.has(instance.projectId));
  }

  preloadStatus() {
    return [...this.projects.values()].filter(p => p.metadata?.preload === true).map(p => {
      const active = this.list().filter(x => x.projectId === p.id && !["ended", "stopping"].includes(x.state));
      const ready = active.find(x => x.state === "running" && x.engine?.readyState === 1);
      const state = !p.enabled ? "项目未启用" : this.preloadSuppressedProjects.has(p.id) ? "已暂停" : !this.agents.has(p.execueId) ? "等待服务" : ready ? (ready.players.size ? "使用中" : "待命") : active.length ? "启动中／等待连接" : (this.preloadRetryAfter.get(p.id) || 0) > Date.now() ? "启动未成功，等待重试" : "等待资源";
      return { projectId: p.id, name: p.name || p.id, state, reason: this.preloadFailures.get(p.id) || null };
    });
  }

  async resumePreload(projectId, allowStart = true) {
    if (!this.isPreloadProject(projectId)) return;
    this.preloadSuppressedProjects.delete(projectId);
    this.preloadRetryAfter.delete(projectId);
    this.preloadFailureCount.delete(projectId);
    this.preloadFailures.delete(projectId);
    const active = this.list().find(x => x.projectId === projectId && !["ended", "stopping"].includes(x.state));
    if (active) active.preloaded = true;
    if (allowStart) await this.reconcilePreloadedInstances(null, projectId);
  }

  /** 记录一次预热失败；连续失败达到阈值后暂停自动重试（避免坏项目无限重启）。 */
  recordPreloadFailure(projectId, reason) {
    const count = (this.preloadFailureCount.get(projectId) || 0) + 1;
    this.preloadFailureCount.set(projectId, count);
    this.preloadRetryAfter.set(projectId, Date.now() + 30_000);
    this.preloadFailures.set(projectId, reason || "unknown");
    if (count >= 3) {
      this.preloadSuppressedProjects.add(projectId);
      this.logger.warn("preload.auto_suppressed", { projectId, failures: count, reason: reason || "unknown" });
    }
    return count;
  }

  clearPreloadFailure(projectId) {
    this.preloadFailureCount.delete(projectId);
    this.preloadRetryAfter.delete(projectId);
    this.preloadFailures.delete(projectId);
  }

  async reconcilePreloadedInstances(execueId = null, projectId = null) {
    for (const project of this.projects.values()) {
      if (projectId && project.id !== projectId) continue;
      if (!project?.enabled || project?.metadata?.preload !== true || (execueId && project.execueId !== execueId)) continue;
      if (this.preloadSuppressedProjects.has(project.id) || this.preloadPending.has(project.id) || !this.agents.has(project.execueId)) continue;
      if ((this.preloadRetryAfter.get(project.id) || 0) > Date.now()) continue;
      const active = [...this.instances.values()].some(instance => instance.projectId === project.id && !["ended", "stopping"].includes(instance.state));
      if (active) continue;
      this.preloadPending.add(project.id);
      try {
        const instance = await this.allocate(project.id, { preloaded: true });
        this.preloadRetryAfter.delete(project.id);
        this.logger.info("preload.start_requested", { projectId: project.id, instanceId: instance.id, execueId: project.execueId });
      } catch (error) {
        this.recordPreloadFailure(project.id, error.code || "allocation_failed");
        this.logger.warn("preload.start_skipped", { projectId: project.id, execueId: project.execueId, reason: error.code || error.message });
      } finally {
        this.preloadPending.delete(project.id);
      }
    }
  }

  async allocate(projectId, options = {}) {
    const project = this.projects.get(projectId);
    if (!project?.enabled) throw new Error("project unavailable");
    if (["editor", "external-editor"].includes(project.runtimeMode)) throw new Error("external editor must be connected from Launcher");
    const agent = this.agents.get(project.execueId);
    if (!agent) throw new Error(`execue ${project.execueId} offline`);
    const activeCountBefore = [...this.instances.values()].filter(x => !["ended", "stopping"].includes(x.state)).length;
    const snapshot = readGpuSnapshot();
    const activeCount = activeCountBefore + 1;
    const quality = resolveQualityProfile(this.policies.performance, activeCount);
    const profileName = quality?.name || "original";
    const requestedGB = estimatedIncrementGB(project, profileName);
    const pendingBudgetGB = [...this.instances.values()].filter(x => x.state === "starting").reduce((sum, x) => sum + (Number(x.estimatedGpuIncrementGB) || 3), 0);
    const admissionSnapshot = snapshot ? { ...snapshot, usedGB: snapshot.usedGB + pendingBudgetGB, actualUsedGB: snapshot.usedGB, pendingBudgetGB } : null;
    if (activeCountBefore > 0 && admissionSnapshot && !hasGpuCapacity(admissionSnapshot, requestedGB)) {
      const error = new Error(`GPU capacity insufficient: used ${admissionSnapshot.usedGB.toFixed(1)} GB, safe ${admissionSnapshot.safeGB.toFixed(1)} GB, requested ${requestedGB.toFixed(1)} GB`);
      error.code = "gpu_capacity_insufficient"; error.capacity = { ...admissionSnapshot, requestedGB }; throw error;
    }
    const id = crypto.randomUUID();
    const engineAuthTicket = crypto.randomBytes(24).toString("base64url");
    const codec = String(options.codec || "H264").toUpperCase() === "AV1" ? "AV1" : "H264";
    const launchArgs = applyUe53StartupBitrate(applyProjectStartupBitrate(applyCodecArgument(applyQualityProfile(project.args || [], quality, project), codec), project), project);
    const instance = { ue53BitrateCompat: isUe53(project), id, projectId, project, execueId: project.execueId, codec, codecFallbackAttempted: options.codecFallbackAttempted === true, preloaded: options.preloaded === true, state: "starting", engine: null, engineAuthTicket, streamerRegistered: false, boundPlayers: new Set(), players: new Set(), createdAt: Date.now(), stopTimer: null, gpuBaselineUsedGB: snapshot?.usedGB, estimatedGpuIncrementGB: requestedGB };
    this.instances.set(id, instance);
    this.scheduleEngineTimeout(instance);
    sendJson(agent, message(Types.InstanceStart, {
      instanceId: id, projectId, executable: project.executable, args: launchArgs, gpuIndex: Number(project.gpuIndex) || 0,
      ueVersion: project?.metadata?.ueVersion || project?.ueVersion || "",
      webRtcPortPolicy: project?.metadata?.webRtcPortPolicy || null,
      localAudio: project.localAudio === true,
      pixelStreamingProtocol: resolveProjectStreamingProtocol(project), pixelStreamingPlugin: resolveStreamingPlugin(project), engineAuthTicket
    }));
    instance.qualityProfile = quality?.name || "original";
    instance.qualityLimit = quality ? { width: Number(quality.resX), height: Number(quality.resY) } : null;
    this.rebalanceQualityLimits();
    const fpsLimit = quality?.fps || readArgumentNumber(launchArgs, ["-PixelStreamingWebRTCFps=", "-PixelStreamingWebRTCMaxFps="]);
    instance.qualityFps = fpsLimit || null;
    instance.qualityBitrateMbps = readArgumentNumber(launchArgs, ["-PixelStreamingWebRTCMaxBitrate=", "-PixelStreaming2WebRTCMaxBitrate="]) / 1_000_000 || quality?.maxBitrateMbps || null;
    this.logger.info("instance.start_requested", { ue53BitrateCompat: instance.ue53BitrateCompat, instanceId: id, projectId, execueId: project.execueId, codec, activeCount, qualityProfile: instance.qualityProfile, webRtcPortPolicy: project?.metadata?.webRtcPortPolicy || { mode: "fixed", legacyDefault: true }, resolution: quality ? `${quality.resX}x${quality.resY}` : "project-default", fps: instance.qualityFps, fpsArgument: launchArgs.find(x => /PixelStreamingWebRTC(?:Max)?Fps=/i.test(String(x))), maxBitrateMbps: instance.qualityBitrateMbps });
    return instance;
  }

  attachEngine(instanceId, projectId, socket, notifyReady = true) {
    let instance = this.instances.get(instanceId);
    if (!instance) {
      const project = this.projects.get(projectId);
      instance = { id: instanceId, projectId, project, execueId: project?.execueId, state: "running", engine: socket, players: new Set(), createdAt: Date.now(), stopTimer: null };
      this.instances.set(instanceId, instance);
    }
    instance.engine = socket;
    clearTimeout(instance.engineTimer); clearTimeout(instance.recoveryTimer); instance.engineTimer = null; instance.recoveryTimer = null;
    instance.state = "running";
    if (instance.preloaded) this.clearPreloadFailure(instance.projectId);
    this.hasConnectedEngine = true;
    this.logger.info("instance.engine_connected", { instanceId, projectId });
    instance.gpuLearnTimer = setTimeout(() => this.learnGpuIncrement(instance), 30_000); instance.gpuLearnTimer.unref?.();
    if (notifyReady) this.onReady(instance);
    return instance;
  }

  prepareExternalEditor(projectId) {
    const project = this.projects.get(projectId);
    if (!project?.enabled || project.runtimeMode !== "external-editor") throw new Error("external editor project unavailable");
    let instance = this.list().find(x => x.projectId === projectId && x.externalEditor && ["starting", "running"].includes(x.state));
    if (instance) {
      if (project.persistentEditorConnection === true) clearTimeout(instance.engineTimer);
      return instance;
    }
    const id = crypto.randomUUID();
    instance = { id, projectId, project, externalEditor: true, codec: "H264", state: "starting", engine: null, engineAuthTicket: crypto.randomBytes(24).toString("base64url"), players: new Set(), boundPlayers: new Set(), createdAt: Date.now(), streamerRegistered: false };
    this.instances.set(id, instance);
    // Only an explicit administrator action creates this connection slot. No UE process is owned.
    if (project.persistentEditorConnection !== true) {
      instance.engineTimer = setTimeout(() => this.stop(id, "editor_connection_expired"), 10 * 60_000);
      instance.engineTimer.unref?.();
    }
    return instance;
  }

  notifyEngineReady(instance) {
    if (instance?.engine && instance.state === "running") this.onReady(instance);
  }

  scheduleEngineTimeout(instance) {
    const coldStart = !this.hasConnectedEngine;
    const seconds = coldStart
      ? Math.max(30, Number(this.policies.coldStartTimeoutSeconds) || 90)
      : Math.max(20, Number(this.policies.engineConnectTimeoutSeconds) || 60);
    instance.engineTimeoutStage = 0;
    instance.engineTimer = setTimeout(() => this.handleEngineTimeout(instance), seconds * 1000);
    instance.engineTimer.unref?.();
    this.logger.info("instance.engine_wait_started", { instanceId: instance.id, projectId: instance.projectId, coldStart, timeoutSeconds: seconds });
  }

  handleEngineTimeout(instance) {
    if (instance.engine || instance.state !== "starting") return;
    const extensionSeconds = Math.max(0, Number(this.policies.engineTimeoutExtensionSeconds) || 30);
    if (Number(instance.pid) > 0 && instance.engineTimeoutStage === 0 && extensionSeconds > 0) {
      instance.engineTimeoutStage = 1;
      this.logger.warn("instance.engine_wait_extended", { instanceId: instance.id, projectId: instance.projectId, pid: instance.pid, extensionSeconds, reason: "ue_process_still_running" });
      instance.engineTimer = setTimeout(() => this.handleEngineTimeout(instance), extensionSeconds * 1000);
      instance.engineTimer.unref?.();
      return;
    }
    const reasonCode = engineTimeoutReason(instance);
    if (instance.preloaded) this.recordPreloadFailure(instance.projectId, reasonCode);
    this.logger.warn("instance.engine_connect_timeout", { instanceId: instance.id, projectId: instance.projectId, pid: instance.pid, reasonCode });
    this.onStartFailed(instance, reasonCode);
    this.stop(instance.id, reasonCode);
  }

  async stop(id, reasonCode) {
    const instance = this.instances.get(id);
    if (!instance || instance.state === "stopping" || instance.state === "ended") return;
    if (instance.externalEditor) {
      clearTimeout(instance.engineTimer); clearTimeout(instance.stopTimer); clearTimeout(instance.gpuLearnTimer); clearTimeout(instance.fairUseTimer); clearTimeout(instance.turnDiagnosticTimer);
      instance.state = "ended"; instance.endedAt = Date.now(); instance.endReasonCode = reasonCode;
      const engine = instance.engine; instance.engine = null;
      engine?.close(1000, "editor stream detached");
      this.onEnded(instance, reasonCode);
      for (const sessionId of instance.players) this.notifySession?.(sessionId, message(Types.Lifecycle, { state: "ended", instanceId: id, projectId: instance.projectId, reasonCode }));
      setTimeout(() => this.instances.delete(id), 60_000).unref?.();
      return;
    }
    if (["admin_project_stop", "admin_stop_all", "settings_changed", "manager_full_exit"].includes(reasonCode) || (reasonCode === "admin_requested" && instance.preloaded)) this.preloadSuppressedProjects.add(instance.projectId);
    instance.state = "stopping";
    clearTimeout(instance.engineTimer);
    clearTimeout(instance.recoveryTimer);
    clearTimeout(instance.stopTimer);
    clearTimeout(instance.gpuLearnTimer);
    clearTimeout(instance.fairUseTimer);
    clearTimeout(instance.turnDiagnosticTimer);
    instance.stopReasonCode = reasonCode;
    instance.stopFailed = false;
    instance.error = null;
    this.sendStopIntent(instance, true);
    for (const sessionId of instance.players) this.notifySession?.(sessionId, message(Types.Lifecycle, { state: "stopping", instanceId: id, projectId: instance.projectId, reasonCode }));
    this.logger.info("instance.stop_requested", { instanceId: id, projectId: instance.projectId, reasonCode });
  }

  sendStopIntent(instance, force = false) {
    const agent = this.agents.get(instance.execueId);
    if (agent?.readyState !== 1 || instance.stopFailed) return;
    if (!force && instance.stopAgent === agent && Date.now() - (instance.stopSentAt || 0) < 20000) return;
    sendJson(agent, message(Types.InstanceStop, { instanceId: instance.id, reasonCode: instance.stopReasonCode }));
    instance.stopAgent = agent;
    instance.stopSentAt = Date.now();
  }

  scheduleDisconnectedStop(id, seconds, reasonCode = "network_disconnect_timeout") {
    const instance = this.instances.get(id);
    if (!instance || instance.stopTimer) return;
    instance.stopTimer = setTimeout(() => this.stop(id, reasonCode), Math.max(0, seconds) * 1000);
  }

  cancelDisconnectedStop(id) {
    const instance = this.instances.get(id);
    if (instance?.stopTimer) clearTimeout(instance.stopTimer);
    if (instance) instance.stopTimer = null;
  }

  handleAgentMessage(execueId, value) {
    if (value.type === Types.AgentStatus && Array.isArray(value.instances)) {
      if (value.gpuCapabilities && typeof value.gpuCapabilities === "object") {
        const previous = this.agentCapabilities.get(execueId), next = value.gpuCapabilities;
        this.agentCapabilities.set(execueId, next);
        if (JSON.stringify(previous) !== JSON.stringify(next)) this.logger.info("agent.gpu_capabilities", { execueId, ...next });
      }
      for (const recovered of value.instances) {
        if (!recovered?.instanceId || !this.projects.has(recovered.projectId)) continue;
        if (this.projects.get(recovered.projectId)?.execueId !== execueId) continue;
        let current = this.instances.get(recovered.instanceId);
        const shouldMarkPreloaded = this.isPreloadProject(recovered.projectId) && ![...this.instances.values()].some(x => x.id !== recovered.instanceId && x.projectId === recovered.projectId && x.preloaded && !["ended", "stopping"].includes(x.state));
        if (!current) {
          const project = this.projects.get(recovered.projectId);
          current = { id: recovered.instanceId, projectId: recovered.projectId, project, execueId, preloaded: shouldMarkPreloaded, state: "recovering", engine: null, engineAuthTicket: recovered.engineAuthTicket || "", streamerRegistered: false, boundPlayers: new Set(), players: new Set(), createdAt: Number(recovered.startedAt) || Date.now(), pid: recovered.pid, recovered: true, stopTimer: null };
          this.instances.set(current.id, current);
          current.recoveryTimer = setTimeout(() => { if (!current.engine && current.state === "recovering") this.stop(current.id, "signal_recovery_timeout"); }, Math.max(10, Number(this.policies.serviceRecoverySeconds) || 60) * 1000);
          this.logger.info("instance.recovery_reported", { instanceId: current.id, projectId: current.projectId, execueId, pid: current.pid });
        } else Object.assign(current, {
          pid: recovered.pid,
          execueId,
          preloaded: current.preloaded === true || shouldMarkPreloaded,
          recovered: current.recovered === true || recovered.recovered === true,
          engineAuthTicket: recovered.engineAuthTicket || current.engineAuthTicket || "",
          createdAt: Number(recovered.startedAt) || current.createdAt
        });
        if (current.state === "stopping") this.sendStopIntent(current);
      }
      const reported = new Set(value.instances.map(x => x.instanceId));
      for (const pending of this.instances.values()) {
        if (pending.execueId === execueId && pending.state === "stopping" && pending.pid && !reported.has(pending.id))
          this.handleAgentMessage(execueId, message(Types.InstanceStopped, { instanceId: pending.id, reasonCode: pending.stopReasonCode }));
      }
      this.onAgentStatus(execueId);
      return;
    }
    const instance = this.instances.get(value.instanceId);
    if (!instance) return;
    if (instance.execueId !== execueId) return;
    if (value.type === Types.Error) {
      if (value.requestType === Types.InstanceStop) {
        if (instance.state === "ended") return;
        instance.state = "stop_failed";
        instance.stopFailed = true;
        const stopFailures = {
          process_identity_unknown: "进程身份未取得",
          process_identity_mismatch: "进程身份校验不一致",
          process_stop_access_denied: "进程访问权限不足",
          process_stop_timeout: "等待进程停止超时",
          process_stop_helper_failed: "停止辅助程序执行失败"
        };
        const failureCode = Object.hasOwn(stopFailures, value.failureCode) ? value.failureCode : "process_stop_failed";
        instance.error = `停止未确认：${stopFailures[failureCode] || "请检查执行端日志"}，可重试`;
        instance.stopReasonCode = "process_stop_failed";
        this.logger.warn("instance.stop_failed", { instanceId: instance.id, reasonCode: "process_stop_failed", failureCode });
        for (const id of instance.players) this.notifySession?.(id, message(Types.Lifecycle, { state: "stopping", phase: "stop_failed", instanceId: instance.id, reasonCode: "process_stop_failed", message: instance.error }));
        return;
      }
      Object.assign(instance, { state: "ended", endedAt: Date.now(), endReasonCode: "ue_start_failed", error: value.detail });
      if (instance.preloaded) this.recordPreloadFailure(instance.projectId, "ue_start_failed");
      clearTimeout(instance.engineTimer);
      if (instance.codec === "AV1" && !instance.codecFallbackAttempted) {
        instance.codecFallbackAttempted = true;
        const retrying = this.onCodecFallback(instance, "H264") === true;
        this.logger.warn("instance.codec_auto_fallback", { instanceId: instance.id, projectId: instance.projectId, fromCodec: "AV1", toCodec: "H264", reasonCode: "ue_start_failed", retrying });
        if (retrying) { setTimeout(() => this.instances.delete(instance.id), 60_000).unref?.(); return; }
      }
      for (const sessionId of instance.players) this.notifySession?.(sessionId, message(Types.Lifecycle, { state: "ended", instanceId: instance.id, projectId: instance.projectId, reasonCode: "ue_start_failed", message: value.detail }));
      this.logger.error("instance.start_failed", { instanceId: instance.id, projectId: instance.projectId, detail: value.detail });
      this.onStartFailed(instance, "ue_start_failed");
      return;
    }
    if (value.type === Types.InstanceStarted) {
      if (["ended", "stop_failed"].includes(instance.state)) return;
      if (instance.state === "stopping") { instance.pid = value.pid; this.sendStopIntent(instance, true); return; }
      // 圣效像素流补丁：进程启动回报可能晚于引擎接入（例如上一次运行遗留的 UE 进程抢先重连），
      // 此时不能把已经 running 的实例重置回 starting —— 否则 bindPlayer 永远不执行，观众会一直卡在"连接中"。
      const engineAlreadyConnected = instance.engine != null && instance.engine.readyState === 1;
      Object.assign(instance, { pid: value.pid, state: engineAlreadyConnected ? "running" : "starting", proxyDetected: value.proxyDetected === true, proxyBypass: value.proxyBypass });
      if (engineAlreadyConnected) {
        this.logger.warn("instance.ue_process_started_after_engine", { instanceId: instance.id, projectId: instance.projectId, pid: value.pid, keptState: "running" });
        this.notifyEngineReady(instance);
        return;
      }
      if (instance.proxyDetected) {
        clearTimeout(instance.engineTimer);
        instance.engineTimeoutStage = 1;
        instance.engineTimer = setTimeout(() => this.handleEngineTimeout(instance), 20_000);
        instance.engineTimer.unref?.();
        this.logger.warn("instance.proxy_fast_wait_started", { instanceId: instance.id, projectId: instance.projectId, pid: value.pid, timeoutSeconds: 20, proxyBypass: value.proxyBypass });
      }
      for (const sessionId of instance.players) this.notifySession?.(sessionId, message(Types.Lifecycle, { state: "starting", phase: instance.proxyDetected ? "proxy_bypass" : "ue_started", instanceId: instance.id, projectId: instance.projectId, projectName: instance.project?.name || instance.projectId, pid: value.pid, proxyDetected: instance.proxyDetected, waitSeconds: instance.proxyDetected ? 20 : undefined }));
      this.logger.info("instance.ue_process_started", { instanceId: instance.id, projectId: instance.projectId, pid: value.pid, proxyDetected: instance.proxyDetected, proxyBypass: value.proxyBypass });
    }
    if (value.type === Types.InstanceStopped || value.type === Types.InstanceExited) {
      const firstCompletion = !instance.endNotified;
      Object.assign(instance, { state: "ended", endedAt: Date.now(), exitCode: value.exitCode });
      if (firstCompletion) {
        instance.endNotified = true;
        const reasonCode = value.reasonCode || instance.stopReasonCode || "process_exited";
        instance.endReasonCode = reasonCode;
        this.onEnded(instance, reasonCode);
        if (instance.codec === "AV1" && !instance.codecFallbackAttempted && shouldFallbackAv1(reasonCode)) {
          instance.codecFallbackAttempted = true;
          const retrying = this.onCodecFallback(instance, "H264") === true;
          this.logger.warn("instance.codec_auto_fallback", { instanceId: instance.id, projectId: instance.projectId, fromCodec: "AV1", toCodec: "H264", reasonCode, retrying });
          if (retrying) { setTimeout(() => this.instances.delete(instance.id), 60_000).unref?.(); return; }
        }
        if (reasonCode === "ue_webrtc_protocol_incompatible" && String(instance.project?.pixelStreamingProtocol || "auto").toLowerCase() === "auto" && !instance.project.runtimeProtocolOverride) {
          instance.project.runtimeProtocolOverride = "legacy";
          const retrying = this.onProtocolFallback(instance, "legacy") === true;
          this.logger.warn("instance.protocol_auto_fallback", { instanceId: instance.id, projectId: instance.projectId, protocol: "legacy", retrying });
          if (retrying) { setTimeout(() => this.instances.delete(instance.id), 60_000).unref?.(); return; }
        }
        for (const sessionId of instance.players) this.notifySession?.(sessionId, message(Types.Lifecycle, { state: "ended", instanceId: instance.id, projectId: instance.projectId, reasonCode, exitCode: value.exitCode, pid: instance.pid }));
        this.logger.info("instance.ended", { instanceId: instance.id, projectId: instance.projectId, execueId, exitCode: value.exitCode, reasonCode });
        this.rebalanceQualityLimits();
        setTimeout(() => this.onCapacityAvailable(), 1500).unref?.();
        setTimeout(() => this.instances.delete(instance.id), 60_000).unref?.();
      }
    }
  }

  rebalanceQualityLimits() {
    const active = [...this.instances.values()].filter(x => !["ended", "stopping"].includes(x.state));
    const quality = resolveQualityProfile(this.policies.performance, active.length);
    for (const instance of active) {
      instance.qualityProfile = quality?.name || "original";
      instance.qualityLimit = quality ? { width: Number(quality.resX), height: Number(quality.resY) } : null;
      this.onQualityLimitChanged(instance);
    }
  }

  learnGpuIncrement(instance) {
    if (instance.state !== "running" || !Number.isFinite(instance.gpuBaselineUsedGB)) return;
    if ([...this.instances.values()].some(x => x.id !== instance.id && x.createdAt > instance.createdAt && !["ended", "stopping"].includes(x.state))) { this.logger.warn("gpu.increment_sample_skipped", { instanceId: instance.id, projectId: instance.projectId, reason: "newer_instance_overlap" }); return; }
    const snapshot = readGpuSnapshot(); if (!snapshot) return;
    const incrementGB = Math.round(Math.max(0, snapshot.usedGB - instance.gpuBaselineUsedGB) * 100) / 100;
    if (incrementGB < .25 || incrementGB > snapshot.totalGB * .8) { this.logger.warn("gpu.increment_sample_rejected", { instanceId: instance.id, projectId: instance.projectId, incrementGB, totalGB: snapshot.totalGB }); return; }
    const profileName = instance.qualityProfile || "original", metadata = instance.project.metadata ||= {}, profiles = metadata.gpuIncrementProfiles ||= {}, previous = profiles[profileName] || {};
    const historicalPeakGB = Math.max(Number(previous.historicalPeakGB) || 0, incrementGB), suggestedGB = Math.min(Math.ceil((historicalPeakGB + .5) * 2) / 2, Math.floor(snapshot.totalGB * .8 * 2) / 2);
    profiles[profileName] = { samples: (Number(previous.samples) || 0) + 1, lastIncrementGB: incrementGB, historicalPeakGB, suggestedGB, updatedAt: new Date().toISOString() };
    this.logger.info("gpu.increment_learned", { instanceId: instance.id, projectId: instance.projectId, profileName, baselineUsedGB: instance.gpuBaselineUsedGB, currentUsedGB: snapshot.usedGB, incrementGB, suggestedGB, samples: profiles[profileName].samples }); this.onGpuLearned(instance.project);
  }
}

export function resolveQualityProfile(config = {}, activeCount = 1) {
  const mode = String(config?.mode || "auto");
  if (mode === "original") return null;
  const profiles = config?.profiles || {};
  if (mode === "performance") return { name: "performance", ...(profiles.performance || { resX: 1920, resY: 1080, fps: 30, maxBitrateMbps: 30 }) };
  if (activeCount <= 1) return null;
  if (activeCount === 2) return { name: "balanced", ...(profiles.balanced || { resX: 1920, resY: 1080, fps: 30, maxBitrateMbps: 50 }) };
  return { name: "performance", ...(profiles.performance || { resX: 1920, resY: 1080, fps: 30, maxBitrateMbps: 30 }) };
}

export function resolveProjectStreamingProtocol(project = {}) {
  return resolveStreamingProtocol(project);
}

export function applyQualityProfile(args, profile, project = {}) {
  const managed = ["-ResX=", "-ResY=", "-PixelStreamingWebRTCFps=", "-PixelStreamingWebRTCMaxFps=", "-PixelStreamingWebRTCMaxBitrate="];
  const result = args.filter(value => !managed.some(prefix => String(value).toLowerCase().startsWith(prefix.toLowerCase())));
  const source = profile || {
    resX: readArgumentNumber(args, ["-ResX="]), resY: readArgumentNumber(args, ["-ResY="]),
    fps: readArgumentNumber(args, ["-PixelStreamingWebRTCFps=", "-PixelStreamingWebRTCMaxFps="]),
    maxBitrateMbps: readArgumentNumber(args, ["-PixelStreamingWebRTCMaxBitrate="]) / 1_000_000
  };
  if (source.resX) result.push(`-ResX=${source.resX}`);
  if (source.resY) result.push(`-ResY=${source.resY}`);
  // WebRTCFps is understood by both the original plugin and Pixel Streaming 2.
  // Pixel Streaming 2 rejects the newer-looking WebRTCMaxFps spelling and stays at 60 FPS.
  if (source.fps) result.push(`-PixelStreamingWebRTCFps=${source.fps}`);
  if (source.maxBitrateMbps) result.push(`-PixelStreamingWebRTCMaxBitrate=${Number(source.maxBitrateMbps) * 1_000_000}`);
  return mergeExecCommands(result, source.fps && usesLegacyFpsArgument(project) ? { "t.MaxFPS": source.fps } : {});
}

export function usesLegacyFpsArgument(project = {}) {
  const match = String(project?.metadata?.ueVersion || project?.ueVersion || "").match(/^(\d+)(?:\.(\d+))?/);
  if (!match) return false;
  const major = Number(match[1]), minor = Number(match[2] || 0);
  return major < 5 || (major === 5 && minor <= 3);
}

function readArgumentNumber(args, prefixes) {
  for (const value of args || []) for (const prefix of prefixes) if (String(value).toLowerCase().startsWith(prefix.toLowerCase())) return Number(String(value).slice(prefix.length)) || 0;
  return 0;
}

export function hasGpuCapacity(snapshot, requestedGB) { const hardLimit = Number(snapshot.hardLimitGB ?? snapshot.safeGB ?? Math.min(Number(snapshot.totalGB) * .95, Number(snapshot.totalGB) - .5)); return Number(snapshot.usedGB) + Number(requestedGB) <= hardLimit; }
export function estimatedIncrementGB(project, profileName) { const profile = project?.metadata?.gpuIncrementProfiles?.[profileName]; const peak = Number(profile?.historicalPeakGB); if (peak > 0) return Math.ceil((peak + .5) * 2) / 2; const learned = Number(profile?.suggestedGB); return learned > 0 ? learned : 3; }

export function shouldFallbackAv1(reasonCode) {
  return ["av1_negotiation_failed", "ue_start_failed", "ue_engine_connect_timeout", "ue_process_crashed", "pixel_streaming_plugin_missing"].includes(String(reasonCode || ""));
}

export function readGpuSnapshot() {
  try {
    const output = execFileSync("nvidia-smi.exe", ["--query-gpu=memory.total,memory.used", "--format=csv,noheader,nounits"], { encoding: "utf8", windowsHide: true, timeout: 3000 });
    const rows = output.split(/\r?\n/).filter(Boolean).map(line => line.split(",").map(x => Number(x.trim()) / 1024)).filter(x => x.length >= 2 && x[0] > 0).sort((a, b) => b[0] - a[0]);
    if (!rows.length) return null;
    const [totalGB, usedGB] = rows[0], safeGB = Math.floor(totalGB * .9 * 2) / 2, hardLimitGB = Math.max(safeGB, totalGB - .5); return { totalGB, usedGB, safeGB, hardLimitGB, remainingGB: Math.max(0, Math.floor((hardLimitGB - usedGB) * 2) / 2) };
  } catch { return null; }
}

export function engineTimeoutReason(instance) {
  // A detected system proxy is not evidence that it blocked this connection.
  return "ue_engine_connect_timeout";
}
