import { acceptConnectionDiagnostics, sessionConnectionDiagnostics } from "./connection-diagnostics.js";
import { resolveStreamingProtocol, resolveStreamingPlugin } from "../shared/streaming-compatibility.js";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { WebSocketServer } from "ws";
import { parseMessage, message, sendJson, Types } from "../shared/protocol.js";
import { clientAddress, createIceServers, hasValidTurnSecret, isPublicIngress, normalizeClientId, resolveIceTransportPolicy, shareFailureMessage, shareLeaseIds, validateActiveShare, validateShareGrant } from "./public-access.js";
import { BitratePolicyEngine } from "./bitrate-policy.js";
import { isAv1FallbackCooldownActive, markAv1FallbackCooldown, resolveCodecObservation } from "./codec-policy.js";
import { resolveCodecBitrateObservation } from "./codec-bitrate-policy.js";
import { InstanceManager } from "./instance-manager.js";
import { SessionManager } from "./session-manager.js";
import { UsageMeter } from "./usage-meter.js";
import { EditorEndpoints } from "./editor-endpoints.js";
import { loadGpuProfiles, saveGpuProfiles } from "./gpu-profile-store.js";

const SERVICE_VERSION = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;

export class SignalServer {
  constructor(config, logger, publicDir, configFile = null) {
    loadGpuProfiles(config, configFile);
    this.config = config;
    this.logger = logger;
    this.publicDir = publicDir;
    this.configFile = configFile;
    this.editorEndpoints = new EditorEndpoints(configFile ? path.join(path.dirname(configFile), 'editor-endpoints.json') : null, config.projects || []);
    if (config.publicAccess?.turn?.enabled === true && !hasValidTurnSecret(config)) this.logger.warn("turn.secret_missing", { message: "TURN Secret 缺失，本次仅使用 STUN/P2P。" });
    this.instances = new InstanceManager(config.projects || [], logger, { ...(config.instance || {}), performance: config.performance || {} });
    this.sessions = new SessionManager(config.session || {}, logger, this.instances);
    this.instances.onReady = instance => {
      this.sessions.rebind(instance);
      const protocol = resolvePixelStreamingProtocol(instance.project);
      if (protocol === "legacy" || instance.streamerRegistered === true) this.bindInstancePlayers(instance);
      else this.logger.info("instance.engine_waiting_for_endpoint_id", { instanceId: instance.id, projectId: instance.projectId });
    };
    this.instances.onStartFailed = (instance, reasonCode) => {
      for (const id of instance.players) {
        const session = this.sessions.sessions.get(id);
        if (!session) continue;
        session.connectionFailure = /^[a-z][a-z0-9_]{0,79}$/.test(reasonCode || '') ? reasonCode : 'ue_start_failed';
        session.connectionDiagnostics ||= { version: 1 };
        if (session.connectionDiagnostics.result !== 'success') session.connectionDiagnostics.result = 'failed';
        session.connectionDiagnostics.stage = 'ended';
        void this.sendRouteSession(session, true);
      }
      void this.releaseLeaseForInstance(instance);
      setTimeout(() => { if (this.waiting.length === 0) void this.instances.reconcilePreloadedInstances(instance.execueId); }, 1500).unref?.();
    };
    this.instances.onEnded = instance => { void this.stopLeaseBillingForInstance(instance, true); this.resetInstanceBillingSessions(instance); };
    this.instances.onProtocolFallback = (instance, protocol) => this.retryWithProtocol(instance, protocol);
    this.instances.onCodecFallback = (instance, codec) => this.retryWithCodec(instance, codec);
    this.instances.onCapacityAvailable = () => {
      if (this.waiting.length > 0) void this.processQueue();
      else void this.instances.reconcilePreloadedInstances();
    };
    this.instances.onAgentStatus = execueId => {
      if (this.waiting.length === 0) void this.instances.reconcilePreloadedInstances(execueId);
    };
    this.instances.onQualityLimitChanged = instance => this.publishQualityLimit(instance);
    this.instances.onGpuLearned = () => this.persistLearnedGpuProfiles();
    this.sessions.onPlayersChanged = instance => this.updateInputRoles(instance);
    this.instances.notifySession = (id, value) => {
      const session = this.sessions.sessions.get(id);
      if (session && value.type === Types.Lifecycle && ['stopping', 'ended'].includes(value.state)) {
        session.connectionEndReason = value.reasonCode;
      }
      sendJson(session?.socket, value);
    };
    this.roles = { player: new WebSocketServer({ noServer: true }), engine: new WebSocketServer({ noServer: true }), execue: new WebSocketServer({ noServer: true }), admin: new WebSocketServer({ noServer: true }) };
    this.http = http.createServer((req, res) => this.handleHttp(req, res));
    this.http.on("upgrade", (req, socket, head) => this.handleUpgrade(req, socket, head));
    this.heartbeat = setInterval(() => this.pingAll(), 15_000);
    this.waiting = [];
    this.shareReservations = new Map();
    this.shareReservationCreatedAt = new Map();
    this.publicAttempts = new Map();
    this.billingStopTimers = new Map();
    this.av1FallbackCooldowns = new Map();
    this.bitratePolicy = new BitratePolicyEngine(config.bitrateControl || config.publicAccess?.bitratePolicy || {});
    const costProtection = config.publicAccess?.costProtection || {};
    const configDirectory = path.dirname(configFile || process.cwd());
    const usageFile = path.resolve(configDirectory, costProtection.usageFile || path.join(config.logging?.directory || "../logs/source", "public-usage.json"));
    this.usage = new UsageMeter({ ...costProtection, stateFile: usageFile }, logger);
    this.queueProcessing = false;
    this.queueTimer = setInterval(() => { if (this.waiting.length > 0) { this.enforceFairUse(); void this.processQueue(); } }, 2_000);
    this.queueTimer.unref?.();
    this.publicAccessTimer = setInterval(() => { this.refreshPublicAccessConfig(); this.refreshProjectsConfig(); }, 2_000);
    this.publicAccessTimer.unref?.();
    this.reservationCleanupTimer = setInterval(() => this.cleanupShareReservations(), 15_000);
    this.reservationCleanupTimer.unref?.();
  }

  /**
   * 热重载项目登记：启动器在服务运行期间会往 signal.json 追加/关闭项目（多项目并发场景），
   * 服务只在启动时读一次配置，这里轮询文件并在项目列表变化时更新实例管理器、拉起新项目的预热实例。
   * 端口 / token / 会话策略等其它字段的改动仍然需要重启服务。
   */
  refreshProjectsConfig() {
    if (!this.configFile) return;
    try {
      const current = JSON.parse(fs.readFileSync(this.configFile, "utf8"));
      if (!Array.isArray(current?.projects)) return;
      const before = JSON.stringify(this.config.projects || []);
      const after = JSON.stringify(current.projects);
      if (before === after) return;
      this.config.projects = current.projects;
      this.instances.setProjects(current.projects);
      this.logger.info("config.projects_reloaded", {
        projects: current.projects.length,
        preload: current.projects.filter(x => x.metadata?.preload === true).map(x => x.id),
      });
      void this.instances.reconcilePreloadedInstances();
    } catch (error) {
      this.logger.warn("config.projects_reload_failed", { detail: error.message });
    }
  }

  refreshPublicAccessConfig() {
    if (!this.configFile) return;
    try {
      const current = JSON.parse(fs.readFileSync(this.configFile, "utf8"));
      const wasEnabled = this.config.publicAccess?.enabled === true;
      if (current?.publicAccess) this.config.publicAccess = current.publicAccess;
      const invalidSessions = [...this.sessions.sessions.values()].filter(x => x.shareId).map(session => ({ session, result: validateActiveShare(session.shareId, this.config, session.shareExpiresAt) })).filter(x => !x.result.ok);
      if ((wasEnabled && this.config.publicAccess?.enabled !== true) || invalidSessions.length > 0) {
        for (const { session, result } of invalidSessions) {
          sendJson(session.socket, message(Types.Lifecycle, { state: "ended", projectId: session.projectId, instanceId: session.instanceId, reasonCode: result.reason, message: shareFailureMessage(result.reason) }));
          setTimeout(() => session.socket.close(1008, "public access disabled"), 100).unref?.();
        }
        if (invalidSessions.length) this.logger.warn("public_access.sessions_revoked", { sessions: invalidSessions.length, reasons: [...new Set(invalidSessions.map(x => x.result.reason))] });
      }
    } catch (error) { this.logger.warn("public_access.reload_failed", { detail: error.message }); }
  }

  persistLearnedGpuProfiles() {
    if (!this.configFile) return;
    try { saveGpuProfiles(this.config, this.configFile); }
    catch (error) { this.logger.warn("gpu.increment_persist_failed", { detail: error.message }); }
  }

