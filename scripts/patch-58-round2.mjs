import fs from 'fs';

// ---------- patch process-manager.js ----------
function patchProcessManager(path) {
  let s = fs.readFileSync(path, 'utf8');

  // 1) enrich engine URL with project/instance query (survives path-stripping clients)
  const urlBuildOld = `    engineUrl.pathname = \`/engine/\${encodeURIComponent(request.projectId)}/\${encodeURIComponent(request.instanceId)}\`;
    engineUrl.search = \`token=\${encodeURIComponent(this.config.engineToken || "")}\`;`;
  const urlBuildNew = `    engineUrl.pathname = \`/engine/\${encodeURIComponent(request.projectId)}/\${encodeURIComponent(request.instanceId)}\`;
    engineUrl.searchParams.set("token", this.config.engineToken || "");
    engineUrl.searchParams.set("project", request.projectId);
    engineUrl.searchParams.set("instance", request.instanceId);`;
  if (s.includes(urlBuildOld)) s = s.replace(urlBuildOld, urlBuildNew);
  else if (!s.includes('searchParams.set("project"')) {
    console.error(path, 'url build block not found');
  }

  // 2) replace applySignallingUrlArgument 5.8 branch with official multi-alias + quoted URL
  const start = s.indexOf('export function applySignallingUrlArgument');
  const end = s.indexOf('function sanitizeLaunchArgs', start);
  if (start < 0 || end < 0) {
    console.error(path, 'applySignallingUrlArgument bounds not found');
  } else {
    const fn = `export function applySignallingUrlArgument(args, engineUrl, ueVersion, engineAuthTicket = "", streamingProtocol = "", plugin = "") {
  const managedUrl = /^-PixelStreaming(?:2[._]?)?(?:Signalling|Connection)?URL=/i;
  const preserved = args.filter(x => !managedUrl.test(String(x)));
  const match = String(ueVersion || "").match(/^(\\d+)(?:\\.(\\d+))?/);
  const major = Number(match?.[1] || 0), minor = Number(match?.[2] || 0);
  const pixelStreaming2 = plugin ? plugin === "PixelStreaming2" : String(streamingProtocol).toLowerCase() === "unified";
  let resolvedEngineUrl = engineUrl;
  const ue58OrNewer = major > 5 || (major === 5 && minor >= 8);
  if (pixelStreaming2 && engineAuthTicket && !ue58OrNewer) {
    const url = new URL(engineUrl);
    url.pathname = \`\${url.pathname.replace(/\\/$/, "")}/token=\${encodeURIComponent(engineAuthTicket)}\`;
    url.searchParams.delete("token");
    resolvedEngineUrl = url.toString();
  }
  // Official docs quote the URL value; also helps FParse when the value contains '='.
  const q = (u) => \`"\${u}"\`;
  const pushUnique = value => { if (!preserved.some(x => String(x).toLowerCase() === String(value).toLowerCase())) preserved.push(value); };
  if (pixelStreaming2) {
    if (ue58OrNewer) {
      // Match official Getting Started (-PixelStreamingURL) and the PS2 migration
      // guide (SignallingURL / ConnectionURL). Same URL in every slot.
      for (const option of ["-PixelStreamingURL", "-PixelStreamingConnectionURL", "-PixelStreamingSignallingURL", "-PixelStreaming2.ConnectionURL"]) {
        pushUnique(\`\${option}=\${q(resolvedEngineUrl)}\`);
      }
      pushUnique("-PixelStreaming2.AutoStartStream=true");
      pushUnique("-PixelStreaming2.InitializeDefaultStreamer=true");
    } else if (major === 5 && minor === 5) {
      pushUnique(\`-PixelStreamingSignallingURL=\${q(resolvedEngineUrl)}\`);
      pushUnique(\`-PixelStreamingURL=\${q(resolvedEngineUrl)}\`);
    } else {
      for (const option of ["-PixelStreamingConnectionURL", "-PixelStreamingURL", "-PixelStreamingSignallingURL"]) {
        pushUnique(\`\${option}=\${q(resolvedEngineUrl)}\`);
      }
    }
  }
  else pushUnique(\`-PixelStreamingURL=\${q(resolvedEngineUrl)}\`);
  args.splice(0, args.length, ...preserved);
  return args;
}

`;
    s = s.slice(0, start) + fn + s.slice(end);
  }

  fs.writeFileSync(path, s);
  console.log('patched', path);
}

