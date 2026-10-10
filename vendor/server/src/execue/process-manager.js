import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { mergeExecCommands } from "../shared/ue-exec-commands.js";
import { message, Types } from "../shared/protocol.js";

// Windows PowerShell may use the OEM code page when launched by bundled Node.
// Match its stdout encoding to Node's decoder for all process/path queries.
const powershellUtf8 = '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false);';

export class ProcessManager {
  constructor(config, logger, send, operations = {}) {
    this.config = config;
    this.logger = logger;
    this.send = send;
    this.operations = { spawn, identity: queryProcessIdentity, stop: stopVerifiedProcess, ...operations };
    this.processes = new Map();
    this.allowed = new Map((config.allowedProjects || []).map(x => [x.id, path.resolve(x.executable)]));
    this.registryPath = path.resolve(config.registryPath || "execue-instance-registry.json");    this.orphanCandidates = new Map();
    this.orphanCleanupInFlight = new Set();
    this.recentStopDirectories = new Map();
    this.restore();
    const auditSeconds = Math.max(10, Number(config.orphanAuditSeconds) || 30);
    this.auditTimer = setInterval(() => this.auditOrphanCandidates(), auditSeconds * 1000);
    this.auditTimer.unref?.();
  }

  /** 热重载允许的项目白名单（启动器在服务运行期间新增项目时调用；否则第二个项目会被拒） */
  setAllowedProjects(projects) {
    this.allowed = new Map((projects || []).map(x => [x.id, path.resolve(x.executable)]));
  }

