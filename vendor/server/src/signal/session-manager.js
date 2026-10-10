import crypto from "node:crypto";
import { message, sendJson, Types } from "../shared/protocol.js";

export class SessionManager {
  constructor(config, logger, instances) {
    this.config = config;
    this.logger = logger;
    this.instances = instances;
    this.sessions = new Map();
    this.recoveries = new Map();
    this.onPlayersChanged = () => {};
  }

  add(socket, request, projectId, options = {}) {
    const id = crypto.randomUUID();
    const address = String(options.address || request.socket.remoteAddress || "").replace(/^::ffff:/, "");
    const session = { id, socket, request, address, projectId, readOnly: options.readOnly === true, publicIngress: options.publicIngress === true, publicRoute: options.publicIngress === true ? "unknown" : "lan", leaseId: options.leaseId || null, shareId: options.shareId || null, clientId: options.clientId || null, tabId: options.tabId || null, shareExpiresAt: Number(options.shareExpiresAt) || 0, instanceId: null, connectedAt: Date.now(), lastActivityAt: Date.now(), timers: [], maximumTimers: [] };
    if (options.maxSessionMinutes !== undefined) session.maxSessionMinutes = Math.max(0, Number(options.maxSessionMinutes) || 0);
    session.recoveryKey = session.clientId && session.tabId ? JSON.stringify([projectId, session.shareId, session.clientId, session.tabId, session.readOnly]) : id;
    const recovery = this.recoveries.get(session.recoveryKey);
    if (recovery) {
      if (recovery.expiresAt > Date.now()) session.maximumDeadline = recovery.maximumDeadline;
      clearTimeout(recovery.timer);
      this.recoveries.delete(session.recoveryKey);
    }
    this.sessions.set(id, session);
    this.scheduleIdle(session);
    this.scheduleMaximumDuration(session);
    this.logger.info("session.connected", { sessionId: id, projectId, address });
    return session;
  }

  replaceForReconnect(session) {
    if (!session || !this.sessions.delete(session.id)) return null;
    session.timers.forEach(clearTimeout); session.timers = [];
    (session.maximumTimers || []).forEach(clearTimeout); session.maximumTimers = [];
    const instance = session.instanceId ? this.instances.get(session.instanceId) : null;
    this.rememberRecovery(session, instance);
    this.detach(session, instance);
    session.instanceId = null;
    this.logger.info("session.lease_replaced", { sessionId: session.id, instanceId: instance?.id || null, projectId: session.projectId });
    return instance;
  }

  rememberRecovery(session, instance) {
    if (!session.recoveryKey) return;
    const key = session.recoveryKey;
    const seconds = Math.max(10, Number(this.config.networkRecoverySeconds) || 10);
    clearTimeout(this.recoveries.get(key)?.timer);
    const record = { maximumDeadline: session.maximumDeadline, expiresAt: Date.now() + seconds * 1000 };
    record.timer = setTimeout(() => { if (this.recoveries.get(key) === record) this.recoveries.delete(key); }, seconds * 1000);
    record.timer.unref?.();
    this.recoveries.set(key, record);
    if (instance && !instance.externalEditor && this.config.mode !== "shared") { instance.recoveryOwner = key; instance.recoveryDeadline = session.maximumDeadline; }
  }

  detach(session, instance) {
    if (!instance) return;
    if (instance.boundPlayers?.delete(session.id)) sendJson(instance.engine, { type: "playerDisconnected", playerId: session.id });
    const wasLastPlayer = instance.players.size === 1 && instance.players.has(session.id);
    instance.players.delete(session.id);
    if (instance.externalEditor && wasLastPlayer) instance.lastPlayerLeftAt = Date.now();
    this.onPlayersChanged(instance);
  }

  activity(session) {
    if (!this.sessions.has(session.id) || session.terminalReason) return;
    session.lastActivityAt = Date.now();
    this.scheduleIdle(session);
  }

  updateRoute(session, connectionType) {
    if (!session?.publicIngress || session.terminalReason) return;
    const route = /relay|turn/i.test(String(connectionType || "")) ? "turn" : /p2p|host|srflx|prflx/i.test(String(connectionType || "")) ? "p2p" : "unknown";
    if (route === session.publicRoute) return;
    session.publicRoute = route;
    this.logger.info("session.idle_policy_changed", { sessionId: session.id, instanceId: session.instanceId, projectId: session.projectId, route, ...this.idlePolicy(session) });
    this.scheduleIdle(session);
  }

  idlePolicy(session) {
    if (session?.publicIngress) {
      const route = session.publicRoute === "p2p" ? "p2p" : "turn";
      const timeout = route === "p2p" ? Number(this.config.publicP2pIdleSeconds) || 300 : Number(this.config.publicTurnIdleSeconds) || 120;
      return { timeout, warning: Math.min(timeout, Number(this.config.publicIdleWarningSeconds) || 30), route };
    }
    const timeout = Number(this.config.userIdleSeconds) || 0;
    return { timeout, warning: Math.min(timeout, Math.max(0, Number(this.config.idleWarningSeconds ?? 20))), route: "lan" };
  }