// ---------- patch server.js ----------
function patchServer(path) {
  let s = fs.readFileSync(path, 'utf8');

  const oldUpgrade = `  handleUpgrade(req, socket, head) {
    const url = new URL(req.url, \`http://\${req.headers.host || "localhost"}\`);
    const role = url.pathname.split("/")[1];
    const server = this.roles[role];
    if (!server || !this.authorize(req, role)) return socket.destroy();`;

  const newUpgrade = `  handleUpgrade(req, socket, head) {
    const url = new URL(req.url, \`http://\${req.headers.host || "localhost"}\`);
    let role = url.pathname.split("/")[1] || "";
    // PixelStreaming2/EpicRtc may dial a root URL and drop the /engine/<p>/<i> path.
    // Recover identity from the query string so those clients still bind to the instance.
    if (!this.roles[role]) {
      const qProject = url.searchParams.get("project") || "";
      const qInstance = url.searchParams.get("instance") || url.searchParams.get("instanceId") || "";
      const qToken = url.searchParams.get("token") || "";
      if (qProject && qInstance) {
        role = "engine";
        url.pathname = \`/engine/\${encodeURIComponent(qProject)}/\${encodeURIComponent(qInstance)}\`;
        if (!url.searchParams.has("token") && qToken) url.searchParams.set("token", qToken);
      } else if (qToken && qToken === this.config.auth?.engineToken) {
        // Official-style ws://host:port (no path). Bind the sole starting instance if any.
        const starting = this.instances.list().find(x => ["starting", "recovering"].includes(x.state) && !x.engine);
        if (starting && this.instances.list().filter(x => ["starting", "recovering"].includes(x.state) && !x.engine).length === 1) {
          role = "engine";
          url.pathname = \`/engine/\${encodeURIComponent(starting.projectId)}/\${encodeURIComponent(starting.id)}\`;
          url.searchParams.set("project", starting.projectId);
          url.searchParams.set("instance", starting.id);
        }
      }
    }
    this.logger.debug?.("signal.upgrade", { path: url.pathname, role: role || null, host: req.headers.host || "" });
    const server = this.roles[role];
    if (!server || !this.authorize(req, role)) {
      this.logger.warn("signal.upgrade_rejected", { path: url.pathname, role: role || null, remote: req.socket?.remoteAddress || "" });
      return socket.destroy();
    }`;

  if (s.includes(oldUpgrade)) s = s.replace(oldUpgrade, newUpgrade);
  else console.error(path, 'handleUpgrade block not found');

  // authorizeEngineTicket: also accept query project/instance/token
  const oldTicket = `export function authorizeEngineTicket(url, instances) {
  const parts = url.pathname.split("/").filter(Boolean);
  const projectId = safeDecodeURIComponent(parts[1]), instanceId = safeDecodeURIComponent(parts[2]);
  const ticketPart = parts[3] || "";
  const supplied = ticketPart.startsWith("token=") ? safeDecodeURIComponent(ticketPart.slice(6)) : "";`;

  const newTicket = `export function authorizeEngineTicket(url, instances) {
  const parts = url.pathname.split("/").filter(Boolean);
  const projectId = safeDecodeURIComponent(parts[1]) || url.searchParams.get("project") || "";
  const instanceId = safeDecodeURIComponent(parts[2]) || url.searchParams.get("instance") || url.searchParams.get("instanceId") || "";
  const ticketPart = parts[3] || "";
  const supplied = ticketPart.startsWith("token=") ? safeDecodeURIComponent(ticketPart.slice(6)) : url.searchParams.get("token") || "";`;

  if (s.includes(oldTicket)) s = s.replace(oldTicket, newTicket);
  else console.error(path, 'authorizeEngineTicket block not found');

  fs.writeFileSync(path, s);
  console.log('patched', path);
}

const vendorPm = 'F:/shuzhiLuanShengHouDuan/xiangShuLiu/vendor/server/src/execue/process-manager.js';
const vendorSv = 'F:/shuzhiLuanShengHouDuan/xiangShuLiu/vendor/server/src/signal/server.js';
const runtimePm = 'C:/Users/Administrator/AppData/Roaming/圣效像素流/server/src/execue/process-manager.js';
const runtimeSv = 'C:/Users/Administrator/AppData/Roaming/圣效像素流/server/src/signal/server.js';

patchProcessManager(vendorPm);
patchProcessManager(runtimePm);
patchServer(vendorSv);
patchServer(runtimeSv);
