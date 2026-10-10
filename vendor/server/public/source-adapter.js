(function () {
  const params = new URLSearchParams(location.search);
  const project = params.get("project") || "AA";
  const token = params.get("token") || "";
  const video = window.ps;
  const state = { signal: "connecting", webrtc: "waiting", input: "waiting", lifecycle: "allocating", video: "0x0", activitySent: 0 };
  window.sourceDiagnostics = state;
  function render() {
    for (const [key, value] of Object.entries(state)) {
      const node = document.querySelector(`[data-state="${key}"]`);
      if (node) node.textContent = String(value);
    }
    window.dispatchEvent(new CustomEvent("source-diagnostics", { detail: { ...state } }));
  }
  function sendActivity() {
    if (video.ws?.readyState !== WebSocket.OPEN) return;
    const now = Date.now();
    if (now - state.activitySent < 1000) return;
    state.activitySent = now;
    video.ws.send(JSON.stringify({ type: "session.activity", timestamp: new Date().toISOString() }));
  }
  const observeSocket = () => {
    if (!video.ws || video.ws.__sourceObserved) return setTimeout(observeSocket, 50);
    video.ws.__sourceObserved = true;
    state.signal = video.ws.readyState === WebSocket.OPEN ? "connected" : "connecting";
    video.ws.addEventListener("open", () => { state.signal = "connected"; render(); });
    video.ws.addEventListener("close", () => { state.signal = "disconnected"; render(); setTimeout(observeSocket, 100); });
    render();
  };
  observeSocket();
  video.addEventListener("sourceInstanceLifecycle", event => { state.lifecycle = event.detail.state; state.instanceId = event.detail.instanceId || state.instanceId; state.reasonCode = event.detail.reasonCode || ""; render(); });
  video.addEventListener("sourceSessionIdleWarning", event => { state.idleWarning = event.detail.remainingSeconds; render(); });
  video.addEventListener("loadeddata", () => { state.video = `${video.videoWidth}x${video.videoHeight}`; render(); });
  for (const eventName of ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"]) document.addEventListener(eventName, sendActivity, { passive: true });
  setInterval(() => {
    state.webrtc = video.pc?.connectionState || "waiting";
    state.input = video.dc?.readyState || "waiting";
    if (video.videoWidth) state.video = `${video.videoWidth}x${video.videoHeight}`;
    render();
  }, 250);
  render();
})();