  start(request) {
    if (this.processes.has(request.instanceId)) return;
    const allowedPath = this.allowed.get(request.projectId);
    const executable = path.resolve(request.executable || "");
    if (!allowedPath || allowedPath.toLowerCase() !== executable.toLowerCase()) throw new Error("project executable is not allowlisted");
    if (!fs.existsSync(executable)) throw new Error("project executable does not exist");
    const args = mergeExecCommands(Array.isArray(request.args) ? request.args.map(String) : [], { "au.LinearGainScalarForFinalOutut": request.localAudio === true ? 1 : 0 });
    const portPolicy = applyWebRtcPortRange(args, request.ueVersion, request.webRtcPortPolicy);
    const engineUrl = new URL(this.config.signalUrl);
    engineUrl.pathname = `/engine/${encodeURIComponent(request.projectId)}/${encodeURIComponent(request.instanceId)}`;
    engineUrl.searchParams.set("token", this.config.engineToken || "");
    engineUrl.searchParams.set("project", request.projectId);
    engineUrl.searchParams.set("instance", request.instanceId);
    engineUrl.protocol = engineUrl.protocol === "wss:" ? "wss:" : "ws:";
    applySignallingUrlArgument(args, engineUrl.toString(), request.ueVersion, request.engineAuthTicket, request.pixelStreamingProtocol, request.pixelStreamingPlugin);
    // UE 5.8 PixelStreaming2 does not start reliably with -RenderOffScreen / hidden windows.
    {
      const ver = String(request.ueVersion || "");
      const vm = ver.match(/^(\d+)(?:\.(\d+))?/);
      const isPs2 = request.pixelStreamingPlugin === "PixelStreaming2" || String(request.pixelStreamingProtocol).toLowerCase() === "unified";
      const is58 = Number(vm?.[1] || 0) > 5 || (Number(vm?.[1] || 0) === 5 && Number(vm?.[2] || 0) >= 8);
      if (isPs2 || is58) {
        for (let i = args.length - 1; i >= 0; i--) {
          if (/^-RenderOffScreen$/i.test(String(args[i])) || /^-RenderOffscreen$/i.test(String(args[i]))) args.splice(i, 1);
        }
      }
    }
    if (Number.isInteger(request.gpuIndex) && !args.some(x => x.startsWith("-GraphicsAdapter="))) args.push(`-GraphicsAdapter=${request.gpuIndex}`);
    if (!args.some(x => /^-HttpNoProxy=/i.test(x))) args.push("-HttpNoProxy=127.0.0.1,localhost,::1");
    // Keep the user's global proxy untouched and bypass only local addresses for UE.
    const noProxy = [process.env.NO_PROXY, process.env.no_proxy, "127.0.0.1", "localhost", "::1"].filter(Boolean).join(",");
    const childEnv = { ...process.env, NO_PROXY: noProxy, no_proxy: noProxy };
    const hideOsWindow = !(request.pixelStreamingPlugin === "PixelStreaming2" || String(request.pixelStreamingProtocol).toLowerCase() === "unified" || String(request.ueVersion || "").match(/^5\.(?:[89]|[1-9]\d)/));
    const child = this.operations.spawn(executable, args, { cwd: path.dirname(executable), windowsHide: hideOsWindow, stdio: ["ignore", "pipe", "pipe"], env: childEnv });
    this.logger.info("instance.launch_arguments", { instanceId: request.instanceId, projectId: request.projectId, ueVersion: request.ueVersion || "", pixelStreamingPlugin: request.pixelStreamingPlugin || "", pixelStreamingProtocol: request.pixelStreamingProtocol || "", args: sanitizeLaunchArgs(args) });
    this.logger.info("instance.network_policy_applied", { instanceId: request.instanceId, projectId: request.projectId, bypass: "127.0.0.1,localhost,::1", webRtcPortPolicy: portPolicy });
    const identity = this.operations.identity(child.pid);
    const record = { instanceId: request.instanceId, projectId: request.projectId, executable, processExecutable: identity?.executable || executable, child, pid: child.pid, launchPid: child.pid, startedAt: Date.now(), creationDate: identity?.creationDate || "", engineAuthTicket: request.engineAuthTicket || "", stopping: false };
    this.processes.set(request.instanceId, record);
    this.persist();
    record.promoteTimer = setTimeout(() => this.promoteRuntimeProcess(record), 5000);
    record.promoteTimer.unref?.();
    // UE can echo its credential-bearing command line; never forward raw output.
    child.stdout?.on("data", data => this.logger.debug("instance.stdout", { instanceId: request.instanceId, bytes: data.length }));
    child.stderr?.on("data", data => {
      const text = data.toString().trim().slice(0, 2000);
      if (/IsUnifiedPlan\(\)|GetTransceivers is only supported with Unified Plan/i.test(text)) record.fatalReason = "ue_webrtc_protocol_incompatible";
      if (/(PixelStreaming).*(plugin|module).*(failed|missing|not found|could not|unable)|plugin.*PixelStreaming.*failed/i.test(text)) record.fatalReason = "pixel_streaming_plugin_missing";
      this.logger.warn("instance.stderr", { instanceId: request.instanceId, bytes: data.length, reasonCode: record.fatalReason || "ue_stderr" });
    });
    const finish = (exitCode, signal, failed = false) => {
      if (record.completed) return;
      record.completed = true;
      clearTimeout(record.promoteTimer);
      this.recentStopDirectories.set(path.dirname(record.executable).toLowerCase(), Date.now() + 30_000);
      this.processes.delete(request.instanceId); this.persist();
      const runtimeMs = Date.now() - record.startedAt;
      const reasonCode = failed ? "ue_start_failed" : record.reasonCode || (runtimeMs < 10_000 ? "ue_start_failed" : exitCode && exitCode !== 0 ? "ue_process_crashed" : "ue_process_exited");
      this.send(message(Types.InstanceExited, { instanceId: request.instanceId, projectId: request.projectId, pid: record.pid, exitCode, signal, reasonCode, runtimeMs }));
      this.logger.info("instance.exited", { instanceId: request.instanceId, pid: record.pid, exitCode, signal, reasonCode, runtimeMs });
    };
    child.once("error", () => { this.logger.error("instance.spawn_error", { instanceId: request.instanceId, reasonCode: "ue_start_failed" }); finish(null, null, true); });
    child.once("exit", (code, signal) => finish(code, signal));
    child.once("close", (code, signal) => finish(code, signal));
    child.once("spawn", () => {
      if (record.completed) return;
      const identity = this.operations.identity(child.pid);
      if (identity) Object.assign(record, { creationDate: identity.creationDate, processExecutable: identity.executable });
      this.persist();
      this.send(message(Types.InstanceStarted, { instanceId: request.instanceId, projectId: request.projectId, pid: child.pid, proxyDetected: process.env.PEERSTREAM_SYSTEM_PROXY_DETECTED === "1", proxyBypass: "environment+HttpNoProxy" }));
      this.logger.info("instance.started", { instanceId: request.instanceId, projectId: request.projectId, pid: child.pid });
    });
  }

