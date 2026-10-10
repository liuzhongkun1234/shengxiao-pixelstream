import fs from "node:fs";
import path from "node:path";

const GIB = 1024 ** 3;

export class UsageMeter {
  constructor(options = {}, logger = { info() {}, warn() {} }) {
    this.options = {
      maxPublicSessions: positiveInteger(options.maxPublicSessions, 5),
      maxTurnSessions: positiveInteger(options.maxTurnSessions, 1),
      maxSessionMinutes: nonNegative(options.maxSessionMinutes, 60),
      maxTurnGBPerDay: nonNegative(options.maxTurnGBPerDay, 20),
      trafficOverheadFactor: Math.max(1, Number(options.trafficOverheadFactor) || 1.1),
      timeZone: String(options.timeZone || "Asia/Shanghai"),
      stateFile: String(options.stateFile || options.usageFile || "")
    };
    this.logger = logger;
    this.state = this.loadState();
  }

  record(session, sample = {}, now = Date.now()) {
    this.ensureDay(now);
    const route = normalizeRoute(sample.route, sample.connectionType, session?.publicIngress);
    const previousAt = Number(session.usageLastAt || session.connectedAt || now);
    const seconds = Math.max(0, Math.min(15, (now - previousAt) / 1000));
    const bitrateMbps = Math.max(0, Number(sample.bitrateMbps) || 0);
    const field = route === "turn" ? "turnSeconds" : route === "publicP2p" ? "publicP2pSeconds" : "lanP2pSeconds";
    this.state[field] += seconds;
    if (route === "turn") this.state.turnBytesEstimated += bitrateMbps * 1_000_000 / 8 * seconds * this.options.trafficOverheadFactor;
    session.usageLastAt = now;
    session.usageRoute = route;
    session.usageBitrateMbps = bitrateMbps;
    session.usageCodec = String(sample.codec || session.usageCodec || "H264");
    session.usageSeconds = Number(session.usageSeconds || 0) + seconds;
    session.usageTurnBytesEstimated = Number(session.usageTurnBytesEstimated || 0) + (route === "turn" ? bitrateMbps * 1_000_000 / 8 * seconds * this.options.trafficOverheadFactor : 0);
    session.usageBitrateMbpsSeconds = Number(session.usageBitrateMbpsSeconds || 0) + bitrateMbps * seconds;
    this.persist(now);
    return this.sessionSummary(session);
  }

  finish(session, now = Date.now()) {
    if (session?.usageFinished) return this.sessionSummary(session);
    if (session?.usageRoute) this.record(session, { route: session.usageRoute, bitrateMbps: session.usageBitrateMbps, codec: session.usageCodec }, now);
    session.usageFinished = true;
    this.state.sessionsCompleted += 1;
    this.persist(now);
    return this.sessionSummary(session);
  }

  sessionSummary(session) {
    const seconds = Math.max(0, Number(session?.usageSeconds) || 0);
    return {
      accessScope: session?.publicIngress ? "public" : "lan",
      route: session?.usageRoute || "unknown",
      codec: session?.usageCodec || session?.codecObservation?.currentCodec || "H264",
      meteredSeconds: Math.round(seconds),
      averageBitrateMbps: seconds > 0 ? round(Number(session?.usageBitrateMbpsSeconds || 0) / seconds, 2) : 0,
      turnEstimatedGB: round(Number(session?.usageTurnBytesEstimated || 0) / GIB, 4)
    };
  }

  canAcceptPublic(sessions, pending = 0) {
    if (this.options.maxPublicSessions <= 0) return true;
    const active = [...sessions].filter(x => x?.publicIngress === true).length;
    return active + Math.max(0, Number(pending) || 0) < this.options.maxPublicSessions;
  }

