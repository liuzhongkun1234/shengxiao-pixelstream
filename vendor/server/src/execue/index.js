import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { loadJsonConfig, resolveFrom, requireString } from "../shared/config.js";
import { createLogger } from "../shared/logger.js";
import { message, parseMessage, sendJson, Types } from "../shared/protocol.js";
import { ProcessManager } from "./process-manager.js";
import { detectGpuCapabilities } from "./gpu-capabilities.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const loaded = loadJsonConfig(process.argv[2], path.resolve(here, "../../config/execue.json"));
const config = loaded.config;
config.registryPath = resolveFrom(loaded.directory, config.registryPath || "../../logs/source/execue-instance-registry.json");
requireString(config.id, "id");
requireString(config.signalUrl, "signalUrl");
requireString(config.token, "token");
const logger = createLogger("execue-source", { ...config.logging, directory: resolveFrom(loaded.directory, config.logging?.directory) });
let socket;
let reconnectFailures = 0;
let reconnectTimer;
const manager = new ProcessManager(config, logger, value => sendJson(socket, value));
const gpuCapabilities = detectGpuCapabilities();


function sendStatus() {
  if (socket?.readyState !== WebSocket.OPEN) return;
  socket.ping();
  sendJson(socket, message(Types.AgentStatus, { execueId: config.id, instances: manager.snapshot(true), recovered: true, gpuCapabilities }));
}

function connect() {
  const url = new URL(config.signalUrl);
  url.searchParams.set("id", config.id);
  url.searchParams.set("token", config.token);
  socket = new WebSocket(url);
  socket.on("open", () => { reconnectFailures = 0; logger.info("signal.connected", { url: `${url.origin}${url.pathname}`, execueId: config.id }); sendStatus(); });
  socket.on("message", data => {
    let value;
    try { value = parseMessage(data); } catch (error) { return logger.warn("protocol.invalid", { error: error.message }); }
    try {
      if (value.type === Types.Ping) return sendJson(socket, message(Types.Pong));
      if (value.type === Types.InstanceStart) return manager.start(value);
      if (value.type === Types.InstanceStop) return void manager.stop(value);
    } catch (error) {
      logger.error("request.failed", { type: value.type, instanceId: value.instanceId, error: error.message });
      sendJson(socket, message(Types.Error, { requestType: value.type, instanceId: value.instanceId, detail: error.message }));
    }
  });
  socket.on("close", () => scheduleReconnect());
  socket.on("error", error => logger.warn("signal.error", { error: error.message }));
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  const delay = Math.min(30_000, 1000 * 2 ** Math.min(reconnectFailures++, 5));
  logger.warn("signal.reconnecting", { delay });
  reconnectTimer = setTimeout(connect, delay);
}

connect();
const heartbeat = setInterval(sendStatus, 5000);

// 白名单热重载：启动器在服务运行期间会新增项目（多项目并发），
// 不在白名单里的项目实例会被拒绝（project executable is not allowlisted），所以每 2 秒检查配置。
const configWatch = setInterval(() => {
  try {
    const next = JSON.parse(fs.readFileSync(loaded.file, "utf8"));
    if (!Array.isArray(next.allowedProjects)) return;
    const before = JSON.stringify([...manager.allowed.entries()].sort());
    const after = JSON.stringify(next.allowedProjects.map(x => [x.id, path.resolve(x.executable)]).sort());
    if (before === after) return;
    manager.setAllowedProjects(next.allowedProjects);
    logger.info("config.allowed_projects_reloaded", { count: next.allowedProjects.length });
  } catch {
    /* 配置可能正在写入，下一轮再试 */
  }
}, 2000);
configWatch.unref?.();

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { clearInterval(heartbeat); clearInterval(configWatch); clearTimeout(reconnectTimer); socket?.close(); process.exit(0); });
