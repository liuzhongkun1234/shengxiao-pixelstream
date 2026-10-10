import fs from 'fs';

function patchPm(path) {
  let s = fs.readFileSync(path, 'utf8');
  const start = s.indexOf('export function applySignallingUrlArgument');
  const end = s.indexOf('function sanitizeLaunchArgs', start);
  if (start < 0 || end < 0) return console.error('pm bounds', path);
  const fn = `export function applySignallingUrlArgument(args, engineUrl, ueVersion, engineAuthTicket = "", streamingProtocol = "", plugin = "") {
  const managedUrl = /^-PixelStreaming(?:2[._]?)?(?:Signalling|Connection)?URL=/i;
  const managedIpPort = /^-PixelStreaming(?:IP|Port)=/i;
  const preserved = args.filter(x => !managedUrl.test(String(x)) && !managedIpPort.test(String(x)));
  const match = String(ueVersion || "").match(/^(\\d+)(?:\\.(\\d+))?/);
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
    url.pathname = \`\${url.pathname.replace(/\\/$/, "")}/token=\${encodeURIComponent(engineAuthTicket)}\`;
    url.searchParams.delete("token");
    resolved = url.toString();
  }

  if (pixelStreaming2 && ue58OrNewer) {
    // Bare ws://host:port (official shape). Identity rides in the query string.
    // No extra quotes — 5.3 (which works) passes unquoted URLs.
    const u = new URL(resolved);
    const hostPort = \`\${u.protocol}//\${u.host}/\`;
    const identity = \`?project=\${encodeURIComponent(u.searchParams.get("project") || "")}&instance=\${encodeURIComponent(u.searchParams.get("instance") || "")}&token=\${encodeURIComponent(u.searchParams.get("token") || "")}\`;
    const primary = hostPort + identity;
    for (const option of ["-PixelStreamingURL", "-PixelStreamingConnectionURL", "-PixelStreamingSignallingURL", "-PixelStreaming2.ConnectionURL"]) {
      pushUnique(\`\${option}=\${primary}\`);
    }
    pushUnique(\`-PixelStreamingIP=\${u.hostname}\`);
    pushUnique(\`-PixelStreamingPort=\${u.port || "12188"}\`);
    pushUnique("-PixelStreaming2.AutoStartStream=true");
    pushUnique("-PixelStreaming2.InitializeDefaultStreamer=true");
  } else if (pixelStreaming2 && major === 5 && minor === 5) {
    pushUnique(\`-PixelStreamingSignallingURL=\${resolved}\`);
    pushUnique(\`-PixelStreamingURL=\${resolved}\`);
  } else if (pixelStreaming2) {
    for (const option of ["-PixelStreamingConnectionURL", "-PixelStreamingURL", "-PixelStreamingSignallingURL"]) {
      pushUnique(\`\${option}=\${resolved}\`);
    }
  } else {
    pushUnique(\`-PixelStreamingURL=\${resolved}\`);
  }
  args.splice(0, args.length, ...preserved);
  return args;
}

`;
  s = s.slice(0, start) + fn + s.slice(end);
  fs.writeFileSync(path, s);
  console.log('pm', path);
}

function patchSv(path) {
  let s = fs.readFileSync(path, 'utf8');
  const oldBlock = `      } else if (qToken && qToken === this.config.auth?.engineToken) {
        // Official-style ws://host:port (no path). Bind the sole starting instance if any.
        const starting = this.instances.list().find(x => ["starting", "recovering"].includes(x.state) && !x.engine);
        if (starting && this.instances.list().filter(x => ["starting", "recovering"].includes(x.state) && !x.engine).length === 1) {
          role = "engine";
          url.pathname = \`/engine/\${encodeURIComponent(starting.projectId)}/\${encodeURIComponent(starting.id)}\`;
          url.searchParams.set("project", starting.projectId);
          url.searchParams.set("instance", starting.id);
        }
      }`;
  const newBlock = `      } else {
        // Official-style ws://host:port — no path required. Bind the sole pending instance.
        const remote = String(req.socket?.remoteAddress || "");
        const isLocal = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
        const pending = this.instances.list().filter(x => ["starting", "recovering"].includes(x.state) && !x.engine);
        const tokenOk = !qToken || qToken === this.config.auth?.engineToken;
        if (isLocal && tokenOk && pending.length === 1) {
          const starting = pending[0];
          role = "engine";
          url.pathname = \`/engine/\${encodeURIComponent(starting.projectId)}/\${encodeURIComponent(starting.id)}\`;
          url.searchParams.set("project", starting.projectId);
          url.searchParams.set("instance", starting.id);
          if (!url.searchParams.get("token")) url.searchParams.set("token", this.config.auth?.engineToken || "");
          this.logger.info("signal.engine_bound_by_ip", { projectId: starting.projectId, instanceId: starting.id, remote });
        }
      }`;
  if (s.includes(oldBlock)) {
    s = s.replace(oldBlock, newBlock);
    // always log upgrades at info for diagnosis
    s = s.replace(
      'this.logger.debug?.("signal.upgrade", { path: url.pathname, role: role || null, host: req.headers.host || "" });',
      'this.logger.info("signal.upgrade", { path: url.pathname, role: role || null, query: Object.fromEntries(url.searchParams), host: req.headers.host || "" });'
    );
    fs.writeFileSync(path, s);
    console.log('sv', path);
  } else {
    console.log('sv block missing', path);
  }
}

for (const p of [
  'F:/shuzhiLuanShengHouDuan/xiangShuLiu/vendor/server/src/execue/process-manager.js',
  'C:/Users/Administrator/AppData/Roaming/圣效像素流/server/src/execue/process-manager.js',
]) patchPm(p);
for (const p of [
  'F:/shuzhiLuanShengHouDuan/xiangShuLiu/vendor/server/src/signal/server.js',
  'C:/Users/Administrator/AppData/Roaming/圣效像素流/server/src/signal/server.js',
]) patchSv(p);