  violation(session, sessions) {
    if (session?.usageRoute !== "turn") return null;
    if (this.options.maxTurnSessions > 0) {
      const active = [...sessions].filter(x => x?.publicIngress === true && x.usageRoute === "turn").sort((a, b) => Number(a.connectedAt) - Number(b.connectedAt));
      if (active.indexOf(session) >= this.options.maxTurnSessions) return "turn_capacity_reached";
    }
    if (this.options.maxTurnGBPerDay > 0 && this.state.turnBytesEstimated / GIB >= this.options.maxTurnGBPerDay) return "turn_daily_budget_exhausted";
    return null;
  }

  snapshot(sessions, now = Date.now()) {
    this.ensureDay(now);
    const active = [...sessions];
    const turnGB = this.state.turnBytesEstimated / GIB;
    return {
      date: this.state.date,
      publicActive: active.filter(x => x?.publicIngress === true).length,
      turnActive: active.filter(x => x?.publicIngress === true && x.usageRoute === "turn").length,
      lanP2pMinutes: round(this.state.lanP2pSeconds / 60, 1),
      publicP2pMinutes: round(this.state.publicP2pSeconds / 60, 1),
      turnMinutes: round(this.state.turnSeconds / 60, 1),
      turnEstimatedGB: round(turnGB, 3),
      turnRemainingGB: this.options.maxTurnGBPerDay > 0 ? round(Math.max(0, this.options.maxTurnGBPerDay - turnGB), 3) : null,
      sessionsCompleted: this.state.sessionsCompleted,
      limits: {
        maxPublicSessions: this.options.maxPublicSessions,
        maxTurnSessions: this.options.maxTurnSessions,
        maxSessionMinutes: this.options.maxSessionMinutes,
        maxTurnGBPerDay: this.options.maxTurnGBPerDay
      },
      turnBudgetExhausted: this.options.maxTurnGBPerDay > 0 && turnGB >= this.options.maxTurnGBPerDay
    };
  }

  dayKey(now = Date.now()) {
    try { return new Intl.DateTimeFormat("en-CA", { timeZone: this.options.timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now); }
    catch { return new Date(now).toISOString().slice(0, 10); }
  }

  emptyState(now = Date.now()) {
    return { schemaVersion: 1, date: this.dayKey(now), lanP2pSeconds: 0, publicP2pSeconds: 0, turnSeconds: 0, turnBytesEstimated: 0, sessionsCompleted: 0, updatedAt: now };
  }

  ensureDay(now = Date.now()) {
    if (this.state.date === this.dayKey(now)) return;
    this.logger.info("usage.daily_reset", { previousDate: this.state.date, previousTurnEstimatedGB: round(this.state.turnBytesEstimated / GIB, 3) });
    this.state = this.emptyState(now);
    this.persist(now);
  }

  loadState() {
    if (!this.options.stateFile) return this.emptyState();
    try {
      const value = JSON.parse(fs.readFileSync(this.options.stateFile, "utf8"));
      if (value?.schemaVersion === 1 && value.date === this.dayKey()) return { ...this.emptyState(), ...value };
    } catch {}
    return this.emptyState();
  }

  persist(now = Date.now()) {
    if (!this.options.stateFile) return;
    try {
      const target = path.resolve(this.options.stateFile);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      this.state.updatedAt = now;
      const temporary = `${target}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(this.state, null, 2));
      fs.renameSync(temporary, target);
    } catch (error) { this.logger.warn("usage.persist_failed", { detail: error.message }); }
  }
}

export function normalizeRoute(route, connectionType, publicIngress = false) {
  if (["lanP2p", "publicP2p", "turn"].includes(route)) return route;
  if (String(connectionType || "").toLowerCase().includes("turn")) return "turn";
  return publicIngress ? "publicP2p" : "lanP2p";
}

function positiveInteger(value, fallback) { const number = Number(value); return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback; }
function nonNegative(value, fallback) { const number = Number(value); return Number.isFinite(number) && number >= 0 ? number : fallback; }
function round(value, digits) { const scale = 10 ** digits; return Math.round((Number(value) || 0) * scale) / scale; }