  authorize(req, role) {
    this.refreshPublicAccessConfig();
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const publicIngress = isPublicIngress(req, this.config);
    const playerIps = this.config.security?.allowedPlayerIps;
    if (role === "player" && Array.isArray(playerIps) && playerIps.length && !playerIps.includes(clientAddress(req, this.config))) return false;
    if (publicIngress && role === "player" && url.searchParams.get("share")) {
      const address = clientAddress(req, this.config);
      if (!this.allowPublicAttempt(address)) { req.shareFailure = "public_rate_limited"; return false; }
      const grant = validateShareGrant(url.searchParams.get("share"), this.config);
      if (!grant.ok || grant.projectId !== url.searchParams.get("project")) { req.shareFailure = grant.reason; return false; }
      const clientId = this.validClientId(url.searchParams.get("client"));
      if (!clientId) { req.shareFailure = "share_invalid"; return false; }
      const leaseKeys = shareLeaseIds(this.sessions.sessions.values(), this.shareReservations, grant.id);
      const online = leaseKeys.size;
      if (leaseKeys.has(clientId)) req.shareReconnect = true;
      if (!req.shareReconnect && online >= grant.maxOnline) { req.shareFailure = "share_online_limit"; return false; }
      if (!req.shareReconnect && !this.usage.canAcceptPublic(this.sessions.sessions.values(), this.shareReservations.size)) { req.shareFailure = "public_capacity_reached"; return false; }
      const reservation = `${grant.id}:${clientId}`;
      this.shareReservations.set(reservation, (this.shareReservations.get(reservation) || 0) + 1);
      this.shareReservationCreatedAt.set(reservation, Date.now());
      req.shareReservation = reservation;
      req.clientId = clientId;
      req.shareReservationTimer = setTimeout(() => this.releaseShareReservation(req), 10_000);
      req.shareReservationTimer.unref?.();
      req.shareGrant = grant;
      return true;
    }
    const supplied = url.searchParams.get("token") || String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const readOnly = role === "player" && url.searchParams.get("viewOnly") === "1";
    const expected = readOnly ? this.config.auth?.viewerToken : this.config.auth?.[`${role}Token`];
    const staticTokenValid = typeof expected === "string" && expected.length >= 12 && supplied === expected;
    const ticket = role === "engine" ? authorizeEngineTicket(url, this.instances) : { allowed: false, reasonCode: "not_engine" };
    const engineParts = url.pathname.split('/').filter(Boolean);
    if (role === 'engine' && engineParts[2] === 'editor') {
      const projectId = safeDecodeURIComponent(engineParts[1]);
      const project = this.instances.projects.get(projectId);
      const credential = engineParts[3]?.startsWith('token=') ? safeDecodeURIComponent(engineParts[3].slice(6)) : '';
      if (publicIngress || !project?.enabled || project.runtimeMode !== 'external-editor' || !this.editorEndpoints.accepts(projectId, credential)) return false;
      if (this.instances.list().some(x => x.projectId === projectId && x.externalEditor && x.engine)) return false;
      req.editorProjectId = projectId;
      return true;
    }
    if (!staticTokenValid && !ticket.allowed) {
      if (role === "engine") {
        req.engineAuthFailure = ticket.reasonCode;
        this.logger.warn("instance.engine_upgrade_rejected", { projectId: ticket.projectId || null, instanceId: ticket.instanceId || null, reasonCode: ticket.reasonCode });
      }
      return false;
    }
    if (ticket.allowed) req.engineAuthMode = "instance_ticket";
    if (publicIngress && role !== "player") return false;
    const address = clientAddress(req, this.config);
    if (role === "admin" && this.config.security?.adminLocalOnly !== false && !["127.0.0.1", "::1"].includes(address)) return false;
    const allowed = this.config.security?.allowedPlayerIps;
    if (role === "player" && Array.isArray(allowed) && allowed.length > 0 && !allowed.includes(address)) return false;
    return true;
  }

  validClientId(value) { return normalizeClientId(value); }

  releaseShareReservation(req) {
    clearTimeout(req?.shareReservationTimer);
    const id = req?.shareReservation; if (!id) return;
    const next = Math.max(0, (this.shareReservations.get(id) || 0) - 1);
    if (next) this.shareReservations.set(id, next); else this.shareReservations.delete(id);
    if (!next) this.shareReservationCreatedAt.delete(id);
    req.shareReservation = null;
  }

  cleanupShareReservations(now = Date.now()) {
    for (const [id, createdAt] of this.shareReservationCreatedAt) if (now - createdAt > 15_000) {
      this.shareReservationCreatedAt.delete(id); this.shareReservations.delete(id);
      this.logger.warn("public.share_reservation_expired", { shareId: id.split(":", 1)[0] });
    }
  }

  allowPublicAttempt(address, now = Date.now()) {
    const windowMs = Math.max(10, Number(this.config.publicAccess?.limits?.windowSeconds) || 60) * 1000;
    const maximum = Math.max(1, Number(this.config.publicAccess?.limits?.maxConnectionsPerIp) || 10);
    const recent = (this.publicAttempts.get(address) || []).filter(value => now - value < windowMs);
    if (recent.length >= maximum) { this.publicAttempts.set(address, recent); return false; }
    recent.push(now); this.publicAttempts.set(address, recent);
    if (this.publicAttempts.size > 1000) for (const [key, values] of this.publicAttempts) if (!values.some(value => now - value < windowMs)) this.publicAttempts.delete(key);
    return true;
  }

  handleUpgrade(req, socket, head) {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    let role = url.pathname.split("/")[1] || "";
    // PixelStreaming2/EpicRtc may dial a root URL and drop the /engine/<p>/<i> path.
    // Recover identity from the query string so those clients still bind to the instance.
    if (!this.roles[role]) {
      const qProject = url.searchParams.get("project") || "";
      const qInstance = url.searchParams.get("instance") || url.searchParams.get("instanceId") || "";
      const qToken = url.searchParams.get("token") || "";
      if (qProject && qInstance) {
        role = "engine";
        url.pathname = `/engine/${encodeURIComponent(qProject)}/${encodeURIComponent(qInstance)}`;
        if (!url.searchParams.has("token") && qToken) url.searchParams.set("token", qToken);
      } else {
        // Official-style ws://host:port — no path required. Bind the sole pending instance.
        const remote = String(req.socket?.remoteAddress || "");
        const isLocal = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
        const pending = this.instances.list().filter(x => ["starting", "recovering"].includes(x.state) && !x.engine);
        const tokenOk = !qToken || qToken === this.config.auth?.engineToken;
        if (isLocal && tokenOk && pending.length === 1) {
          const starting = pending[0];
          role = "engine";
          url.pathname = `/engine/${encodeURIComponent(starting.projectId)}/${encodeURIComponent(starting.id)}`;
          url.searchParams.set("project", starting.projectId);
          url.searchParams.set("instance", starting.id);
          if (!url.searchParams.get("token")) url.searchParams.set("token", this.config.auth?.engineToken || "");
          this.logger.info("signal.engine_bound_by_ip", { projectId: starting.projectId, instanceId: starting.id, remote });
        }
      }
    }
    this.logger.info("signal.upgrade", { path: url.pathname, role: role || null, query: Object.fromEntries(url.searchParams), host: req.headers.host || "" });
    const server = this.roles[role];
    if (!server || !this.authorize(req, role)) {
      this.logger.warn("signal.upgrade_rejected", { path: url.pathname, role: role || null, remote: req.socket?.remoteAddress || "" });
      return socket.destroy();
    }
    server.handleUpgrade(req, socket, head, ws => {
      ws.isAlive = true;
      ws.on("pong", () => { ws.isAlive = true; });
      if (role === "player") this.handlePlayer(ws, req, url);
      if (role === "engine") {
        if (req.editorProjectId) {
          if (this.editorEndpoints.isPaused(req.editorProjectId)) return ws.close(1008, 'editor access paused');
          // Recheck after the upgrade: never replace an already connected editor.
          if (this.instances.list().some(x => x.projectId === req.editorProjectId && x.externalEditor && x.engine)) return ws.close(1008, 'editor already connected');
          this.instances.projects.get(req.editorProjectId).persistentEditorConnection = true;
          const instance = this.instances.prepareExternalEditor(req.editorProjectId);
          url.pathname = `/engine/${encodeURIComponent(req.editorProjectId)}/${instance.id}`;
        }
        this.handleEngine(ws, req, url);
      }
      if (role === "execue") this.handleExecue(ws, req, url);
      if (role === "admin") this.handleAdmin(ws);
    });
  }