  async stop(request) {
    const record = this.processes.get(request.instanceId);
    if (!record) return this.send(message(Types.InstanceStopped, { instanceId: request.instanceId, reasonCode: request.reasonCode, alreadyStopped: true }));
    if (record.stopping) return;
    record.stopping = true;
    record.reasonCode = record.fatalReason || request.reasonCode || "requested";
    this.recentStopDirectories.set(path.dirname(record.executable).toLowerCase(), Date.now() + 30_000);
    this.persist();
    try {
      const result = await this.operations.stop(record);
      if (!result?.ok) throw new Error("process_stop_failed");
      if (!record.completed) {
        record.completed = true;
        clearTimeout(record.promoteTimer);
        this.processes.delete(request.instanceId); this.persist();
        this.send(message(Types.InstanceStopped, { instanceId: request.instanceId, projectId: record.projectId, pid: record.pid, reasonCode: record.reasonCode }));
      }
    } catch (error) {
      if (record.completed) return;
      record.stopping = false;
      this.persist();
      const diagnostic = stopDiagnostic(error);
      this.send(message(Types.Error, { requestType: Types.InstanceStop, instanceId: request.instanceId, reasonCode: "process_stop_failed", ...diagnostic, detail: `停止未确认（${diagnostic.failureCode}）：请查看执行端日志后重试。` }));
      this.logger.warn("instance.stop_failed", { instanceId: request.instanceId, pid: record.pid, reasonCode: "process_stop_failed", ...diagnostic });
    }
  }

  snapshot(includeAuthTickets = false) {
    return [...this.processes.values()].map(x => ({ instanceId: x.instanceId, projectId: x.projectId, pid: x.pid, launchPid: x.launchPid || x.pid, startedAt: x.startedAt, creationDate: x.creationDate, executable: x.executable, processExecutable: x.processExecutable || x.executable, recovered: !x.child, ...(includeAuthTickets && x.engineAuthTicket ? { engineAuthTicket: x.engineAuthTicket } : {}) }));
  }

  persist() {
    try {
      fs.mkdirSync(path.dirname(this.registryPath), { recursive: true });
      const data = { schemaVersion: 1, updatedAt: new Date().toISOString(), instances: this.snapshot() };
      fs.writeFileSync(this.registryPath + ".tmp", JSON.stringify(data, null, 2), "utf8");
      fs.rmSync(this.registryPath, { force: true });
      fs.renameSync(this.registryPath + ".tmp", this.registryPath);
    } catch (error) { this.logger.warn("registry.write_failed", { error: error.message }); }
  }

