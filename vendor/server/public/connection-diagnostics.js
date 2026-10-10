(function (root) {
  // This reports display timing only. It never starts an instance or activates billing.
  function attach(player, video, options = {}) {
    const now = options.now || (() => performance.now());
    let started = null, sessionId = '', firstFrameMs = null, firstFrameSource = '', stage = 'checking', frameRequest = null, hasProblem = false;
    const normalEndReasons = new Set(['user_idle_timeout', 'instance_idle_timeout', 'max_session_duration', 'queue_fair_use_limit', 'admin_requested', 'admin_project_stop', 'admin_stop_all', 'settings_changed', 'last_player_left', 'integration_test_complete', 'queue_cancelled', 'requested']);
    const labels = { checking: '正在检查访问条件', starting: '正在启动项目', queued: '正在等待空闲位置', connecting: '正在连接画面', connected: '画面已连接', reconnecting: '连接中断，正在恢复', failed: '连接未成功', ended: '本次访问已结束' };
    const nodes = () => document.querySelectorAll('[data-connection-diagnostic]');
    function render() {
      const visible = hasProblem && Boolean(sessionId);
      const text = visible ? `诊断编号：${sessionId}\n${labels[stage] || labels.connecting}${firstFrameMs === null ? '' : ` · 首帧 ${(firstFrameMs / 1000).toFixed(2)} 秒`}` : '';
      for (const node of nodes()) { node.textContent = text; node.hidden = !visible; }
      for (const button of document.querySelectorAll('[data-copy-diagnostic]')) { button.hidden = !visible; button.disabled = !visible; }
    }
    function report() {
      if (!sessionId || player.ws?.readyState !== 1) return;
      try { player.ws.send(JSON.stringify({ type: 'session.diagnostics', sessionId, stage, firstFrameMs, firstFrameSource })); } catch {}
    }
    function setStage(value) { stage = value; render(); report(); }
    function failed() { hasProblem = true; cancelFrame(); setStage('failed'); }
    function ended(reason) { hasProblem = Boolean(reason) && !normalEndReasons.has(reason); cancelFrame(); setStage('ended'); }
    function recovered() {
      if (stage === 'ended' || stage === 'failed' || stage === 'connected' || firstFrameMs === null) return;
      hasProblem = false;
      setStage('connected');
    }
    function cancelFrame() { if (frameRequest !== null) video.cancelVideoFrameCallback?.(frameRequest); frameRequest = null; }
    function frame(source) {
      if (['ended', 'failed'].includes(stage) || firstFrameMs !== null || started === null || !sessionId || video.videoWidth <= 0 || video.readyState < 2) return;
      firstFrameMs = Math.max(0, Math.round(now() - started)); firstFrameSource = source;
      hasProblem = false; cancelFrame(); setStage('connected');
    }
    function watchFrame() {
      if (firstFrameMs !== null || !sessionId || frameRequest !== null || ['ended','failed'].includes(stage)) return;
      const expectedSession = sessionId;
      if (typeof video.requestVideoFrameCallback === 'function') frameRequest = video.requestVideoFrameCallback(() => { frameRequest = null; if (sessionId === expectedSession) frame('presented'); });
      else if (!video.paused) frame('playing');
    }
    player.addEventListener('sourceSessionConnected', event => {
      const id = String(event.detail?.sessionId || '');
      if (!id || id === sessionId) return;
      cancelFrame();
      if (sessionId) started = now();
      sessionId = id; firstFrameMs = null; firstFrameSource = ''; hasProblem = false; setStage('starting');
    });
    player.addEventListener('sourceInstanceLifecycle', event => {
      const state = event.detail?.state;
      if (state === 'ended' || state === 'stopping') ended(event.detail?.reasonCode);
      else if (firstFrameMs === null && ['queued', 'starting', 'connecting'].includes(state)) setStage(state);
    });
    player.addEventListener('sourceConnectionFailure', failed);
    player.addEventListener('publicShareRejected', failed);
    player.addEventListener('playerbootstrapfailed', failed);
    player.addEventListener('playerconnectionerror', () => { if (stage !== 'ended' && stage !== 'failed') setStage('reconnecting'); });
    player.addEventListener('playerdisconnected', () => { cancelFrame(); if (stage !== 'ended' && stage !== 'failed') setStage('reconnecting'); });
    for (const event of ['playing', 'loadeddata']) video.addEventListener(event, watchFrame);
    const timer = setInterval(report, 10000);
    root.addEventListener('pagehide', () => { clearInterval(timer); cancelFrame(); }, { once: true });
    for (const button of document.querySelectorAll('[data-copy-diagnostic]')) button.addEventListener('click', async () => {
      if (!sessionId || !hasProblem) return;
      try { await navigator.clipboard.writeText(sessionId); button.textContent = '已复制编号'; }
      catch { button.textContent = '请选中上方编号复制'; }
      setTimeout(() => { button.textContent = '复制诊断编号'; }, 2500);
    });
    render();
    return { failed, ended, recovered, begin() { if (started === null) started = now(); hasProblem = false; setStage('checking'); }, snapshot: () => ({ sessionId, stage, firstFrameMs, firstFrameSource }) };
  }
  root.PeerStreamConnectionDiagnostics = Object.freeze({ attach });
})(globalThis);