  async handlePlayer(ws, req, url) {
    this.releaseShareReservation(req);
    const projectId = url.searchParams.get("project") || "";
    if (!this.instances.projects.has(projectId)) return ws.close(1008, "unknown project");
    const project = this.instances.projects.get(projectId);
    if (project.runtimeMode === "external-editor" && !this.instances.list().some(x => x.projectId === projectId && x.externalEditor && x.state === "running" && x.streamerRegistered)) {
      sendJson(ws, message(Types.Lifecycle, { state: "ended", projectId, reasonCode: "editor_not_connected", message: "请先在 Launcher 准备编辑器接入，再在 UE 中点击流送关卡编辑器。" }));
      return setTimeout(() => ws.close(1008, "editor not connected"), 300);
    }
    const pixelStreamingProtocol = resolvePixelStreamingProtocol(project);
    const readOnly = req.shareGrant?.readOnly === true || url.searchParams.get("viewOnly") === "1";
    const address = clientAddress(req, this.config);
    const clientCapabilities = parseClientCapabilities(url);
    const publicIngress = isPublicIngress(req, this.config) || Boolean(req.shareGrant);
    const clientId = req.clientId || this.validClientId(url.searchParams.get("client"));
    const codecProject = { ...project, codecPolicy: { ...(this.config.codecSelection || {}), ...(project.codecPolicy || {}) } };
    if (project.runtimeMode === "external-editor") Object.assign(codecProject.codecPolicy, { allowAutomaticAv1: false, experimentalAv1: false });
    const codecObservation = resolveCodecObservation({ client: clientCapabilities, agent: this.instances.getAgentCapabilities(project.execueId), project: codecProject, accessScope: publicIngress ? "public" : "lan", av1Cooldown: isAv1FallbackCooldownActive(this.av1FallbackCooldowns, projectId, clientId) });
    let resumeInstance = null;
    const tabId = this.validClientId(url.searchParams.get("tab"));
    if (req.shareGrant && clientId) {
      const previous = findReconnectSession(this.sessions.sessions.values(), req.shareGrant.id, clientId, tabId);
      if (previous) {
        resumeInstance = this.sessions.replaceForReconnect(previous);
        this.dequeue(previous);
        previous.socket.close(1000, "same device reconnected");
        this.logger.info("session.resume_succeeded", { projectId, instanceId: resumeInstance?.id || null, clientId: clientId.slice(0, 8), addressChanged: previous.address !== address });
      }
    }
    if (!readOnly && this.config.session?.strictMatchIP === true) {
      const matches = [...this.sessions.sessions.values()].filter(x => !x.readOnly && x.address === address);
      for (const duplicate of matches.filter(x => !x.instanceId)) { this.dequeue(duplicate); duplicate.socket.close(1000, "replaced by newer request"); }
      const active = matches.find(x => x.instanceId), activeInstance = active ? this.instances.get(active.instanceId) : null;
      if (active && active.projectId === projectId && this.config.deployment?.mode === "lan-exclusive" && activeInstance) {
        resumeInstance = this.sessions.replaceForReconnect(active); active.socket.close(1000, "reconnected from same device");
      } else if (active) { const existingProject = this.instances.projects.get(active.projectId); sendJson(ws, message(Types.Lifecycle, { state: "ended", projectId, projectName: project.name || projectId, reasonCode: "ip_instance_limit", existingProjectId: active.projectId, existingProjectName: existingProject?.name || active.projectId, message: "当前设备已有项目正在运行。为避免重复占用服务器资源，同一访问来源暂时只能运行一个项目。" })); return setTimeout(() => ws.close(1008, "one instance per IP"), 300); }
    }
    const maxSessionMinutes = publicIngress ? this.usage.options.maxSessionMinutes : undefined;
    const session = this.sessions.add(ws, req, projectId, { readOnly, address, publicIngress, leaseId: publicIngress ? this.config.publicAccess?.billing?.leaseId : null, shareId: req.shareGrant?.id, clientId, tabId, shareExpiresAt: req.shareGrant?.expiresAt, maxSessionMinutes });
    session.connectionDiagnostics = { version: 1, stage: "starting", result: "connecting" };
    void this.sendRouteSession(session, false);
    session.clientCapabilities = clientCapabilities; session.codecObservation = codecObservation; session.av1BitrateFactor = codecObservation.currentCodec === "AV1" ? clientCapabilities.av1BitrateFactor : 1;
    sendJson(ws, message(Types.Hello, { role: "player", sessionId: session.id, projectId, projectName: project.name || projectId, pixelStreamingProtocol, pixelStreamingPlugin: resolveStreamingPlugin(project), bitrateProfile: project.bitrateProfile || "auto", adaptiveResolution: this.config.rendering?.adaptiveResolution !== false, screenPercentage: this.config.rendering?.screenPercentage || 0, qualityTiers: this.config.bitrateControl?.qualityTiers || {}, readOnly, serverVersion: SERVICE_VERSION, webVersion: SERVICE_VERSION, codecObservation }));
    this.logger.info("codec.selection_observed", { sessionId: session.id, projectId, execueId: project.execueId, ...codecObservation });
    sendJson(ws, message(Types.Lifecycle, { state: "starting", sessionId: session.id, projectId, projectName: project.name || projectId }));
    session.requestedCodec = codecObservation.currentCodec;
    if (resumeInstance && (resumeInstance.codec || "H264") !== session.requestedCodec) {
      await this.instances.stop(resumeInstance.id, "codec_switch_requested");
      resumeInstance = null;
    }
    let instance = resumeInstance && (resumeInstance.codec || "H264") === session.requestedCodec && this.instances.canAccept(resumeInstance, this.config.session?.mode, session, this.config.session?.maxSharedPlayers) ? resumeInstance : this.instances.findAvailable(projectId, this.config.session?.mode, session.requestedCodec, session, this.config.session?.maxSharedPlayers);
    if (instance?.recoveryOwner === session.recoveryKey && instance.recoveryDeadline) {
      session.maximumDeadline = instance.recoveryDeadline;
      this.sessions.scheduleMaximumDuration(session);
    }
    if (session.maximumDeadline && session.maximumDeadline <= Date.now()) {
      session.instanceId = instance?.id || null;
      await this.sessions.expire(session, "max_session_duration");
      return;
    }
    const startupActiveCount = this.instances.list().filter(x => !["ended", "stopping"].includes(x.state)).length + 1;
    const startupMaximumMbps = this.config.rendering?.maxBitrateMbps || 50;
    const startupPolicy = this.bitratePolicy?.evaluate({ accessScope: publicIngress ? "public" : "lan", activeCount: startupActiveCount, maximumMbps: startupMaximumMbps, mobile: clientCapabilities.mobile === true }) || { recommendedLimitMbps: startupMaximumMbps };
    session.startupBitrateMbps = startupPolicy.recommendedLimitMbps;
    try { instance ||= await this.instances.allocate(projectId, { codec: session.requestedCodec, startupBitrateMbps: session.startupBitrateMbps }); } catch (error) { if (error.code === "gpu_capacity_insufficient") this.enqueue(session, error.capacity); else { session.connectionFailure = "allocation_failed"; session.connectionDiagnostics = { version: 1, stage: "failed", result: "failed" }; sendJson(ws, message(Types.Error, { code: "allocation_failed" })); void this.sendRouteSession(session, false); } }
    if (instance && ["starting", "recovering", "running"].includes(instance.state)) { session.instanceId = instance.id; instance.players.add(session.id); this.instances.cancelDisconnectedStop(instance.id); this.sessions.onPlayersChanged(instance); if (instance.state === "running") this.bindPlayer(session, instance); }
    ws.on("message", data => this.handlePlayerMessage(session, data));
    ws.on("close", (code, reason) => {
      const closeReason = Buffer.isBuffer(reason) ? reason.toString("utf8") : String(reason || "");
      this.logger.warn("player.websocket_closed", { sessionId: session.id, instanceId: session.instanceId, projectId: session.projectId, address: session.address, code, reason: closeReason || "none" });
      const usage = this.usage.finish(session);
      const reasonCode = session.forcedCloseReason || "player_disconnected";
      this.logger.info("session.summary", { sessionId: session.id, instanceId: session.instanceId, projectId: session.projectId, durationSeconds: Math.max(0, Math.round((Date.now() - session.connectedAt) / 1000)), clientId: session.clientId?.slice(0, 8) || null, firstMediaMs: session.firstMediaAt ? session.firstMediaAt - session.connectedAt : null, lastState: session.lastTelemetry?.state || null, connectionType: session.lastTelemetry?.connectionType || null, transportProtocol: session.lastTelemetry?.transportProtocol || null, targetWidth: session.lastTelemetry?.targetWidth || null, targetHeight: session.lastTelemetry?.targetHeight || null, recoveryAttempts: session.recoveryAttempts || 0, fullscreen: session.fullscreen ?? null, orientationLocked: session.orientationLocked ?? null, closeCode: code, reasonCode, ...usage });
      void this.sendRouteSession(session, true);
      this.dequeue(session);
      // remove() synchronously removes the viewer before awaiting UE shutdown.
      const removal = this.sessions.remove(session, reasonCode, Boolean(session.forcedCloseReason));
      this.scheduleBillingStop(session.leaseId);
      void removal.catch(error => this.logger.warn("session.remove_failed", { sessionId: session.id, detail: error.message }));
    });

  }

  endForCostProtection(session, reasonCode) {
    if (!session || session.forcedCloseReason) return;
    const messages = {
      turn_capacity_reached: "TURN 中继当前已达到并发上限，请稍后重试或切换到可直连网络。",
      public_telemetry_timeout: "连接状态长时间未更新，本次公网访问已结束，请刷新后重试。",
      turn_daily_budget_exhausted: "今日 TURN 中继流量额度已用完，系统已停止新的中继会话。"
    };
    session.forcedCloseReason = reasonCode;
    const detail = messages[reasonCode] || "公网成本保护策略已结束当前会话。";
    this.logger.warn("cost_protection.session_ended", { sessionId: session.id, instanceId: session.instanceId, projectId: session.projectId, reasonCode, route: session.usageRoute });
    sendJson(session.socket, message(Types.Lifecycle, { state: "ended", sessionId: session.id, instanceId: session.instanceId, projectId: session.projectId, reasonCode, message: detail }));
    setTimeout(() => session.socket.close(1008, reasonCode), 250).unref?.();
  }

  enqueue(session, capacity) {
    session.queued = true;
    if (!this.waiting.includes(session)) this.waiting.push(session);
    session.timers.forEach(clearTimeout); session.timers = [];
    clearTimeout(session.queueTimeout);
    const maxWaitMinutes = Number(this.config.session?.queueMaxWaitMinutes) || 0;
    if (maxWaitMinutes > 0) { session.queueTimeout = setTimeout(() => { this.dequeue(session); sendJson(session.socket, message(Types.Lifecycle, { state: "ended", sessionId: session.id, projectId: session.projectId, reasonCode: "queue_wait_timeout", message: "排队等待时间已超过上限，本次请求已自动取消。" })); setTimeout(() => session.socket.close(1000, "queue wait timeout"), 300); }, maxWaitMinutes * 60_000); session.queueTimeout.unref?.(); }
    this.logger.warn("session.queued", { sessionId: session.id, projectId: session.projectId, position: this.waiting.indexOf(session) + 1, capacity });
    this.publishQueue();
  }

  dequeue(session) { session.queued = false; clearTimeout(session.queueTimeout); session.queueTimeout = null; const index = this.waiting.indexOf(session); if (index >= 0) { this.waiting.splice(index, 1); this.publishQueue(); } }

  publishQueue() { this.waiting.forEach((session, index) => { const project = this.instances.projects.get(session.projectId); sendJson(session.socket, message(Types.Lifecycle, { state: "queued", sessionId: session.id, projectId: session.projectId, projectName: project?.name || session.projectId, queuePosition: index + 1, queueLength: this.waiting.length, queueStartedAt: session.connectedAt, reasonCode: "gpu_capacity_insufficient" })); }); }