  restore() {
    let entries = [];
    try { entries = JSON.parse(fs.readFileSync(this.registryPath, "utf8")).instances || []; } catch { return; }
    for (const item of entries) {
      let identity = queryProcessIdentity(Number(item.pid));
      const expected = path.resolve(item.executable || "");
      const sameProcess = Boolean(identity);
      if (!identity) identity = findDescendantIdentity(Number(item.launchPid || item.pid), expected);
      const expectedProcess = path.resolve(item.processExecutable || item.executable || "");
      const creationMatches = sameProcess
        ? identity?.creationDate === item.creationDate
        : isPlausibleRecoveredChild(identity?.creationDate, Number(item.startedAt));
      if (!identity || !creationMatches || (identity.executable.toLowerCase() !== expectedProcess.toLowerCase() && !isInside(identity.executable, path.dirname(expected)))) {
        this.logger.warn("registry.stale_removed", { instanceId: item.instanceId, pid: item.pid }); continue;
      }
      this.processes.set(item.instanceId, { instanceId: item.instanceId, projectId: item.projectId, executable: expected, processExecutable: identity.executable, child: null, pid: identity.pid || Number(item.pid), launchPid: Number(item.launchPid || item.pid), startedAt: Number(item.startedAt) || Date.now(), creationDate: identity.creationDate, stopping: false });
      this.logger.info("instance.recovered", { instanceId: item.instanceId, projectId: item.projectId, pid: identity.pid || item.pid });
    }
    this.persist();
  }

  promoteRuntimeProcess(record) {
    if (!this.processes.has(record.instanceId)) return;
    const identity = findDescendantIdentity(record.launchPid, record.executable) || queryProcessIdentity(record.pid);
    if (!identity) return;
    if (identity.pid && identity.pid !== record.pid) this.logger.info("instance.runtime_pid_promoted", { instanceId: record.instanceId, launchPid: record.pid, pid: identity.pid });
    Object.assign(record, { pid: identity.pid || record.pid, processExecutable: identity.executable, creationDate: identity.creationDate });
    this.persist();
  }

  auditOrphanCandidates() {
    if (process.platform !== "win32" || this.config.orphanAuditEnabled === false) return;
    const roots = new Set([...this.processes.values()].flatMap(x => [Number(x.pid), Number(x.launchPid)]).filter(Boolean));
    const directories = [...new Set([...this.allowed.values()].map(x => path.dirname(x).toLowerCase()))];
    try {
      const values = this.operations.listProcesses?.() ?? listWindowsProcesses();
      const registered = collectManagedProcessIds(values, roots);
      const now = Date.now();
      for (const [directory, expiresAt] of this.recentStopDirectories) if (expiresAt <= now) this.recentStopDirectories.delete(directory);
      for (const item of values) {
        const pid = Number(item.ProcessId), executable = path.resolve(item.ExecutablePath || "");
        if (!pid || registered.has(pid) || !directories.some(directory => isInside(executable, directory)) || [...this.recentStopDirectories].some(([directory, expiresAt]) => expiresAt > now && isInside(executable, directory))) continue;
        const previous = this.orphanCandidates.get(pid) || { confirmations: 0, executable };
        previous.confirmations++; previous.lastSeenAt = Date.now(); this.orphanCandidates.set(pid, previous);
        if (previous.confirmations === 1) this.logger.warn("orphan.candidate_detected", { pid, executable, confirmations: 1, requiredConfirmations: 2, mode: "report_only", action: "none" });
        else if (previous.confirmations === 2) this.logger.warn("orphan.candidate_confirmed", { pid, executable, confirmations: 2, mode: "report_only", action: "none", message: "连续两次巡检确认，等待安全清理条件" });
        if (previous.confirmations >= 2 && canCleanProjectHelper(item, values, [...this.allowed.values()], [...this.processes.values()]) && !this.orphanCleanupInFlight.has(pid)) {
          this.orphanCleanupInFlight.add(pid);
          const identity = { pid, creationDate: String(item.CreationDate || ""), processExecutable: executable };
          void this.operations.stop(identity).then(result => {
            if (!result?.ok) throw stopError("process_stop_failed");
            this.orphanCandidates.delete(pid);
            this.logger.info("orphan.helper_cleaned", { pid, executable });
          }).catch(error => {
            this.logger.warn("orphan.helper_cleanup_failed", { pid, executable, ...stopDiagnostic(error) });
          }).finally(() => this.orphanCleanupInFlight.delete(pid));
        }
      }
      const livePids = new Set(values.map(x => Number(x.ProcessId))); for (const pid of this.orphanCandidates.keys()) if (!livePids.has(pid) || registered.has(pid)) this.orphanCandidates.delete(pid);
    } catch (error) { this.logger.debug("orphan.audit_failed", { error: error.message }); }
  }
}

