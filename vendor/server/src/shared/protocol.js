export const PROTOCOL_VERSION = "peerstream.source.v1";

export const Types = Object.freeze({
  Hello: "hello",
  Ping: "ping",
  Pong: "pong",
  SessionActivity: "session.activity",
  SessionTelemetry: "session.telemetry",
  BitratePolicy: "bitrate.policy",
  SessionControlRequest: "session.control.request",
  SessionControlRole: "session.control.role",
  SessionIdleWarning: "session.idle_warning",
  Lifecycle: "instance.lifecycle",
  InstanceStart: "instance.start",
  InstanceStarted: "instance.started",
  InstanceStop: "instance.stop",
  InstanceStopped: "instance.stopped",
  InstanceExited: "instance.exited",
  AgentStatus: "agent.status",
  AdminStatusGet: "admin.status.get",
  AdminInstanceStop: "admin.instance.stop",
  AdminQueueCancel: "admin.queue.cancel",
  Error: "error"
});

export function message(type, fields = {}) {
  return { protocol: PROTOCOL_VERSION, type, timestamp: new Date().toISOString(), ...fields };
}

export function parseMessage(data) {
  const value = JSON.parse(Buffer.isBuffer(data) ? data.toString("utf8") : String(data));
  if (!value || typeof value !== "object" || typeof value.type !== "string") throw new Error("invalid message");
  return value;
}

export function sendJson(socket, value) {
  if (socket?.readyState === 1) socket.send(JSON.stringify(value));
}