  enforceFairUse() {
    const limitMinutes = Number(this.config.session?.queueFairUseMinutes) || 0, warningSeconds = Math.max(10, Number(this.config.session?.fairUseWarningSeconds) || 300);
    if (limitMinutes <= 0) return;
    const now = Date.now();
    for (const instance of this.instances.list().filter(x => x.state === "running" && x.players.size > 0 && now - x.createdAt >= limitMinutes * 60_000)) {
      if (instance.fairUseTimer) continue;
      for (const sessionId of instance.players) this.instances.notifySession(sessionId, message(Types.Lifecycle, { state: "fair_use_warning", instanceId: instance.id, projectId: instance.projectId, projectName: instance.project?.name || instance.projectId, remainingSeconds: warningSeconds, reasonCode: "queue_fair_use_limit" }));
      instance.fairUseDeadline = now + warningSeconds * 1000; instance.fairUseTimer = setTimeout(() => this.instances.stop(instance.id, "queue_fair_use_limit"), warningSeconds * 1000); instance.fairUseTimer.unref?.();
      this.logger.warn("instance.fair_use_warning", { instanceId: instance.id, projectId: instance.projectId, warningSeconds, waiting: this.waiting.length });
    }
  }

  async processQueue() {
    if (this.queueProcessing) return;
    const session = this.waiting[0]; if (!session || !this.sessions.sessions.has(session.id)) { if (session) this.dequeue(session); return; }
    this.queueProcessing = true;
    try {
      const instance = this.instances.findAvailable(session.projectId, this.config.session?.mode, session.requestedCodec || "H264", session, this.config.session?.maxSharedPlayers) || await this.instances.allocate(session.projectId, { codec: session.requestedCodec || "H264", startupBitrateMbps: session.startupBitrateMbps });
      this.dequeue(session);
      session.instanceId = instance.id;
      instance.players.add(session.id);
      this.instances.cancelDisconnectedStop(instance.id);
      this.sessions.onPlayersChanged(instance);
      this.sessions.scheduleIdle(session);
      const project = this.instances.projects.get(session.projectId);
      sendJson(session.socket, message(Types.Lifecycle, { state: "starting", sessionId: session.id, instanceId: instance.id, projectId: session.projectId, projectName: project?.name || session.projectId, reasonCode: "queue_capacity_available" }));
      if (instance.state === "running") this.bindPlayer(session, instance);
      this.logger.info("session.dequeued", { sessionId: session.id, projectId: session.projectId, instanceId: instance.id });
      setTimeout(() => this.processQueue(), 500).unref?.();
    } catch (error) { if (error.code !== "gpu_capacity_insufficient") { this.dequeue(session); session.connectionFailure = "allocation_failed"; session.connectionDiagnostics = { version: 1, stage: "failed", result: "failed" }; sendJson(session.socket, message(Types.Error, { code: "allocation_failed" })); void this.sendRouteSession(session, false); } }
    finally { this.queueProcessing = false; }
  }

  handlePlayerMessage(session, data) {
    if (!this.sessions.sessions.has(session.id) || session.terminalReason || session.forcedCloseReason) return;
    let value;
    try { value = parseMessage(data); } catch { return; }
    const periodicCodecSample = value.type === "codec.bitrate.sample";
    if (periodicCodecSample) value.type = Types.SessionTelemetry;
    if (value.type === "session.diagnostics") {
      if (acceptConnectionDiagnostics(session, value) && session.publicIngress) {
        const first = session.connectionDiagnostics.result === "success" && !session.firstFrameReported;
        if (first || Date.now() - (session.routeReportedAt || 0) >= 15000) {
          session.firstFrameReported = first || session.firstFrameReported;
          void this.sendRouteSession(session, false);
        }
      }
      return;
    }
    if (value.type === Types.Pong) return;
    if (value.type === Types.SessionActivity) return this.sessions.activity(session);
    if (value.type === "codecFallbackRequest") {
      const active = this.instances.get(session.instanceId);
      if (active?.codec === "AV1" && !active.codecFallbackAttempted) {
        if (active.codecFallbackRequested) return;
        active.codecFallbackRequested = true;
        active.codecFallbackReason = "client_negotiation_failed";
        this.logger.warn("codec.fallback_requested", { sessionId: session.id, instanceId: active.id, projectId: session.projectId, reason: String(value.reason || "client_negotiation_failed").slice(0, 80) });
        this.instances.stop(active.id, "av1_negotiation_failed");
      }
      return;
    }
    if (value.type === Types.SessionTelemetry) {
      const allowed = ["negotiatedCodec", "qualityMode", "qualityLimitReason", "state", "reason", "samplePhase", "sampleSequence", "stallMs", "hidden", "ws", "peer", "ice", "dataChannel", "track", "audioTrack", "audioPlayback", "audioError", "fps", "bitrateMbps", "bitrateAppliedMbps", "bitrateMeasuredMbps", "bitrateAverageMbps", "bitratePeakMbps", "bitrateExcessPercent", "bitrateExcessSeconds", "bitrateObservationStatus", "bitrateCommandSentAt", "bitrateEncoderTargetApplied", "averageQp", "bitsPerPixelFrame", "qualityTier", "projectBitrateProfile", "effectiveBitrateLimitMbps", "sampleIntervalMs", "connectionReceiveBytesPerSecond", "connectionSendBytesPerSecond", "connectionSampleIntervalMs", "inboundVideoBytesPerSecond", "inboundAuxiliaryBytesPerSecond", "inboundAudioBytesPerSecond", "retransmittedVideoBytesPerSecond", "mediaHeaderBytesPerSecond", "dataChannelReceiveBytesPerSecond", "connectionOtherBytesPerSecond", "bitrateCommandStatus", "bitrateCommandError", "videoWidth", "videoHeight", "framesDecoded", "framesDropped", "packetsLost", "packetsReceivedDelta", "packetsLostDelta", "framesDecodedDelta", "framesDroppedDelta", "rttMs", "recoveryMs", "recoveryAttempt", "fullscreen", "orientationLocked", "fullscreenError", "fullscreenResult", "orientationResult", "playResult", "errorName", "targetWidth", "targetHeight", "connectionType", "transportProtocol", "localCandidateType", "remoteCandidateType", "networkType", "relayProtocol", "p2pDirectCandidatePairs", "platform", "browser", "deviceClass", "container", "isWechat", "fullscreenSupported", "orientationLockSupported", "videoPlayResult", "videoPlayErrorName", "videoReadyState", "videoPaused", "videoTrackState", "loadingState", "loadingReason"];
      const fields = { ueVersion: this.instances.projects.get(session.projectId)?.metadata?.ueVersion || "unknown", sessionId: session.id, instanceId: session.instanceId, projectId: session.projectId, currentCodec: session.codecObservation?.currentCodec || "H264" };
      for (const key of allowed) if (["string", "number", "boolean"].includes(typeof value[key])) fields[key] = value[key];
      this.logger.info(periodicCodecSample ? "player.codec_bitrate_received" : "player.media_health", fields);
      session.lastTelemetry = fields;
      if (/^(TURN|P2P)/i.test(String(value.connectionType || ""))) session.lastRouteTelemetryAt = Date.now();
      const mediaEvidence = Number(value.fps) > 0 || Number(value.framesDecodedDelta) > 0 || value.track === "live";
      const firstMedia = !session.billingMediaAt && mediaEvidence;
      if (firstMedia) {
        session.billingMediaAt = Date.now();
        session.firstMediaAt ||= session.billingMediaAt;
      }
      if (session.billingMediaAt && (mediaEvidence || Date.now() - Number(session.mediaHealthyAt || 0) < 15_000)) void this.activateSessionBilling(session);
      if (Number(value.recoveryAttempt) > 0) session.recoveryAttempts = Math.max(session.recoveryAttempts || 0, Number(value.recoveryAttempt));
      if (typeof value.fullscreen === "boolean") session.fullscreen = value.fullscreen;
      if (typeof value.orientationLocked === "boolean") session.orientationLocked = value.orientationLocked;
      if ((value.state === "healthy" || value.state === "recovering") && (Number(value.fps) > 0 || Number(value.framesDecodedDelta) > 0 || value.peer === "connected" || value.ice === "connected")) session.mediaHealthyAt = Date.now();
      if (typeof value.connectionType === "string") {
        const previousRoute = session.publicRoute;
        this.sessions.updateRoute(session, value.connectionType);
        const activeCount = this.instances.list().filter(x => !["ended", "stopping"].includes(x.state)).length;
        const received = Math.max(0, Number(value.packetsReceivedDelta) || 0), lost = Math.max(0, Number(value.packetsLostDelta) || 0), decoded = Math.max(0, Number(value.framesDecodedDelta) || 0), dropped = Math.max(0, Number(value.framesDroppedDelta) || 0);
        const instance = this.instances.get(session.instanceId);
        const sample = { connectionType: value.connectionType, accessScope: resolveAccessScope(session, instance, this.sessions.sessions), localCandidateType: value.localCandidateType, remoteCandidateType: value.remoteCandidateType, activeCount, maximumMbps: Math.min(instance?.qualityBitrateMbps || Infinity, this.config.rendering?.maxBitrateMbps || 50), mobile: session.clientCapabilities?.mobile === true, qualityMode: value.qualityMode, rttMs: value.rttMs, bitrateMbps: value.bitrateMbps, framesDecodedDelta: decoded, lossRate: lost / Math.max(1, received + lost), dropRate: dropped / Math.max(1, decoded + dropped) };
        const policy = this.bitratePolicy.evaluate(sample, session.networkBitratePolicy);
        session.networkBitratePolicy = { ...policy };
        policy.mode = session.id === instance?.controlSessionId ? policy.mode : "observe";
        const factor = resolveAv1BitrateFactor(session, policy.route, this.config.bitrateControl || {});
        Object.assign(policy, resolveCodecBitrateObservation(policy.recommendedLimitMbps, instance?.codec || session.codecObservation?.currentCodec || "H264", this.config.bitrateControl || {}, factor.value));
        policy.codecFactorSource = factor.source;
        if (policy.codecFactorApplied) policy.recommendedLimitMbps = policy.codecAppliedLimitMbps;
        session.bitratePolicy = policy;
        this.usage.record(session, { route: policy.route, connectionType: value.connectionType, bitrateMbps: value.bitrateMbps, codec: policy.currentCodec });
        // Report after sampling, including unchanged routes. Failed reports retry on the next interval.
        if (session.publicIngress && (session.publicRoute !== previousRoute || Date.now() - (session.routeReportedAt || 0) >= 15000)) void this.sendRouteSession(session, false);
        const costViolation = this.usage.violation(session, this.sessions.sessions.values());
        if (costViolation) { this.endForCostProtection(session, costViolation); return; }
        sendJson(session.socket, message(Types.BitratePolicy, policy));
        const signature = `${policy.recommendedLimitMbps}:${policy.codecSuggestedLimitMbps}:${policy.reasonCode}:${policy.adaptiveState}`;
        if (session.bitratePolicySignature !== signature) {
          session.bitratePolicySignature = signature;
          this.logger.info(policy.mode === "auto" ? "bitrate.policy_requested" : "bitrate.policy_observed", { sessionId: session.id, instanceId: session.instanceId, projectId: session.projectId, connectionType: value.connectionType, activeCount, ...sample, ...policy });
        }
        if (!session.lastCodecBitrateSampleAt || Date.now() - session.lastCodecBitrateSampleAt >= 10_000) {
          session.lastCodecBitrateSampleAt = Date.now();
          const gpu = this.instances.getAgentCapabilities(instance?.execueId || instance?.project?.execueId) || {};
          const instanceAgeSeconds = Math.max(0, Math.round((Date.now() - Number(instance?.createdAt || Date.now())) / 1000));
          this.logger.info("codec.bitrate_sample", { sessionId: session.id, instanceId: session.instanceId, projectId: session.projectId, sampleSequence: Number(value.sampleSequence) || 0, samplePhase: value.samplePhase === "stable" && instanceAgeSeconds >= 20 ? "stable" : "warmup", comparisonEligible: value.samplePhase === "stable" && instanceAgeSeconds >= 20 && activeCount === 1, instanceAgeSeconds, currentCodec: policy.currentCodec, gpuName: gpu.gpuName || "unknown", gpuDriver: gpu.driverVersion || "unknown", accessScope: sample.accessScope, route: policy.route, routeLabel: policy.routeLabel, connectionType: value.connectionType, transportProtocol: value.transportProtocol || null, activeCount, videoWidth: Number(value.videoWidth) || null, videoHeight: Number(value.videoHeight) || null, fps: Number(value.fps) || 0, receivedBitrateMbps: Number(value.bitrateMbps) || 0, rttMs: Number(value.rttMs) || 0, lossRate: sample.lossRate, dropRate: sample.dropRate, networkLimitMbps: policy.networkLimitMbps, codecFactor: policy.codecFactor, codecSuggestedLimitMbps: policy.codecSuggestedLimitMbps, codecAppliedLimitMbps: policy.codecAppliedLimitMbps, codecFactorMode: policy.codecFactorMode, codecFactorApplied: policy.codecFactorApplied });
        }
      }
      return;
    }
    const instance = this.instances.get(session.instanceId);
    if (value.type === Types.SessionControlRequest && !session.readOnly && instance && this.config.session?.mode === "shared") {
      instance.controlSessionId = session.id;
      this.updateInputRoles(instance);
      return;
    }
    if (!instance?.engine) return;
    if (value.type === "iceCandidate") this.logger.info("ice.candidate", { direction: "player_to_engine", sessionId: session.id, instanceId: instance.id, projectId: session.projectId, ...summarizeIceCandidate(value.candidate) });
    if (["offer", "answer", "iceCandidate"].includes(value.type)) sendJson(instance.engine, { ...value, playerId: session.id });
  }

