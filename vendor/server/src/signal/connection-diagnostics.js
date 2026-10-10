const stages = new Set(['checking', 'starting', 'queued', 'connecting', 'connected', 'reconnecting', 'failed', 'ended']);
const candidateTypes = new Set(['host', 'srflx', 'prflx', 'relay']);
const protocols = new Set(['udp', 'tcp', 'tls']);
const networkTypes = new Set(['ethernet', 'wifi', 'cellular', 'vpn', 'unknown']);
const iceStates = new Set(['new', 'checking', 'connected', 'completed', 'failed', 'disconnected', 'closed']);
const normalized = (value, allowed) => { const text = String(value || '').toLowerCase(); return allowed.has(text) ? text : undefined; };
export function acceptConnectionDiagnostics(session, value) {
  if (value.sessionId !== session.id) return false;
  session.connectionDiagnostics ||= { version: 1, stage: 'starting', result: 'connecting' };
  const diagnostic = session.connectionDiagnostics;
  if (stages.has(value.stage)) diagnostic.stage = value.stage;
  if (diagnostic.firstFrameMs === undefined && Number.isInteger(value.firstFrameMs) && value.firstFrameMs >= 0 && value.firstFrameMs <= 86400000 && ['presented', 'playing'].includes(value.firstFrameSource)) {
    diagnostic.firstFrameMs = value.firstFrameMs;
    diagnostic.firstFrameSource = value.firstFrameSource;
    diagnostic.result = 'success';
  }
  return true;
}
export function sessionConnectionDiagnostics(session, ended) {
  if (!session.connectionDiagnostics) return undefined;
  const diagnostic = { ...session.connectionDiagnostics };
  const telemetry = session.lastTelemetry || {};
  const observed = {
    localCandidateType: normalized(telemetry.localCandidateType, candidateTypes),
    remoteCandidateType: normalized(telemetry.remoteCandidateType, candidateTypes),
    transportProtocol: normalized(telemetry.transportProtocol, protocols),
    relayProtocol: normalized(telemetry.relayProtocol, protocols),
    networkType: normalized(telemetry.networkType, networkTypes),
    iceState: normalized(telemetry.ice, iceStates),
  };
  for (const [key, value] of Object.entries(observed)) if (value) diagnostic[key] = value;
  if (ended) {
    diagnostic.stage = 'ended';
    diagnostic.endReason = session.terminalReason || session.forcedCloseReason || session.connectionFailure || session.connectionEndReason || 'player_disconnected';
    if (diagnostic.result !== 'success') diagnostic.result = session.connectionFailure ? 'failed' : 'interrupted';
  }
  return diagnostic;
}