function listWindowsProcesses() {
  const command = "Get-CimInstance Win32_Process|Where-Object {$_.ExecutablePath}|Select-Object ProcessId,ParentProcessId,ExecutablePath,@{n='CreationDate';e={$_.CreationDate.ToUniversalTime().ToString('O')}}|ConvertTo-Json -Compress";
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", powershellUtf8 + command], { windowsHide: true, encoding: "utf8", timeout: 8000, maxBuffer: 8 * 1024 * 1024 });
  const parsed = JSON.parse(result.stdout.trim());
  return Array.isArray(parsed) ? parsed : [parsed];
}

export function applySignallingUrlArgument(args, engineUrl, ueVersion, engineAuthTicket = "", streamingProtocol = "", plugin = "") {
  const managedUrl = /^-PixelStreaming(?:2[._]?)?(?:Signalling|Connection)?URL=/i;
  const managedIpPort = /^-PixelStreaming(?:IP|Port)=/i;
  const preserved = args.filter(x => !managedUrl.test(String(x)) && !managedIpPort.test(String(x)));
  const match = String(ueVersion || "").match(/^(\d+)(?:\.(\d+))?/);
  const major = Number(match?.[1] || 0), minor = Number(match?.[2] || 0);
  const pixelStreaming2 = plugin ? plugin === "PixelStreaming2" : String(streamingProtocol).toLowerCase() === "unified";
  const ue58OrNewer = major > 5 || (major === 5 && minor >= 8);
  const pushUnique = value => { if (!preserved.some(x => String(x).toLowerCase() === String(value).toLowerCase())) preserved.push(value); };

  let resolved = engineUrl;
  try {
    const u = new URL(engineUrl);
    if (u.pathname.includes("/engine/")) {
      const seg = u.pathname.split("/").filter(Boolean);
      if (seg[1]) u.searchParams.set("project", seg[1]);
      if (seg[2]) u.searchParams.set("instance", seg[2]);
    }
    resolved = u.toString();
  } catch { /* keep raw */ }

  if (pixelStreaming2 && engineAuthTicket && !ue58OrNewer) {
    const url = new URL(resolved);
    url.pathname = `${url.pathname.replace(/\/$/, "")}/token=${encodeURIComponent(engineAuthTicket)}`;
    url.searchParams.delete("token");
    resolved = url.toString();
  }

  if (pixelStreaming2 && ue58OrNewer) {
    // Bare ws://host:port (official shape). Identity rides in the query string.
    // No extra quotes — 5.3 (which works) passes unquoted URLs.
    const u = new URL(resolved);
    const hostPort = `${u.protocol}//${u.host}/`;
    const identity = `?project=${encodeURIComponent(u.searchParams.get("project") || "")}&instance=${encodeURIComponent(u.searchParams.get("instance") || "")}&token=${encodeURIComponent(u.searchParams.get("token") || "")}`;
    const primary = hostPort + identity;
    for (const option of ["-PixelStreamingURL", "-PixelStreamingConnectionURL", "-PixelStreamingSignallingURL", "-PixelStreaming2.ConnectionURL"]) {
      pushUnique(`${option}=${primary}`);
    }
    pushUnique(`-PixelStreamingIP=${u.hostname}`);
    pushUnique(`-PixelStreamingPort=${u.port || "12188"}`);
    pushUnique("-PixelStreaming2.AutoStartStream=true");
    pushUnique("-PixelStreaming2.InitializeDefaultStreamer=true");
  } else if (pixelStreaming2 && major === 5 && minor === 5) {
    pushUnique(`-PixelStreamingSignallingURL=${resolved}`);
    pushUnique(`-PixelStreamingURL=${resolved}`);
  } else if (pixelStreaming2) {
    for (const option of ["-PixelStreamingConnectionURL", "-PixelStreamingURL", "-PixelStreamingSignallingURL"]) {
      pushUnique(`${option}=${resolved}`);
    }
  } else {
    pushUnique(`-PixelStreamingURL=${resolved}`);
  }
  args.splice(0, args.length, ...preserved);
  return args;
}