  handleEngine(ws, _req, url) {
    const parts = url.pathname.split("/").filter(Boolean);
    const projectId = parts[1], instanceId = parts[2];
    if (!projectId || !instanceId) return ws.close(1008, "engine path must be /engine/project/instance");
    if (["stopping", "stop_failed", "ended"].includes(this.instances.get(instanceId)?.state)) return ws.close(1008, "instance stop requested");
    // The UE peer must receive its ICE configuration before playerConnected.
    // Unified Plan creates the PeerConnection as soon as playerConnected arrives;
    // reversing this order leaves the UE side with host-only candidates.
    const instance = this.instances.attachEngine(instanceId, projectId, ws, false);
    // Legacy signalling is ready after its authenticated socket connects. It does
    // not perform the PS2 identify/endpointId handshake. Reset on every connection
    // so a reconnecting PS2 streamer must register again before admitting players.
    instance.streamerRegistered = resolvePixelStreamingProtocol(instance.project) === "legacy";
    if (_req.engineAuthMode === "instance_ticket") this.logger.info("instance.engine_ticket_authenticated", { instanceId, projectId });
    const protocolVersion = resolveSignallingProtocolVersion(instance.project);
    const iceServers = createIceServers(this.config, `engine-${instance.id}`);
    sendJson(ws, { type: "config", peerConnectionOptions: { iceServers }, protocolVersion, pixelStreamingProtocol: resolvePixelStreamingProtocol(instance.project) });
    this.logger.info("instance.engine_config_sent", { instanceId: instance.id, projectId, ueVersion: instance.project?.metadata?.ueVersion || "unknown", protocolVersion, iceServerCount: iceServers.length });
    if (resolvePixelStreamingProtocol(instance.project) === "unified") {
      sendJson(ws, { type: "identify" });
      this.logger.info("instance.engine_identify_sent", { instanceId: instance.id, projectId });
    }
    for (const sessionId of instance.players) this.instances.notifySession(sessionId, message(Types.Lifecycle, { state: "connecting", phase: "engine_configured", instanceId: instance.id, projectId, projectName: instance.project?.name || projectId }));
    ws.on("message", data => { if (instance.engine === ws) this.handleEngineMessage(instance, data); });
    ws.on("close", () => {
      if (instance.engine !== ws) return;
      instance.engine = null;
      instance.streamerRegistered = false;
      if (instance.state !== "stopping") {
        void this.stopLeaseBillingForInstance(instance, true);
        this.resetInstanceBillingSessions(instance);
        if (instance.externalEditor) {
          // Keep the external-editor slot and its URL alive for test workflows.
          // A standalone UE process can restart and reconnect with the same address.
          instance.state = "starting";
          clearTimeout(instance.engineTimer);
          if (!Object.hasOwn(this.editorEndpoints.entries, instance.projectId) && instance.project?.persistentEditorConnection !== true) {
            instance.engineTimer = setTimeout(() => this.instances.stop(instance.id, "editor_connection_expired"), 10 * 60_000);
            instance.engineTimer.unref?.();
          }
          for (const sessionId of instance.players)
            this.instances.notifySession?.(sessionId, message(Types.Lifecycle, { state: "connecting", phase: "engine_disconnected", instanceId: instance.id, projectId: instance.projectId, reasonCode: "engine_disconnected" }));
        } else this.instances.stop(instance.id, "engine_disconnected");
      }
    });
    this.instances.notifyEngineReady(instance);
    instance.turnDiagnosticTimer = setTimeout(() => {
      if (instance.state !== "running" || instance.engineRelayCandidateSeen) return;
      const mediaHealthy = [...instance.players].some(id => Date.now() - Number(this.sessions.sessions.get(id)?.mediaHealthyAt || 0) < 15_000);
      this.logger.warn("instance.engine_turn_candidate_missing", { instanceId: instance.id, projectId, ueVersion: instance.project?.metadata?.ueVersion || "unknown", waitSeconds: 8, mediaHealthy });
      const phase = mediaHealthy ? "turn_backup_unavailable" : "turn_unavailable";
      for (const sessionId of instance.players) this.instances.notifySession(sessionId, message(Types.Lifecycle, { state: mediaHealthy ? "running" : "connecting", phase, instanceId: instance.id, projectId, projectName: instance.project?.name || projectId, message: mediaHealthy ? "P2P 直连正常，TURN 备用中继尚未就绪。" : "UE 已连接 Signal，但尚未获得 TURN 中继地址。" }));
    }, 8_000);
    instance.turnDiagnosticTimer.unref?.();
  }

  handleEngineMessage(instance, data) {
    let value;
    try { value = parseMessage(data); } catch { return; }
    if (value.type === "endpointId") {
      const committedId = String(value.id || "DefaultStreamer");
      instance.streamerRegistered = true;
      instance.streamerId = committedId;
      sendJson(instance.engine, { type: "endpointIdConfirm", committedId });
      this.logger.info("instance.engine_endpoint_confirmed", { instanceId: instance.id, projectId: instance.projectId, streamerId: committedId });
      this.bindInstancePlayers(instance);
      return;
    }
    const playerId = value.playerId;
    if (playerId) {
      const session = this.sessions.sessions.get(playerId);
      if (session) {
        if (value.type === "iceCandidate") {
          const candidate = summarizeIceCandidate(value.candidate);
          this.logger.info("ice.candidate", { direction: "engine_to_player", sessionId: session.id, instanceId: instance.id, projectId: instance.projectId, ...candidate });
          if (candidate.candidateType === "relay" && !instance.engineRelayCandidateSeen) {
            instance.engineRelayCandidateSeen = true;
            clearTimeout(instance.turnDiagnosticTimer);
            this.logger.info("instance.engine_turn_candidate_ready", { instanceId: instance.id, projectId: instance.projectId, protocol: candidate.protocol });
            for (const id of instance.players) this.instances.notifySession(id, message(Types.Lifecycle, { state: "connecting", phase: "turn_ready", instanceId: instance.id, projectId: instance.projectId, projectName: instance.project?.name || instance.projectId }));
          }
        }
        delete value.playerId; sendJson(session.socket, value);
      }
    }
  }

  bindInstancePlayers(instance) {
    for (const id of instance.players) { const session = this.sessions.sessions.get(id); if (session) this.bindPlayer(session, instance); }
  }

