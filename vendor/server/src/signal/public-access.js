import crypto from "node:crypto";
import fs from "node:fs";

export function normalizeAddress(value) {
  return String(value || "").trim().replace(/^::ffff:/, "");
}

export function normalizeClientId(value) {
  const text = String(value || "");
  return /^[a-f0-9-]{32,40}$/i.test(text) ? text : null;
}

export function shareLeaseIds(sessions, reservations, shareId) {
  const result = new Set([...sessions].filter(x => x?.shareId === shareId && x.clientId).map(x => x.clientId));
  for (const key of reservations.keys()) if (key.startsWith(`${shareId}:`)) result.add(key.slice(shareId.length + 1));
  return result;
}

export function isTrustedProxy(request, config) {
  const remote = normalizeAddress(request?.socket?.remoteAddress);
  const allowed = config?.publicAccess?.trustedProxyIps;
  return Array.isArray(allowed) && allowed.map(normalizeAddress).includes(remote);
}

export function isPublicIngress(request, config) {
  return isTrustedProxy(request, config) && String(request?.headers?.["x-peerstream-public"] || "") === "1";
}

export function clientAddress(request, config) {
  const direct = normalizeAddress(request?.socket?.remoteAddress);
  if (!isPublicIngress(request, config)) return direct;
  const forwarded = String(request?.headers?.["x-forwarded-for"] || "").split(",").map(normalizeAddress).find(Boolean);
  return forwarded || direct;
}

export function createIceServers(config, label = "peerstream") {
  const result = Array.isArray(config?.iceServers) ? structuredClone(config.iceServers) : [];
  const turn = config?.publicAccess?.turn;
  const issued = turn?.temporaryCredential;
  const secret = resolveSharedSecret(turn);
  const urls = Array.isArray(turn?.urls) ? turn.urls.filter(x => typeof x === "string" && x.length > 0) : [];
  if (turn?.enabled !== true || urls.length === 0) return result;
  if (issued?.username && issued?.credential && Number(issued.expiresAt) > Date.now() + 30_000) {
    result.push({ urls, username: String(issued.username), credential: String(issued.credential) });
    return result;
  }
  if (!secret) return result;
  const ttlSeconds = Math.max(300, Math.min(86400, Number(turn.ttlSeconds) || 3600));
  const username = `${Math.floor(Date.now() / 1000) + ttlSeconds}:${String(label).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 48) || "peerstream"}`;
  const credential = crypto.createHmac("sha1", secret).update(username).digest("base64");
  result.push({ urls, username, credential });
  return result;
}

export function hasValidTurnSecret(config) {
  const turn = config?.publicAccess?.turn, issued = turn?.temporaryCredential;
  return resolveSharedSecret(turn).length > 0 || Boolean(issued?.username && issued?.credential && Number(issued.expiresAt) > Date.now() + 30_000);
}

export function resolveIceTransportPolicy(config) {
  return config?.publicAccess?.turn?.forceRelay === true ? "relay" : undefined;
}

export function validateShareGrant(token, config, nowSeconds = Math.floor(Date.now() / 1000)) {
  try {
    if (config?.publicAccess?.enabled !== true) return { ok: false, reason: "public_access_disabled" };
    const [payloadText, signatureText] = String(token || "").split(".");
    if (!payloadText || !signatureText) return { ok: false, reason: "share_invalid" };
    const secret = resolveFileOrDirectSecret(config?.publicAccess?.sharing?.secret, config?.publicAccess?.sharing?.secretFile);
    if (secret.length < 32) return { ok: false, reason: "share_unavailable" };
    const expected = crypto.createHmac("sha256", secret).update(payloadText).digest("base64url");
    const actual = Buffer.from(signatureText), wanted = Buffer.from(expected);
    if (actual.length !== wanted.length || !crypto.timingSafeEqual(actual, wanted)) return { ok: false, reason: "share_invalid" };
    const payload = JSON.parse(Buffer.from(payloadText, "base64url").toString("utf8"));
    if (!payload?.jti || !payload?.project || !["control", "viewer"].includes(payload?.scope)) return { ok: false, reason: "share_invalid" };
    if (Number(payload.exp) > 0 && nowSeconds >= Number(payload.exp)) return { ok: false, reason: "share_expired" };
    const registry = readShareRegistry(config?.publicAccess?.sharing?.registryFile);
    const record = registry.find(x => x?.id === payload.jti);
    if (!record || record.revoked === true) return { ok: false, reason: "share_revoked" };
    return { ok: true, id: payload.jti, projectId: payload.project, readOnly: payload.scope === "viewer", maxOnline: Math.max(1, Number(payload.maxOnline) || 1), expiresAt: Number(payload.exp) || 0 };
  } catch { return { ok: false, reason: "share_invalid" }; }
}

export function shareFailureMessage(reason) {
  return ({
    public_access_disabled: "管理员已关闭公网访问。",
    share_expired: "此分享链接已过期，请联系管理员重新创建。",
    share_revoked: "此分享链接已被管理员撤销。",
    share_online_limit: "此分享链接的在线人数已满，请稍后重试。",
    public_capacity_reached: "公网服务当前已达到总并发上限，请稍后重试。",
    turn_capacity_reached: "TURN 中继当前已达到并发上限，请稍后重试。",
    turn_daily_budget_exhausted: "今日 TURN 中继流量额度已用完，请联系管理员。",
    public_rate_limited: "此设备短时间内连接次数过多，请稍后重试。",
    share_invalid: "此分享链接无效或已被修改。",
    share_unavailable: "公网分享服务暂不可用，请联系管理员。"
  })[reason] || "无法使用此分享链接。";
}

function readShareRegistry(configuredPath) {
  const file = expandEnvironment(String(configuredPath || ""));
  if (!file) return [];
  try { const value = JSON.parse(fs.readFileSync(file, "utf8")); return Array.isArray(value?.links) ? value.links : []; } catch { return []; }
}

export function validateActiveShare(id, config, expiresAt = 0, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (config?.publicAccess?.enabled !== true) return { ok: false, reason: "public_access_disabled" };
  if (Number(expiresAt) > 0 && nowSeconds >= Number(expiresAt)) return { ok: false, reason: "share_expired" };
  const record = readShareRegistry(config?.publicAccess?.sharing?.registryFile).find(x => x?.id === id);
  if (!record || record.revoked === true) return { ok: false, reason: "share_revoked" };
  return { ok: true };
}

function resolveFileOrDirectSecret(direct, configuredPath) {
  const value = String(direct || "");
  if (value.length >= 32) return value;
  const file = expandEnvironment(String(configuredPath || ""));
  try { return file ? fs.readFileSync(file, "utf8").trim() : ""; } catch { return ""; }
}

function expandEnvironment(value) { return value.replace(/%([^%]+)%/g, (_match, name) => process.env[name] || ""); }

function resolveSharedSecret(turn) {
  const configured = String(turn?.sharedSecretFile || "").replace(/%([^%]+)%/g, (_match, name) => process.env[name] || "");
  if (!configured) return "";
  try { return fs.readFileSync(configured, "utf8").trim(); } catch { return ""; }
}