function sanitizeLaunchArgs(args) {
  return (args || []).map(value => String(value).replace(/(token=)[^/&\s"]+/ig, "$1<redacted>"));
}

export function applyWebRtcPortRange(args, ueVersion = "", policy = null) {
  const match = String(ueVersion || "").match(/^(\d+)(?:\.(\d+))?/), major = Number(match?.[1] || 0), minor = Number(match?.[2] || 0);
  const legacy = major > 0 && (major < 5 || (major === 5 && minor <= 3));
  const filtered = args.filter(x => !/^-PixelStreamingWebRTC(?:Min|Max)Port=/i.test(String(x)));
  const requestedMode = String(policy?.mode || "").toLowerCase();
  // Missing policy means an existing pre-policy project: retain the historic fixed range.
  const mode = legacy ? "unsupported" : requestedMode === "auto" ? "auto" : requestedMode === "custom" ? "custom" : "fixed";
  let minPort = 0, maxPort = 0;
  if (mode === "fixed") { minPort = 49160; maxPort = 49259; }
  else if (mode === "custom") {
    minPort = Number(policy?.minPort); maxPort = Number(policy?.maxPort);
    if (!Number.isInteger(minPort) || !Number.isInteger(maxPort) || minPort < 1024 || maxPort > 65535 || minPort > maxPort) throw new Error("invalid WebRTC UDP port range");
  }
  if (minPort) filtered.push(`-PixelStreamingWebRTCMinPort=${minPort}`, `-PixelStreamingWebRTCMaxPort=${maxPort}`);
  args.splice(0, args.length, ...filtered);
  return { mode, minPort: minPort || null, maxPort: maxPort || null };
}

export function collectManagedProcessIds(values, roots) {
  const managed = new Set([...roots].map(Number).filter(Boolean));
  let changed;
  do {
    changed = false;
    for (const item of values) {
      const pid = Number(item.ProcessId), parent = Number(item.ParentProcessId);
      if (pid && managed.has(parent) && !managed.has(pid)) { managed.add(pid); changed = true; }
    }
  } while (changed);
  return managed;
}

export function canCleanProjectHelper(item, values, allowedExecutables, activeRecords = []) {
  const pid = Number(item?.ProcessId);
  const executable = item?.ExecutablePath ? path.resolve(item.ExecutablePath) : "";
  if (!Number.isInteger(pid) || pid <= 0 || !executable || !Number.isFinite(Date.parse(item.CreationDate || ""))) return false;
  const owners = allowedExecutables.filter(ue =>
    path.resolve(path.join(path.dirname(ue), "Engine", "Binaries", "Win64", "EpicWebHelper.exe")).toLowerCase() === executable.toLowerCase());
  if (!owners.length) return false;
  const ownerPaths = new Set(owners.map(ue => path.resolve(ue).toLowerCase()));
  if (activeRecords.some(record => ownerPaths.has(path.resolve(record.executable || "").toLowerCase()))) return false;
  if (values.some(value => value.ExecutablePath && ownerPaths.has(path.resolve(value.ExecutablePath).toLowerCase()))) return false;
  return true;
}

function queryProcessIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform !== "win32") { try { process.kill(pid, 0); return { creationDate: "", executable: "" }; } catch { return null; } }
  const command = `$p=Get-CimInstance Win32_Process -Filter \"ProcessId=${pid}\" -ErrorAction SilentlyContinue;if($p){[pscustomobject]@{creationDate=$p.CreationDate.ToUniversalTime().ToString('O');executable=[string]$p.ExecutablePath}|ConvertTo-Json -Compress}`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", powershellUtf8 + command], { windowsHide: true, encoding: "utf8", timeout: 5000 });
  try { const value = JSON.parse(result.stdout.trim()); return { pid, creationDate: value.creationDate || "", executable: path.resolve(value.executable || "") }; } catch { return null; }
}

function findDescendantIdentity(rootPid, configuredExecutable) {
  if (process.platform !== "win32") return null;
  const command = "Get-CimInstance Win32_Process|Select-Object ProcessId,ParentProcessId,@{n='CreationDate';e={$_.CreationDate.ToUniversalTime().ToString('O')}},ExecutablePath|ConvertTo-Json -Compress";
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", powershellUtf8 + command], { windowsHide: true, encoding: "utf8", timeout: 8000, maxBuffer: 8 * 1024 * 1024 });
  try {
    const values = JSON.parse(result.stdout.trim()); const list = Array.isArray(values) ? values : [values]; const descendants = new Set([rootPid]); let changed;
    do { changed = false; for (const item of list) if (descendants.has(Number(item.ParentProcessId)) && !descendants.has(Number(item.ProcessId))) { descendants.add(Number(item.ProcessId)); changed = true; } } while (changed);
    const directory = path.dirname(path.resolve(configuredExecutable));
    const expectedName = path.basename(path.resolve(configuredExecutable)).toLowerCase();
    const candidates = list.filter(item => Number(item.ProcessId) !== rootPid && descendants.has(Number(item.ProcessId)) && item.ExecutablePath && isInside(path.resolve(item.ExecutablePath), directory));
    const selected = candidates.find(item => path.basename(item.ExecutablePath).toLowerCase() === expectedName) || candidates[0];
    return selected ? { pid: Number(selected.ProcessId), creationDate: String(selected.CreationDate || ""), executable: path.resolve(selected.ExecutablePath) } : null;
  } catch { return null; }
}

function isPlausibleRecoveredChild(creationDate, startedAt) {
  const createdAt = Date.parse(creationDate || "");
  return Number.isFinite(createdAt) && Number.isFinite(startedAt) && createdAt >= startedAt - 60_000;
}

function isInside(file, directory) {
  const root = path.resolve(directory).toLowerCase().replace(/[\\/]+$/, "") + path.sep;
  return path.resolve(file).toLowerCase().startsWith(root.toLowerCase());
}

// Pin process handles and validate identity in the same helper that terminates them.
// Never pass a previously checked PID to taskkill (PID reuse can race that call).
const stopFailureCodes = new Set(['process_identity_unknown', 'process_identity_mismatch', 'process_stop_access_denied', 'process_stop_timeout', 'process_stop_helper_failed', 'process_stop_failed']);
function stopDiagnostic(error) {
  const detail = error?.stopDiagnostic;
  return {
    failureCode: stopFailureCodes.has(detail?.failureCode) ? detail.failureCode : 'process_stop_failed',
    ...(Number.isInteger(detail?.failedPid) && detail.failedPid > 0 ? { failedPid: detail.failedPid } : {}),
    ...(['root_identity', 'tree_snapshot', 'open_handle', 'handle_identity', 'terminate', 'wait_exit', 'helper'].includes(detail?.stopStage) ? { stopStage: detail.stopStage } : {}),
    ...(Number.isInteger(detail?.helperExitCode) ? { helperExitCode: detail.helperExitCode } : {})
  };
}
function stopError(failureCode, fields = {}) {
  const error = new Error(failureCode);
  error.stopDiagnostic = { failureCode, ...fields };
  return error;
}
export function stopVerifiedProcess(record) {
  if (process.platform !== "win32") return Promise.reject(new Error("verified_stop_requires_windows"));
  if (!Number.isInteger(record.pid) || !record.creationDate || !record.processExecutable) return Promise.reject(stopError("process_identity_unknown", { stopStage: 'root_identity' }));
  const script = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$r = $env:PEERSTREAM_STOP_IDENTITY | ConvertFrom-Json
$handles = [System.Collections.Generic.List[System.Diagnostics.Process]]::new()
$stage = 'root_identity'
$targetPid = [int]$r.pid
function Fail([string]$code, [int]$exitCode) {
  [pscustomobject]@{failureCode=$code;stopStage=$stage;failedPid=$targetPid} | ConvertTo-Json -Compress
  exit $exitCode
}
try {
  $root = Get-CimInstance Win32_Process -Filter ("ProcessId=" + [int]$r.pid)
  if (-not $root) { exit 0 }
  if ($root.CreationDate.ToUniversalTime().Ticks -ne ([datetime]$r.creationDate).ToUniversalTime().Ticks -or $root.ExecutablePath -ine $r.executable) { Fail 'process_identity_mismatch' 3 }
  $stage = 'tree_snapshot'
  $all = @(Get-CimInstance Win32_Process)
  $selected = [System.Collections.Generic.List[object]]::new()
  $selected.Add($root)
  do {
    $added = $false
    foreach ($p in $all) {
      if ($selected.ProcessId -contains $p.ProcessId) { continue }
      $parent = $selected | Where-Object { $_.ProcessId -eq $p.ParentProcessId } | Select-Object -First 1
      if ($parent -and $p.CreationDate -ge $parent.CreationDate) { $selected.Add($p); $added = $true }
    }
  } while ($added)
  foreach ($p in $selected) {
    $targetPid = [int]$p.ProcessId
    $stage = 'open_handle'
    try { $handle = [System.Diagnostics.Process]::GetProcessById([int]$p.ProcessId) } catch [System.ArgumentException] { continue }
    $handles.Add($handle)
    $null = $handle.Handle
    if ($handle.HasExited) { continue }
    $stage = 'handle_identity'
    if ([math]::Floor([decimal]$handle.StartTime.ToUniversalTime().Ticks / 10) -ne [math]::Floor([decimal]$p.CreationDate.ToUniversalTime().Ticks / 10)) { Fail 'process_identity_mismatch' 3 }
    if (-not $p.ExecutablePath -or $handle.MainModule.FileName -ine $p.ExecutablePath) { Fail 'process_identity_mismatch' 3 }
  }
  for ($i = $handles.Count - 1; $i -ge 0; $i--) {
    $p = $handles[$i]
    $targetPid = $p.Id
    $stage = 'terminate'
    if (-not $p.HasExited) { $p.Kill() }
    $stage = 'wait_exit'
    if (-not $p.WaitForExit(3000)) { Fail 'process_stop_timeout' 4 }
  }
  exit 0
} catch {
  $ex = $_.Exception
  while ($ex.InnerException) { $ex = $ex.InnerException }
  if ($ex -is [System.ComponentModel.Win32Exception] -and $ex.NativeErrorCode -eq 5) { Fail 'process_stop_access_denied' 2 }
  Fail 'process_stop_helper_failed' 2
} finally { foreach ($p in $handles) { $p.Dispose() } }
`;
  return new Promise((resolve, reject) => {
    const helper = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
      windowsHide: true, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, PEERSTREAM_STOP_IDENTITY: JSON.stringify({ pid: record.pid, creationDate: record.creationDate, executable: record.processExecutable }) }
    });
    let output = '';
    helper.stdout.on('data', chunk => { if (output.length < 4096) output += chunk.toString('utf8').slice(0, 4096 - output.length); });
    const timer = setTimeout(() => { helper.kill(); reject(stopError("process_stop_timeout", { stopStage: 'helper' })); }, 15000);
    helper.once("error", () => { clearTimeout(timer); reject(stopError("process_stop_helper_failed", { stopStage: 'helper' })); });
    helper.once("close", code => {
      clearTimeout(timer);
      if (code === 0) return resolve({ ok: true });
      let diagnostic;
      try { diagnostic = JSON.parse(output); } catch { diagnostic = { failureCode: 'process_stop_helper_failed', stopStage: 'helper' }; }
      reject(stopError(diagnostic.failureCode, { ...stopDiagnostic({ stopDiagnostic: diagnostic }), helperExitCode: code }));
    });
  });
}