  bindPlayer(session, instance) {
    instance.boundPlayers ||= new Set();
    if (instance.boundPlayers.has(session.id)) return;
    instance.boundPlayers.add(session.id);
    session.mediaConnectionStartedAt ||= Date.now();
    const controller = this.sessions.sessions.get(instance.controlSessionId);
    if (!controller || controller.readOnly) instance.controlSessionId = [...instance.players].find(id => !this.sessions.sessions.get(id)?.readOnly) || null;
    sendJson(session.socket, { type: "seticeServers", iceServers: createIceServers(this.config, `player-${session.id}`), iceTransportPolicy: resolveIceTransportPolicy(this.config) });
    const playerConnected = { type: "playerConnected", playerId: session.id, dataChannel: !session.readOnly, sfu: false };
    const protocol = resolvePixelStreamingProtocol(instance.project);
    if (protocol === "legacy") sendJson(session.socket, playerConnected);
    else sendJson(instance.engine, playerConnected);
    sendJson(session.socket, message(Types.Lifecycle, { state: "running", sessionId: session.id, instanceId: instance.id, projectId: instance.projectId, projectName: instance.project?.name || instance.projectId, inputRole: instance.controlSessionId === session.id ? "controller" : "viewer", qualityProfile: instance.qualityProfile || "original", maxRenderWidth: instance.qualityLimit?.width || null, maxRenderHeight: instance.qualityLimit?.height || null, targetFps: instance.qualityFps || null, maxBitrateMbps: instance.qualityBitrateMbps || null, activeInstanceCount: this.instances.list().filter(x => !["ended", "stopping"].includes(x.state)).length, bitratePolicyMode: this.config.bitrateControl?.mode || "auto", maxSessionDeadline: session.maximumDeadline || null }));
  }

  async activateInstanceBilling(instance) {
    const leaseIds = new Set([...instance.players].map(id => this.sessions.sessions.get(id)?.leaseId).filter(Boolean));
    for (const leaseId of leaseIds) {
      clearTimeout(this.billingStopTimers.get(leaseId)); this.billingStopTimers.delete(leaseId);
      await this.updateLeaseBilling("activate", leaseId);
    }
  }

  async activateSessionBilling(session) {
    const leaseId = session?.leaseId;
    if (!leaseId || !session.billingMediaAt || session.billingHeartbeatPending) return;
    const interval = Math.max(5, Number(this.config.publicAccess?.billing?.heartbeatSeconds) || 15) * 1000;
    if (session.billingActivated && Date.now() - Number(session.billingLastHeartbeatAt || 0) < interval) return;
    session.billingHeartbeatPending = true;
    session.billingLastHeartbeatAt = Date.now();
    clearTimeout(this.billingStopTimers.get(leaseId)); this.billingStopTimers.delete(leaseId);
    try { session.billingActivated = await this.updateLeaseBilling("activate", leaseId); }
    finally { session.billingHeartbeatPending = false; }
  }

  resetInstanceBillingSessions(instance) {
    for (const id of instance?.players || []) {
      const session = this.sessions.sessions.get(id);
      if (!session) continue;
      session.billingActivated = false;
      session.billingHeartbeatPending = false;
      session.billingLastHeartbeatAt = 0;
      session.billingMediaAt = 0;
    }
  }

  scheduleBillingStop(leaseId) {
    if (!leaseId || [...this.sessions.sessions.values()].some(x => x.leaseId === leaseId)) return;
    clearTimeout(this.billingStopTimers.get(leaseId));
    // Keep the instance recovery policy separate: idle reconnect grace must not consume public minutes.
    void this.updateLeaseBilling("stop", leaseId);
  }

  async stopLeaseBillingForInstance(instance, immediate = false) {
    const leaseIds = new Set([...instance.players].map(id => this.sessions.sessions.get(id)?.leaseId).filter(Boolean));
    for (const leaseId of leaseIds) immediate ? await this.updateLeaseBilling("stop", leaseId) : this.scheduleBillingStop(leaseId);
  }

  async releaseLeaseForInstance(instance) {
    const leaseIds = new Set([...instance.players].map(id => this.sessions.sessions.get(id)?.leaseId).filter(Boolean));
    for (const leaseId of leaseIds) await this.updateLeaseBilling("release", leaseId);
  }

  async updateLeaseBilling(action, leaseId) {
    this.billingUpdates ||= new Map();
    const observedAt = Date.now(), previous = this.billingUpdates.get(leaseId) || Promise.resolve();
    const pending = previous.catch(() => {}).then(() => this.sendLeaseBilling(action, leaseId, observedAt));
    this.billingUpdates.set(leaseId,pending);
    try { return await pending; }
    finally { if(this.billingUpdates.get(leaseId)===pending)this.billingUpdates.delete(leaseId); }
  }