  scheduleIdle(session) {
    session.timers.forEach(clearTimeout);
    session.timers = [];
    const { timeout, warning, route } = this.idlePolicy(session);
    if (timeout <= 0) return;
    const elapsed = Math.max(0, (Date.now() - Number(session.lastActivityAt || Date.now())) / 1000);
    const remaining = Math.max(0, timeout - elapsed);
    if (warning > 0) session.timers.push(setTimeout(() => sendJson(session.socket, message(Types.SessionIdleWarning, {
      sessionId: session.id, instanceId: session.instanceId, remainingSeconds: Math.min(warning, Math.ceil(remaining)), timeoutSeconds: timeout, route
    })), Math.max(0, remaining - warning) * 1000));
    session.timers.push(setTimeout(() => this.expire(session, "user_idle_timeout"), remaining * 1000));
  }

  scheduleMaximumDuration(session) {
    (session.maximumTimers || []).forEach(clearTimeout);
    session.maximumTimers = [];
    const configured = session.maxSessionMinutes !== undefined ? session.maxSessionMinutes : this.config.maxSessionMinutes;
    const timeout = Math.max(0, Number(configured) || 0) * 60;
    if (timeout <= 0 && !session.maximumDeadline) return;
    session.maximumDeadline ||= Date.now() + timeout * 1000;
    const remaining = Math.max(0, (session.maximumDeadline - Date.now()) / 1000);
    const warning = Math.min(remaining, Math.max(10, Number(this.config.maxSessionWarningSeconds) || 20));
    session.maximumTimers.push(setTimeout(() => sendJson(session.socket, message(Types.Lifecycle, {
      state: "fair_use_warning", sessionId: session.id, instanceId: session.instanceId, projectId: session.projectId,
      remainingSeconds: warning, reasonCode: "max_session_duration"
    })), Math.max(0, remaining - warning) * 1000));
    session.maximumTimers.push(setTimeout(() => this.expire(session, "max_session_duration"), remaining * 1000));
  }

  async expire(session, reasonCode) {
    if (!this.sessions.has(session.id)) return;
    session.terminalReason = reasonCode;
    sendJson(session.socket, message(Types.Lifecycle, { state: "stopping", reasonCode, sessionId: session.id, instanceId: session.instanceId }));
    await this.remove(session, reasonCode, true);
    setTimeout(() => { try { session.socket.close(4000, reasonCode); } catch {} }, 250).unref?.();
  }

  async remove(session, reasonCode = "player_disconnected", explicit = false) {
    if (!this.sessions.delete(session.id)) return;
    session.timers.forEach(clearTimeout);
    session.timers = [];
    (session.maximumTimers || []).forEach(clearTimeout);
    session.maximumTimers = [];
    this.logger.info("session.closed", { sessionId: session.id, instanceId: session.instanceId, projectId: session.projectId, reasonCode });
    const instance = session.instanceId ? this.instances.get(session.instanceId) : null;
    if (!explicit) this.rememberRecovery(session, instance);
    if (!session.instanceId) return;
    this.detach(session, instance);
    if (instance?.externalEditor) return;
    if (instance && instance.players.size === 0 && this.instances.shouldKeepPreloaded?.(instance) && (explicit || this.config.mode === "shared")) {
      instance.recoveryOwner = null;
      instance.recoveryDeadline = null;
      this.instances.cancelDisconnectedStop(instance.id);
      this.logger.info("preload.returned_to_warm", { sessionId: session.id, instanceId: instance.id, projectId: instance.projectId, reasonCode });
      return;
    }
    if (instance && (this.config.mode === "one2one" || instance.players.size === 0)) {
      if (explicit) await this.instances.stop(instance.id, reasonCode);
      else {
        const policy = this.config.lastPlayerExitPolicy || "grace";
        if (policy === "immediate") await this.instances.stop(instance.id, "last_player_left");
        else if (policy === "grace") this.instances.scheduleDisconnectedStop(instance.id, Number(this.config.networkRecoverySeconds) || 10, "network_disconnect_timeout");
        else if (policy === "idle") this.instances.scheduleDisconnectedStop(instance.id, Math.max(0, Number(this.config.idleInstanceSeconds ?? 120)), "instance_idle_timeout");
      }
    }
  }

  rebind(instance) {
    const candidates = [...this.sessions.values()].filter(x => x.projectId === instance.projectId && !x.instanceId && !x.terminalReason && !x.queued && (!x.requestedCodec || x.requestedCodec === (instance.codec || "H264")) && (!instance.recoveryOwner || instance.recoveryOwner === x.recoveryKey));
    const capacity = this.config.mode === "shared" ? Number(this.config.maxSharedPlayers) || 20 : 1;
    for (const session of candidates.slice(0, Math.max(0, capacity - instance.players.size))) {
      session.instanceId = instance.id;
      instance.players.add(session.id);
      this.instances.cancelDisconnectedStop(instance.id);
      this.onPlayersChanged(instance);
    }
  }
}