  async sendLeaseBilling(action, leaseId, observedAt) {
    const billing = this.config.publicAccess?.billing || {}, token = String(billing.token || ""), base = String(billing.apiBaseUrl || "").replace(/\/$/, "");
    if (!base || !token || leaseId !== billing.leaseId) return this.logger.warn("public.billing_not_configured", { action, leaseId });
    try {
      const response = await fetch(`${base}/internal/v1/public/billing/${action}`, { method: "POST", headers: { "content-type": "application/json", "x-billing-token": token }, body: JSON.stringify({ leaseId, observedAt }), signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      this.logger.info(`public.billing_${action}d`, { leaseId });
      return true;
    } catch (error) { this.logger.warn("public.billing_update_failed", { action, leaseId, detail: error.message }); return false; }
  }

  async sendRouteSession(session, ended) {
    this.routeSessionUpdates ||= new Map();
    if (!session?.leaseId) return false;
    if (!ended && this.routeSessionUpdates.has(session.id)) return this.routeSessionUpdates.get(session.id);
    session.routeReportedAt = Date.now();
    const key = session?.id, payload = session ? { leaseId: session.leaseId, sessionId: session.id, projectId: session.projectId, route: session.publicRoute || "unknown", startedAt: session.connectedAt, ended: ended === true, relayBytes: Math.round(Number(session.usageTurnBytesEstimated) || 0), diagnostics: sessionConnectionDiagnostics(session, ended) } : null, previous = this.routeSessionUpdates.get(key) || Promise.resolve();
    const pending = previous.catch(() => {}).then(async () => {
      for (let attempt=0; attempt < (ended ? 3 : 1); attempt++) {
        if (attempt) await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
        if (await this.postRouteSession(payload)) return true;
      }
      return false;
    });
    this.routeSessionUpdates.set(key, pending);
    try { return await pending; }
    finally { if (this.routeSessionUpdates.get(key) === pending) this.routeSessionUpdates.delete(key); }
  }

  async postRouteSession(payload) {
    const billing = this.config.publicAccess?.billing || {}, token = String(billing.token || ""), base = String(billing.apiBaseUrl || "").replace(/\/$/, "");
    if (!payload?.leaseId || !base || !token || payload.leaseId !== billing.leaseId) return false;
    try {
      const response = await fetch(`${base}/internal/v1/public/route-session`, { method: "POST", headers: { "content-type": "application/json", "x-billing-token": token }, body: JSON.stringify(payload), signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return true;
    } catch (error) { this.logger.warn("public.route_session_update_failed", { sessionId: payload.sessionId, leaseId: payload.leaseId, detail: error.message }); return false; }
  }

  publishQualityLimit(instance) {
    if (instance.state !== "running") return;
    for (const sessionId of instance.players) {
      const session = this.sessions.sessions.get(sessionId); if (!session) continue;
      sendJson(session.socket, message(Types.Lifecycle, { state: "running", sessionId, instanceId: instance.id, projectId: instance.projectId, projectName: instance.project?.name || instance.projectId, inputRole: instance.controlSessionId === sessionId ? "controller" : "viewer", qualityProfile: instance.qualityProfile || "original", maxRenderWidth: instance.qualityLimit?.width || null, maxRenderHeight: instance.qualityLimit?.height || null, targetFps: instance.qualityFps || null, maxBitrateMbps: instance.qualityBitrateMbps || null }));
    }
  }

  retryWithProtocol(instance, protocol) {
    const sessions = [...instance.players].map(id => this.sessions.sessions.get(id)).filter(Boolean);
    if (sessions.length === 0) return false;
    void this.stopLeaseBillingForInstance(instance, true);
    this.resetInstanceBillingSessions(instance);
    instance.players.clear();
    for (const session of sessions) {
      session.instanceId = null;
      sendJson(session.socket, message(Types.Hello, { role: "player", sessionId: session.id, projectId: session.projectId, pixelStreamingProtocol: protocol, pixelStreamingPlugin: resolveStreamingPlugin(instance.project) }));
      sendJson(session.socket, message(Types.Lifecycle, { state: "starting", sessionId: session.id, projectId: session.projectId, reasonCode: "protocol_auto_fallback", pixelStreamingProtocol: protocol, pixelStreamingPlugin: resolveStreamingPlugin(instance.project) }));
    }
    void this.instances.allocate(instance.projectId, { startupBitrateMbps: instance.qualityBitrateMbps }).then(replacement => {
      for (const session of sessions) {
        if (!this.sessions.sessions.has(session.id)) continue;
        session.instanceId = replacement.id;
        replacement.players.add(session.id);
      }
    }).catch(error => {
      for (const session of sessions) sendJson(session.socket, message(Types.Lifecycle, { state: "ended", sessionId: session.id, projectId: session.projectId, reasonCode: "protocol_fallback_failed", message: error.message }));
    });
    return true;
  }

  retryWithCodec(instance, codec) {
    const sessions = [...instance.players].map(id => this.sessions.sessions.get(id)).filter(Boolean);
    if (sessions.length === 0) return false;
    void this.stopLeaseBillingForInstance(instance, true);
    this.resetInstanceBillingSessions(instance);
    instance.players.clear();
    for (const session of sessions) {
      session.instanceId = null; session.requestedCodec = codec;
      const cooldownUntil = markAv1FallbackCooldown(this.av1FallbackCooldowns, session.projectId, session.clientId, this.config.codecSelection?.fallbackCooldownMinutes || 30);
      session.codecObservation = { ...(session.codecObservation || {}), currentCodec: codec, reasonCode: "av1_auto_fallback", reasonText: "AV1 启动或协商失败，已自动回退 H.264", av1Requested: false, automaticAv1: false, av1Cooldown: cooldownUntil > 0, cooldownUntil };
      sendJson(session.socket, message(Types.Hello, { role: "player", sessionId: session.id, projectId: session.projectId, projectName: instance.project?.name || session.projectId, pixelStreamingProtocol: resolvePixelStreamingProtocol(instance.project), pixelStreamingPlugin: resolveStreamingPlugin(instance.project), bitrateProfile: instance.project?.bitrateProfile || "auto", adaptiveResolution: this.config.rendering?.adaptiveResolution !== false, screenPercentage: this.config.rendering?.screenPercentage || 0, qualityTiers: this.config.bitrateControl?.qualityTiers || {}, serverVersion: SERVICE_VERSION, webVersion: SERVICE_VERSION, codecObservation: session.codecObservation }));
      sendJson(session.socket, message(Types.Lifecycle, { state: "starting", sessionId: session.id, projectId: session.projectId, reasonCode: "av1_auto_fallback", codec }));
    }
    void this.instances.allocate(instance.projectId, { codec, codecFallbackAttempted: true, startupBitrateMbps: instance.qualityBitrateMbps }).then(replacement => {
      for (const session of sessions) { if (!this.sessions.sessions.has(session.id)) continue; session.instanceId = replacement.id; replacement.players.add(session.id); }
    }).catch(error => { for (const session of sessions) sendJson(session.socket, message(Types.Lifecycle, { state: "ended", sessionId: session.id, projectId: session.projectId, reasonCode: "codec_fallback_failed", message: error.message })); });
    return true;
  }

  updateInputRoles(instance) {
    if (!instance) return;
    const controller = this.sessions.sessions.get(instance.controlSessionId);
    if (!controller || controller.readOnly || !instance.players.has(instance.controlSessionId)) instance.controlSessionId = [...instance.players].find(id => !this.sessions.sessions.get(id)?.readOnly) || null;
    for (const sessionId of instance.players) this.instances.notifySession?.(sessionId, message(Types.SessionControlRole, { instanceId: instance.id, sessionId, role: instance.controlSessionId === sessionId ? "controller" : "viewer", controllerSessionId: instance.controlSessionId }));
  }

  handleExecue(ws, _req, url) {
    const id = url.searchParams.get("id") || "";
    if (!id) return ws.close(1008, "missing execue id");
    this.instances.addAgent(id, ws);
    sendJson(ws, message(Types.Hello, { role: "execue", execueId: id }));
    ws.on("message", data => { try { const value = parseMessage(data); if (value.type === Types.Pong) return; this.instances.handleAgentMessage(id, value); } catch {} });
    ws.on("close", () => this.instances.removeAgent(id, ws));
  }

  handleAdmin(ws) {
    const sendStatus = () => sendJson(ws, message(Types.AgentStatus, {
      serverVersion: SERVICE_VERSION,
      editorConnections: [...this.instances.projects.values()].filter(p => p.runtimeMode === 'external-editor').map(p => ({ projectId: p.id, state: this.editorEndpoints.isPaused(p.id) ? 'paused' : Object.hasOwn(this.editorEndpoints.entries, p.id) ? 'waiting' : 'unprepared' })),
      preloads: this.instances.preloadStatus(),
      instanceDetails: this.instances.list().map(x => {
        const playerSessions = [...x.players].map(id => this.sessions.sessions.get(id)).filter(Boolean);
        const firstMediaAt = Math.max(0, ...playerSessions.map(session => session.firstMediaAt || 0));
        return { id: x.id, preloaded: x.preloaded === true, codec: x.codec || "H264", mediaReady: firstMediaAt > 0, firstMediaAt: firstMediaAt || null };
      }),
      agents: [...this.instances.agents.keys()],
      sessions: this.sessions.sessions.size,
      usage: this.usage.snapshot(this.sessions.sessions.values()),
      billing: this.billingStatus(),
      shares: [...new Set([...this.sessions.sessions.values()].map(x => x.shareId).filter(Boolean))].map(id => { const active = [...this.sessions.sessions.values()].filter(x => x.shareId === id); return { id, online: new Set(active.map(x => x.clientId).filter(Boolean)).size, connections: active.length, reconnecting: 0, lastAccessAt: Math.max(0, ...active.map(x => x.lastActivityAt || x.connectedAt || 0)) }; }),
      waiting: this.waiting.map((x, index) => ({ sessionId: x.id, projectId: x.projectId, address: x.address, position: index + 1, connectedAt: x.connectedAt })),
      instances: this.instances.list().map(x => ({ id: x.id, projectId: x.projectId, externalEditor: x.externalEditor === true, state: x.state, players: x.players.size, lastPlayerLeftAt: x.externalEditor ? x.lastPlayerLeftAt || null : undefined, pid: x.pid, engineConnected: x.engine?.readyState === 1 && (!x.externalEditor || x.streamerRegistered === true), createdAt: x.createdAt, endedAt: x.endedAt, exitCode: x.exitCode, reasonCode: x.endReasonCode || x.stopReasonCode, qualityProfile: x.qualityProfile || "original", estimatedGpuIncrementGB: x.estimatedGpuIncrementGB || 3, fairUseDeadline: x.fairUseDeadline || null, recovered: x.recovered === true, error: x.error }))
    }));
    sendStatus();
    ws.on("message", async data => {
      let value;
      try { value = parseMessage(data); } catch { return; }
      if (value.type === "session.diagnostics") {
      if (acceptConnectionDiagnostics(session, value) && session.publicIngress) {
        const first = session.connectionDiagnostics.result === "success" && !session.firstFrameReported;
        if (first || Date.now() - (session.routeReportedAt || 0) >= 15000) {
          session.firstFrameReported = first || session.firstFrameReported;
          void this.sendRouteSession(session, false);
        }
      }
      return;
    }
    if (value.type === Types.Pong) return;
      if (value.type === Types.AdminStatusGet) return sendStatus();
      if (value.type === "admin.project.local-audio" && typeof value.projectId === "string" && typeof value.localAudio === "boolean") {
        const project = this.instances.projects.get(value.projectId);
        if (project) project.localAudio = value.localAudio;
        sendJson(ws, { type: "admin.project.local-audio.updated", ok: Boolean(project) });
        return;
      }
      if (["admin.editor.prepare", "admin.editor.reset"].includes(value.type) && typeof value.projectId === "string") {
        try {
          const project = this.instances.projects.get(value.projectId);
          if (!project?.enabled || project.runtimeMode !== 'external-editor') throw new Error('unavailable');
          const endpointPath = this.editorEndpoints.prepare(value.projectId, value.type === 'admin.editor.reset');
          project.persistentEditorConnection = true;
          if (value.type === 'admin.editor.reset') {
            for (const item of this.instances.list().filter(x => x.projectId === value.projectId && x.externalEditor)) await this.instances.stop(item.id, 'editor_address_reset');
          }
          const instance = this.instances.prepareExternalEditor(value.projectId);
          sendJson(ws, { type: "admin.editor.prepared", instanceId: instance.id, connected: instance.engine?.readyState === 1, path: endpointPath });
        } catch { sendJson(ws, { type: "admin.editor.prepared", error: "editor_project_unavailable" }); }
        return;
      }
      if (value.type === "admin.preload.resume" && typeof value.projectId === "string") {
        void this.instances.resumePreload(value.projectId, this.waiting.length === 0).finally(sendStatus);
        return;
      }
      if (value.type === Types.AdminInstanceStop && typeof value.instanceId === "string") {
        try {
          const instance = this.instances.get(value.instanceId);
          if (instance?.externalEditor && !['ended', 'stopping'].includes(instance.state)) this.editorEndpoints.setPaused(instance.projectId, true);
          await this.instances.stop(value.instanceId, value.reasonCode || "admin_requested");
        } catch { sendJson(ws, { type: 'admin.operation.failed', error: 'instance_stop_failed' }); }
        sendStatus();
      }
      if (value.type === Types.AdminQueueCancel && typeof value.sessionId === "string") {
        const session = this.waiting.find(x => x.id === value.sessionId);
        if (session) { this.dequeue(session); session.socket.close(1000, "cancelled by administrator"); }
        sendStatus();
      }
    });
  }

  billingStatus() {
    const active = [...this.sessions.sessions.values()].filter(x => x.publicIngress && x.billingActivated && x.billingMediaAt);
    const routes = { p2p: 0, turn: 0, unknown: 0 };
    for (const session of active) routes[session.publicRoute === "p2p" ? "p2p" : session.publicRoute === "turn" ? "turn" : "unknown"]++;
    return { state: active.length ? "active" : "pending", activeSessions: active.length, startedAt: active.length ? Math.min(...active.map(x => Number(x.billingMediaAt))) : null, routes };
  }

  handleHttp(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname === "/api/public/bootstrap") {
      const allowedEvents = new Set(["page_open", "player_script_loaded", "player_controller_created", "player_controller_failed", "player_start", "player_start_failed", "share_check_started", "share_check_success", "share_check_failed", "websocket_started", "websocket_open", "websocket_error", "websocket_closed", "session_connected"]);
      const event = String(url.searchParams.get("event") || "");
      if (!allowedEvents.has(event)) { res.writeHead(400); return res.end(); }
      const oneOf = (name, values, fallback) => { const value = String(url.searchParams.get(name) || "").toLowerCase(); return values.includes(value) ? value : fallback; };
      const booleanValue = name => String(url.searchParams.get(name) || "").toLowerCase() === "true";
      this.logger.info("player.bootstrap", {
        bootstrapEvent: event,
        platform: oneOf("platform", ["ios", "android", "desktop"], "unknown"),
        browser: oneOf("browser", ["safari", "chrome", "edge", "other"], "other"),
        deviceClass: oneOf("deviceClass", ["mobile", "tablet", "desktop"], "desktop"),
        container: oneOf("container", ["wechat", "normal", "unknown"], "unknown"),
        isWechat: booleanValue("isWechat"),
        fullscreenSupported: booleanValue("fullscreenSupported"),
        orientationLockSupported: booleanValue("orientationLockSupported"),
        errorName: String(url.searchParams.get("errorName") || "").replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 64) || null
      });
      res.setHeader("cache-control", "no-store"); res.writeHead(204); return res.end();
    }
    if (url.pathname === "/api/public/share-status") {
      res.setHeader("content-type", "application/json; charset=utf-8"); res.setHeader("cache-control", "no-store");
      if (!isPublicIngress(req, this.config)) { res.writeHead(404); return res.end(JSON.stringify({ ok: false, reason: "not_found" })); }
      const grant = validateShareGrant(url.searchParams.get("share"), this.config);
      let reason = grant.ok && grant.projectId !== url.searchParams.get("project") ? "share_invalid" : grant.reason;
      const clientId = this.validClientId(url.searchParams.get("client"));
      const leaseKeys = grant.ok ? shareLeaseIds(this.sessions.sessions.values(), this.shareReservations, grant.id) : new Set();
      const online = leaseKeys.size;
      if (grant.ok && (!clientId || (!leaseKeys.has(clientId) && online >= grant.maxOnline))) reason = "share_online_limit";
      if (grant.ok && !reason && !leaseKeys.has(clientId) && !this.usage.canAcceptPublic(this.sessions.sessions.values(), this.shareReservations.size)) reason = "public_capacity_reached";
      const ok = grant.ok && !reason;
      res.writeHead(ok ? 200 : reason === "share_online_limit" ? 429 : reason === "share_expired" || reason === "share_revoked" ? 410 : 403);
      return res.end(JSON.stringify({ ok, reason: ok ? null : reason, message: ok ? "链接有效" : shareFailureMessage(reason), permission: ok ? (grant.readOnly ? "viewer" : "control") : undefined, expiresAt: ok ? grant.expiresAt : undefined, online: ok ? online : undefined, maxOnline: ok ? grant.maxOnline : undefined }));
    }
    if (isPublicIngress(req, this.config) && url.pathname === "/health") { res.writeHead(404); return res.end("Not found"); }
    if (this.config.security?.cors === true) {
      res.setHeader("access-control-allow-origin", "*");
      res.setHeader("access-control-allow-methods", "GET, OPTIONS");
      if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
    }
    if (url.pathname === "/health") { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify({ ok: true, instances: this.instances.instances.size, agents: this.instances.agents.size, sessions: this.sessions.sessions.size })); }
    // Only known Vue page routes fall back to the app. Missing assets/API paths stay 404.
    const frontendPage = ["/frontend", "/frontend/", "/frontend/digital-twin", "/frontend/digital-twin/"].includes(url.pathname);
    let decodedPath;
    try { decodedPath = decodeURIComponent(url.pathname); } catch { res.writeHead(400); return res.end("Bad request"); }
    const relative = frontendPage ? "frontend/index.html" : url.pathname === "/" ? "index.html" : url.pathname === "/player" ? "source-video.html" : decodedPath.replace(/^[/\\]+/, "");
    const target = path.resolve(this.publicDir, relative);
    if (!target.startsWith(this.publicDir + path.sep)) { res.writeHead(403); return res.end("Forbidden"); }
    const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8" };
    res.setHeader("content-type", types[path.extname(target).toLowerCase()] || "application/octet-stream");
    if ([".html", ".js", ".css"].includes(path.extname(target).toLowerCase())) res.setHeader("cache-control", "no-cache, no-store, must-revalidate");
    res.setHeader("x-peerstream-version", SERVICE_VERSION);
    fs.createReadStream(target).on("error", () => { res.writeHead(404); res.end("Not found"); }).pipe(res);
  }

  checkTelemetryTimeouts(now = Date.now()) {
    const timeoutMs = Math.max(60, Number(this.config.publicAccess?.costProtection?.telemetryTimeoutSeconds) || 120) * 1000;
    for (const session of this.sessions.sessions.values()) {
      if (!session.publicIngress || !session.mediaConnectionStartedAt || session.forcedCloseReason) continue;
      if (now - (session.lastRouteTelemetryAt || session.mediaConnectionStartedAt) >= timeoutMs) this.endForCostProtection(session, "public_telemetry_timeout");
    }
  }

  pingAll() {
    this.checkTelemetryTimeouts();
    for (const [role, server] of Object.entries(this.roles)) for (const ws of server.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
      if (role !== "engine") sendJson(ws, message(Types.Ping));
    }
  }

  listen() {
    return new Promise((resolve, reject) => { this.http.once("error", reject); this.http.listen(this.config.port, this.config.host, resolve); });
  }

  close() {
    for (const record of this.sessions.recoveries.values()) clearTimeout(record.timer);
    this.sessions.recoveries.clear();
    clearInterval(this.heartbeat);
    clearInterval(this.queueTimer);
    clearInterval(this.publicAccessTimer);
    clearInterval(this.reservationCleanupTimer);
    for (const server of Object.values(this.roles)) for (const ws of server.clients) ws.terminate();
    return new Promise(resolve => this.http.close(resolve));
  }
}

export function authorizeEngineTicket(url, instances) {
  const parts = url.pathname.split("/").filter(Boolean);
  const projectId = safeDecodeURIComponent(parts[1]) || url.searchParams.get("project") || "";
  const instanceId = safeDecodeURIComponent(parts[2]) || url.searchParams.get("instance") || url.searchParams.get("instanceId") || "";
  const ticketPart = parts[3] || "";
  const supplied = ticketPart.startsWith("token=") ? safeDecodeURIComponent(ticketPart.slice(6)) : url.searchParams.get("token") || "";
  const instance = instanceId ? instances.get(instanceId) : null;
  if (!projectId || !instanceId) return { allowed: false, projectId, instanceId, reasonCode: "engine_path_invalid" };
  if (!instance || instance.projectId !== projectId) return { allowed: false, projectId, instanceId, reasonCode: "engine_instance_unknown" };
  if (instance.engine || !["starting", "recovering"].includes(instance.state)) return { allowed: false, projectId, instanceId, reasonCode: "engine_instance_not_connectable" };
  if (!supplied || typeof instance.engineAuthTicket !== "string" || instance.engineAuthTicket.length < 24 || supplied !== instance.engineAuthTicket) return { allowed: false, projectId, instanceId, reasonCode: "engine_ticket_invalid" };
  return { allowed: true, projectId, instanceId, reasonCode: "engine_ticket_valid" };
}

function safeDecodeURIComponent(value = "") {
  try { return decodeURIComponent(value); } catch { return ""; }
}

export function resolvePixelStreamingProtocol(project = {}) {
  return resolveStreamingProtocol(project);
}

export function resolveSignallingProtocolVersion(project) {
  const match = String(project?.metadata?.ueVersion || project?.ueVersion || "").match(/^(\d+)(?:\.(\d+))?/);
  if (!match) return "1.1.0";
  const major = Number(match[1]), minor = Number(match[2] || 0);
  return major > 5 || (major === 5 && minor >= 5) ? "1.3.0" : "1.1.0";
}

export function recommendObservedBitrate(connectionType, activeCount = 1) {
  const count = Math.max(1, Number(activeCount) || 1), relay = String(connectionType).toLowerCase().includes("turn");
  if (relay) return count === 1 ? { maxBitrateMbps: 30, reason: "TURN中继" } : count === 2 ? { maxBitrateMbps: 25, reason: "双实例 + TURN中继" } : { maxBitrateMbps: 20, reason: "多实例 + TURN中继" };
  return count === 1 ? { maxBitrateMbps: 50, reason: "单实例P2P直连" } : count === 2 ? { maxBitrateMbps: 40, reason: "双实例P2P直连" } : { maxBitrateMbps: 30, reason: "多实例P2P直连" };
}

export function findReconnectSession(sessions, shareId, clientId, tabId) {
  return [...sessions].find(x => x.shareId === shareId && x.clientId === clientId && (!tabId || x.tabId === tabId));
}

export function parseClientCapabilities(url) {
  const supported = new Set(["AV1", "H264", "VP8", "VP9"]);
  const videoCodecs = String(url.searchParams.get("codecs") || "").split(",").map(x => x.trim().toUpperCase()).filter(x => supported.has(x));
  const requestedText = url.searchParams.get("av1Factor"), requestedFactor = Number(requestedText);
  const forcedCodec = String(url.searchParams.get("codec") || "").toUpperCase() === "H264" ? "H264" : null;
  return { videoCodecs: [...new Set(videoCodecs)], mobile: url.searchParams.get("mobile") === "1", platform: String(url.searchParams.get("platform") || "unknown").slice(0, 32), requestedCodec: url.searchParams.get("av1") === "1" ? "AV1" : "H264", forcedCodec, av1BitrateFactor: requestedText !== null && [1, 0.8, 0.7].includes(requestedFactor) ? requestedFactor : null, capabilityVersion: 5 };
}

export function resolveAv1BitrateFactor(session, route, config = {}) {
  const requested = Number(session?.av1BitrateFactor);
  if ([1, 0.8, 0.7].includes(requested)) return { value: requested, source: "manual" };
  const configured = Number(config?.defaultAv1Factors?.[route]);
  if ([1, 0.8, 0.7].includes(configured)) return { value: configured, source: "route_default" };
  return { value: route === "publicP2p" || route === "turn" ? 0.8 : 1, source: "route_default" };
}

export function resolveAccessScope(session, instance, sessions) {
  if (session?.publicIngress === true) return "public";
  return [...(instance?.players || [])].some(id => sessions?.get(id)?.publicIngress === true) ? "public" : "lan";
}

function summarizeIceCandidate(candidate) {
  const text = typeof candidate === "string" ? candidate : String(candidate?.candidate || "");
  const type = /\btyp\s+(host|srflx|prflx|relay)\b/i.exec(text)?.[1]?.toLowerCase() || "unknown";
  const protocol = /^candidate:\S+\s+\d+\s+(udp|tcp)\b/i.exec(text)?.[1]?.toLowerCase() || "unknown";
  return { candidateType: type, protocol };
}
