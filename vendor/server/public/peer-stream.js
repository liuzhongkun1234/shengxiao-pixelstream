"5.1.3";

// Must be kept in sync with JavaScriptKeyCodeToFKey C++ array.
// special keycodes different from KeyboardEvent.keyCode
const SpecialKeyCodes = {
	Backspace: 8,
	ShiftLeft: 16,
	ControlLeft: 17,
	AltLeft: 18,
	ShiftRight: 253,
	ControlRight: 254,
	AltRight: 255,
};

// https://developer.mozilla.org/en-US/docs/Web/API/MouseEvent/button
const MouseButton = {
	MainButton: 0, // Left button.
	AuxiliaryButton: 1, // Wheel button.
	SecondaryButton: 2, // Right button.
	FourthButton: 3, // Browser Back button.
	FifthButton: 4, // Browser Forward button.
};

// https://developer.mozilla.org/en-US/docs/Web/API/MouseEvent/buttons#value
const MouseButtonsMask = {
	1: 0,
	2: 2,
	4: 1,
	8: 3,
	16: 4
}

// Must be kept in sync with PixelStreamingProtocol::EToClientMsg C++ enum.
const RECEIVE = {
	QualityControlOwnership: 0,
	Response: 1,
	Command: 2,
	FreezeFrame: 3,
	UnfreezeFrame: 4,
	VideoEncoderAvgQP: 5,
	LatencyTest: 6,
	InitialSettings: 7,
	FileExtension: 8,
	FileMimeType: 9,
	FileContents: 10,
	InputControlOwnership: 12,
	CompositionStart: 64,
	Protocol: 255
};

// Must be kept in sync with PixelStreamingProtocol::EToUE4Msg C++ enum.
const SEND = {
	/*
	 * Control Messages. Range = 0..49.
	 */
	IFrameRequest: 0,
	RequestQualityControl: 1,
	FpsRequest: 2,
	AverageBitrateRequest: 3,
	StartStreaming: 4,
	StopStreaming: 5,
	LatencyTest: 6,
	RequestInitialSettings: 7,
	/*
	 * Input Messages. Range = 50..89.
	 */

	// Generic Input Messages. Range = 50..59.
	UIInteraction: 50,
	Command: 51,

	// Keyboard Input Message. Range = 60..69.
	KeyDown: 60,
	KeyUp: 61,
	KeyPress: 62,
	FindFocus: 63,
	CompositionEnd: 64,

	// Mouse Input Messages. Range = 70..79.
	MouseEnter: 70,
	MouseLeave: 71,
	MouseDown: 72,
	MouseUp: 73,
	MouseMove: 74,
	MouseWheel: 75,

	// Touch Input Messages. Range = 80..89.
	TouchStart: 80,
	TouchEnd: 81,
	TouchMove: 82,

	// Gamepad Input Messages. Range = 90..99
	GamepadButtonPressed: 90,
	GamepadButtonReleased: 91,
	GamepadAnalog: 92,
};

let iceServers = undefined;
let iceTransportPolicy = undefined;

const TERMINAL_SESSION_REASONS = new Set([
	"user_idle_timeout", "max_session_duration", "queue_fair_use_limit", "queue_wait_timeout",
	"admin_requested", "admin_project_stop", "admin_stop_all", "settings_changed",
	"instance_idle_timeout", "network_disconnect_timeout", "last_player_left",
	"turn_capacity_reached", "turn_daily_budget_exhausted"
]);

function peerStreamAnonymousProfile() {
	const ua = navigator.userAgent || "";
	const ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
	const android = /Android/i.test(ua);
	const platform = ios ? "ios" : android ? "android" : "desktop";
	const isWechat = /MicroMessenger/i.test(ua);
	const browser = /EdgA?|EdgiOS/i.test(ua) ? "edge" : /CriOS|Chrome/i.test(ua) ? "chrome" : /Safari/i.test(ua) ? "safari" : "other";
	const container = isWechat ? "wechat" : browser !== "other" ? "normal" : "unknown";
	const coarse = globalThis.matchMedia?.("(pointer:coarse)")?.matches === true;
	const deviceClass = platform === "desktop" && !coarse ? "desktop" : Math.min(screen.width, screen.height) >= 600 ? "tablet" : "mobile";
	const fullscreenSupported = Boolean(document.fullscreenEnabled && typeof document.documentElement?.requestFullscreen === "function");
	const orientationLockSupported = typeof screen.orientation?.lock === "function";
	return { platform, browser, deviceClass, container, isWechat, fullscreenSupported, orientationLockSupported };
}

function reportPeerStreamBootstrap(event, errorName = "") {
	const detail = { event, errorName: String(errorName || "").slice(0, 64), ...peerStreamAnonymousProfile() };
	globalThis.dispatchEvent?.(new CustomEvent("peerStreamBootstrap", { detail }));
	try {
		const params = new URLSearchParams(detail);
		void fetch(`/api/public/bootstrap?${params}`, { cache: "no-store", keepalive: true }).catch(() => {});
	} catch { }
	return detail;
}

globalThis.PeerStreamBootstrap = Object.freeze({ report: reportPeerStreamBootstrap, profile: peerStreamAnonymousProfile });
reportPeerStreamBootstrap("player_script_loaded");

class PeerStreamController {
	constructor(videoElement) {
		if (!(videoElement instanceof HTMLVideoElement)) throw new TypeError("PeerStreamController requires an HTMLVideoElement");
		this.videoElement = videoElement;
		this.signalUrl = videoElement.dataset.signalUrl || "";
		const controller = new Proxy(this, {
			get(target, property, receiver) {
				if (Reflect.has(target, property)) return Reflect.get(target, property, receiver);
				const value = videoElement[property];
				return typeof value === "function" ? value.bind(videoElement) : value;
			},
			set(target, property, value, receiver) {
				if (Reflect.has(target, property) || !(property in videoElement)) return Reflect.set(target, property, value, receiver);
				return Reflect.set(videoElement, property, value, videoElement);
			}
		});

		window.ps = controller;

		this.ws = { send() { }, close() { } }; // WebSocket
		this.pc = { close() { } }; // RTCPeerConnection
		this.playerConnectionGeneration = 0;
		this.activePlayerId = null;
		this.activePlayerGeneration = 0;
		this.playerConnectionEstablishing = false;
		this.offerInProgress = false;
		this.answerInProgress = false;
		this.offerGeneration = 0;
		this.transportRecoveryTimer = null;
		this.legacyIceRestartAttempts = 0;
		this.reconnectStartedAt = 0;
		this.reconnectMaxDurationMs = 120000;

		controller.setupVideo();
		controller.registerKeyboardEvents();
		controller.registerMouseHoverEvents();
		if (videoElement.dataset.touchMode === "native") controller.registerTouchEvents();
		else if (videoElement.dataset.touchMode === "mouse") controller.registerFakeMouseEvents();
		else controller.registerHybridTouchEvents();

		this.pointerLockChangeHandler = () => {
			if (document.pointerLockElement === videoElement) {
				controller.registerPointerLockEvents();
			} else {
				controller.registerMouseHoverEvents();
			}
		};
		document.addEventListener(
			"pointerlockchange",
			this.pointerLockChangeHandler,
			false
		);

		controller.addEventListener("loadeddata", () => {
			controller.style["aspect-ratio"] = controller.videoWidth / controller.videoHeight;
		});

		reportPeerStreamBootstrap("player_controller_created");
		return controller;
	}
	checkWebRTCSupport() {
		// Step 2: Check for RTCPeerConnection
		const RTCPeerConnection = window.RTCPeerConnection || window.webkitRTCPeerConnection || window.mozRTCPeerConnection;
		if (!RTCPeerConnection) {
			console.warn('checkWebRTCSupport RTCPeerConnection not supported');
			return false
		}
		// Step 3: Check for DataChannel
		let dataChannelSupported = false;
		let pc = null;
		if (RTCPeerConnection) {
			try {
				pc = new RTCPeerConnection();
				const dc = pc.createDataChannel('test');
				dataChannelSupported = !!dc;
				dc.close(); // Close the DataChannel when done
				pc.close()
			} catch (e) {
				console.error(e)
				console.warn('checkWebRTCSupport dataChannelSupported not supported');
				return false
			}
			if (!dataChannelSupported) {
				console.warn('checkWebRTCSupport DataChannel not supported');
				return false
			}
		}
		return true

	}

	start() {
		if (this.started && !this.destroyed) return this.startPromise;
		this.started = true;
		this.destroyed = false;
		reportPeerStreamBootstrap("player_start");
		this.startPromise = this.connect().catch(error => {
			const errorName = error?.name || "PlayerStartError";
			reportPeerStreamBootstrap("player_start_failed", errorName);
			this.dispatchEvent(new CustomEvent("playerbootstrapfailed", { detail: { errorName } }));
			if (!this.destroyed) this.requirePageRefresh();
		});
		return this.startPromise;
	}

	// setupWebsocket
	async connect() {
		if (this.terminalSession) return;
		if (false == this.checkWebRTCSupport()) {
			const overlayDiv = document.createElement('div');
			overlayDiv.innerHTML = '你的浏览器版本过低!<br>推荐使用谷歌100以上版本浏览器!!';
			overlayDiv.style.position = 'absolute';
			overlayDiv.style.top = '50%';
			overlayDiv.style.left = '50%';
			overlayDiv.style.transform = 'translate(-50%, -50%)';
			overlayDiv.style.background = 'rgba(255, 255, 255, 0.8)';
			overlayDiv.style.padding = '10px';
			overlayDiv.style.borderRadius = '5px';
			overlayDiv.style.display = 'block'; // Initially hidden
			this.parentNode.appendChild(overlayDiv)
		}

		// This will happen each time the node is moved, and may happen before the element"s contents have been fully parsed. may be called once your element is no longer connected
		if (this.destroyed || !this.videoElement.isConnected) return;
		if (!(await this.validatePublicShare()) || this.destroyed) return;
		if (this.pc.connectionState === "connected" && this.dc.readyState === "open" && this.ws.readyState === 1) {
			this.play();
			return;
		}
		const generation = ++this.playerConnectionGeneration;
		this.activePlayerId = null;
		this.activePlayerGeneration = 0;
		this.playerConnectionEstablishing = false;
		console.debug("[player reconnect]", { generation });
		// await new Promise((res) => setTimeout(res, 1000));
		this.ws.onclose = null
		this.ws.close(1000);
		const socketUrl = new URL(this.signalUrl || location.href.replace(/^http/, "ws"));
		socketUrl.searchParams.set("client", this.getStableClientId());
		socketUrl.searchParams.set("tab", this.getStableTabId());
		const capabilities = this.getClientCapabilities();
		socketUrl.searchParams.set("codecs", capabilities.videoCodecs.join(","));
		socketUrl.searchParams.set("mobile", capabilities.mobile ? "1" : "0");
		socketUrl.searchParams.set("platform", capabilities.platform);
		socketUrl.searchParams.set("av1", new URLSearchParams(location.search).get("av1") === "1" ? "1" : "0");
		const requestedAv1Factor = new URLSearchParams(location.search).get("av1Factor");
		if (requestedAv1Factor) socketUrl.searchParams.set("av1Factor", requestedAv1Factor);
		reportPeerStreamBootstrap("websocket_started");
		this.ws = new WebSocket(socketUrl, 'peer-stream');
		const ws = this.ws;

		this.ws.onerror = (event) => {
			if (this.destroyed || generation !== this.playerConnectionGeneration || this.ws !== ws) return;
			reportPeerStreamBootstrap("websocket_error", event?.error?.name || "WebSocketError");
			this.dispatchEvent(new CustomEvent("playerconnectionerror", { detail: { errorName: event?.error?.name || "WebSocketError" } }));
		};

		this.ws.onopen = () => {
			if (this.destroyed || generation !== this.playerConnectionGeneration || this.ws !== ws) {
				console.debug("ignore stale player event", generation);
				return;
			}
			console.debug("Player WebSocket connected", { generation });
			reportPeerStreamBootstrap("websocket_open");
		};

		this.ws.onmessage = (e) => {
			if (this.destroyed || generation !== this.playerConnectionGeneration || this.ws !== ws) {
				console.debug("ignore stale player event", generation);
				return;
			}
			this.onWebSocketMessage(e.data, generation, ws);
		};

		this.ws.onclose = (e) => {
			if (this.destroyed || generation !== this.playerConnectionGeneration || this.ws !== ws) {
				console.debug("ignore stale player event", generation);
				return;
			}
			console.warn("Player WebSocket closed", { code: Number(e.code) || 0 });
			reportPeerStreamBootstrap("websocket_closed", `Close${Number(e.code) || 0}`);
			this.dispatchEvent(new CustomEvent("playerdisconnected", {}));
			clearTimeout(this.reconnect);
			this.activePlayerId = null;
			this.activePlayerGeneration = 0;
			this.playerConnectionEstablishing = false;
			if (this.terminalSession || this.destroyed) return;
			this.requirePageRefresh(this.pc);
		};
	}

	restartTerminalSession() {
		this.terminalSession = false;
		this.reconnectStartedAt = 0;
		clearTimeout(this.reconnect);
		clearTimeout(this.publicShareReconnect);
		clearTimeout(this.transportRecoveryTimer);
		this.connect();
	}

	async validatePublicShare() {
		const params = new URLSearchParams(location.search);
		if (!params.has("share")) return true;
		reportPeerStreamBootstrap("share_check_started");
		const url = `/api/public/share-status?project=${encodeURIComponent(params.get("project") || "")}&share=${encodeURIComponent(params.get("share") || "")}&route=${encodeURIComponent(params.get("route") || "")}&client=${encodeURIComponent(this.getStableClientId())}`;
		const validator = globalThis.PeerStreamPublicShare?.check;
		const result = typeof validator === "function"
			? await validator(url)
			: { ok: false, transient: true, reason: "share_starting", message: "公网服务正在启动，系统将自动重试。" };
		if (result.ok) {
			reportPeerStreamBootstrap("share_check_success");
			clearTimeout(this.publicShareReconnect);
			return true;
		}
		if (result.transient) {
			reportPeerStreamBootstrap("share_check_failed", result.reason || "ShareCheckError");
			this.dispatchEvent(new CustomEvent("publicSharePending", { detail: result }));
			clearTimeout(this.publicShareReconnect);
			this.publicShareReconnect = setTimeout(() => this.connect(), 3000);
			return false;
		}
		this.publicShareRejected = true;
		reportPeerStreamBootstrap("share_check_failed", result.reason || "ShareRejected");
		this.dispatchEvent(new CustomEvent("publicShareRejected", { detail: result }));
		return false;
	}

	getStableClientId() {
		if (this.stableClientId) return this.stableClientId;
		const key = "peerstream.clientId";
		let value = "";
		try { value = localStorage.getItem(key) || ""; } catch { }
		if (!/^[a-f0-9-]{32,40}$/i.test(value)) {
			value = this.createAnonymousId();
			try { localStorage.setItem(key, value); } catch { }
		}
		this.stableClientId = value;
		return value;
	}

	getStableTabId() {
		if (this.stableTabId) return this.stableTabId;
		const key = "peerstream.tabId";
		let value = "";
		try { value = sessionStorage.getItem(key) || ""; } catch { }
		if (!/^[a-f0-9-]{32,40}$/i.test(value)) {
			value = this.createAnonymousId();
			try { sessionStorage.setItem(key, value); } catch { }
		}
		this.stableTabId = value;
		return value;
	}

	createAnonymousId() {
		try {
			if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
			if (typeof crypto?.getRandomValues === "function") return Array.from(crypto.getRandomValues(new Uint8Array(16)), x => x.toString(16).padStart(2, "0")).join("");
		} catch { }
		let value = "";
		for (let index = 0; index < 32; index++) value += Math.floor(Math.random() * 16).toString(16);
		return value;
	}

	getClientCapabilities() {
		const codecs = new Set();
		try {
			for (const codec of RTCRtpReceiver.getCapabilities?.("video")?.codecs || []) {
				const name = String(codec.mimeType || "").split("/").pop().toUpperCase();
				if (["AV1", "H264", "VP8", "VP9"].includes(name)) codecs.add(name);
			}
		} catch (error) { console.debug("读取 WebRTC 编解码能力失败", error); }
		return {
			videoCodecs: [...codecs],
			mobile: navigator.userAgentData?.mobile === true || (matchMedia?.("(pointer:coarse)").matches && Math.min(screen.width, screen.height) < 900),
			platform: String(navigator.userAgentData?.platform || navigator.platform || "unknown").slice(0, 32)
		};
	}

	destroy() {
		if (this.destroyed) return;
		this.releaseTouches?.();
		window.removeEventListener("blur", this.touchBlurHandler);
		document.removeEventListener("visibilitychange", this.touchVisibilityHandler);
		this.stopTextInput();
		window.removeEventListener("resize", this.textInputResizeHandler);
		document.removeEventListener("fullscreenchange", this.textInputResizeHandler);
		this.videoElement.removeEventListener("resize", this.textInputResizeHandler);
		this.textInput?.remove();
		this.textInput = null;
		this.videoElement.removeEventListener("click", this.textInputClickHandler);
		this.destroyed = true;
		this.playerConnectionGeneration += 1;
		this.activePlayerId = null;
		this.activePlayerGeneration = 0;
		this.playerConnectionEstablishing = false;
		this.started = false;
		this.terminalSession = true;
		clearTimeout(this.reconnect);
		clearTimeout(this.publicShareReconnect);
		if (this.videoPlayRetryHandler) document.removeEventListener("click", this.videoPlayRetryHandler, true);
		document.removeEventListener("pointerlockchange", this.pointerLockChangeHandler, false);
		try { this.ws?.close?.(1000); } catch { }
		try { this.dc?.close?.(); } catch { }
		try { this.pc?.close?.(); } catch { }
		this.remoteStream = null;
		try { this.videoElement.srcObject = null; } catch { }
		console.log("❌ peer connection closing");
	}

	watchPeerConnection() {
		const pc = this.pc;
		const inspect = () => {
			if (this.destroyed || this.pc !== pc) return;
			const peer = pc.connectionState || "new";
			const ice = pc.iceConnectionState || "new";
			if (peer === "connected" || ice === "connected" || ice === "completed") {
				clearTimeout(this.transportRecoveryTimer);
				this.transportRecoveryTimer = null;
				return;
			}
			if (!["disconnected", "failed"].includes(peer) && !["disconnected", "failed"].includes(ice)) return;
			if (this.pixelStreamingProtocol === "legacy" && this.ws?.readyState === WebSocket.OPEN && this.activePlayerId && this.legacyIceRestartAttempts < 2) {
				if (this.transportRecoveryTimer) return;
				const delay = peer === "failed" || ice === "failed" ? 250 : 3000;
				this.dispatchEvent(new CustomEvent("sourceTransportRecovery", { detail: { state: "waiting", attempt: this.legacyIceRestartAttempts + 1, peer, ice } }));
				this.transportRecoveryTimer = setTimeout(() => void this.recoverLegacyIce(pc), delay);
				return;
			}
			this.requirePageRefresh(pc);
		};
		pc.onconnectionstatechange = inspect;
		pc.oniceconnectionstatechange = inspect;
	}

	async recoverLegacyIce(pc) {
		this.transportRecoveryTimer = null;
		if (this.destroyed || this.pc !== pc || this.pixelStreamingProtocol !== "legacy") return;
		if (["connected", "completed"].includes(pc.iceConnectionState)) return;
		if (this.ws?.readyState !== WebSocket.OPEN || !this.activePlayerId || this.legacyIceRestartAttempts >= 2) return this.requirePageRefresh(pc);
		if (this.offerInProgress || pc.signalingState !== "stable") {
			this.transportRecoveryTimer = setTimeout(() => void this.recoverLegacyIce(pc), 250);
			return;
		}
		this.legacyIceRestartAttempts += 1;
		this.dispatchEvent(new CustomEvent("sourceTransportRecovery", { detail: { state: "ice-restart", attempt: this.legacyIceRestartAttempts, peer: pc.connectionState, ice: pc.iceConnectionState } }));
		try {
			await this.setupOffer(true, this.playerConnectionGeneration, this.activePlayerId);
		} catch (error) {
			console.warn("Legacy ICE restart failed", error);
			this.requirePageRefresh(pc);
		}
	}

	requirePageRefresh(pc = this.pc) {
		if (this.destroyed || this.terminalSession || (pc && this.pc !== pc)) return;
		this.playerConnectionGeneration += 1;
		this.activePlayerId = null;
		this.activePlayerGeneration = 0;
		this.playerConnectionEstablishing = false;
		clearTimeout(this.reconnect);
		clearTimeout(this.transportRecoveryTimer);
		this.transportRecoveryTimer = null;
		try { this.dc?.close?.(); } catch { }
		try { this.pc?.close?.(); } catch { }
		try {
			this.ws?.close?.(1000);
		} catch { }
		this.remoteStream = null;
		this.videoElement.srcObject = null;
		this.dispatchEvent(new CustomEvent("sourceTransportRecovery", { detail: { state: "failed" } }));
	}

	adoptedCallback() { }

	attributeChangedCallback(name, oldValue, newValue) {
		if (!this.isConnected) return;
		// fired before the explicit controller start when startup
		this.ws.close(1000);
	}

	async onWebSocketMessage(msg, playerGeneration = this.playerConnectionGeneration, sourceWebSocket = this.ws) {
		if (this.destroyed || playerGeneration !== this.playerConnectionGeneration || sourceWebSocket !== this.ws) {
			console.debug("ignore stale player event", playerGeneration);
			return;
		}
		try {
			msg = JSON.parse(msg);
		} catch {
			console.debug("↓↓", msg);
			return;
		}
		if (msg.type === "offer") {
			if (!this.setupPeerConnection(playerGeneration)) return;
			const pc = this.pc;

			const offer = new RTCSessionDescription(msg);
			await pc.setRemoteDescription(offer);
			if (playerGeneration !== this.playerConnectionGeneration || sourceWebSocket !== this.ws || pc !== this.pc) return;

			// Setup a transceiver for getting UE video
			pc.addTransceiver("video", { direction: "recvonly" });

			const answer = await pc.createAnswer();
			if (playerGeneration !== this.playerConnectionGeneration || sourceWebSocket !== this.ws || pc !== this.pc) return;
			await pc.setLocalDescription(answer);
			if (playerGeneration !== this.playerConnectionGeneration || sourceWebSocket !== this.ws || pc !== this.pc) return;

			sourceWebSocket.send(JSON.stringify(answer));

			for (let receiver of pc.getReceivers()) {
				receiver.playoutDelayHint = 0;
			}
		} else if (msg.type === "iceCandidate") {
			if (playerGeneration !== this.playerConnectionGeneration || sourceWebSocket !== this.ws) return;
			const candidate = new RTCIceCandidate(msg.candidate);
			const pc = this.pc;
			await pc.addIceCandidate(candidate);
		} else if (msg.type === "answer") {
			const pc = this.pc
			const generation = this.offerGeneration
			if (playerGeneration !== this.playerConnectionGeneration || sourceWebSocket !== this.ws) return
			if (this.answerInProgress || pc.signalingState !== "have-local-offer") {
				console.debug("忽略与当前协商状态不匹配的 answer:", this.pc.signalingState)
				return
			}
			this.answerInProgress = true
			try {
				const answer = new RTCSessionDescription(msg)
				if (playerGeneration !== this.playerConnectionGeneration || sourceWebSocket !== this.ws || this.pc !== pc || this.offerGeneration !== generation) return
				await pc.setRemoteDescription(answer)
				for (const receiver of pc.getReceivers()) receiver.playoutDelayHint = 0
			} finally {
				if (this.offerGeneration === generation) this.answerInProgress = false
			}
		} else if (msg.type === "playerqueue") {
			this.dispatchEvent(new CustomEvent("playerqueue", { detail: msg }));
			console.log("↓↓ playerqueue:", msg);
		} else if (msg.type === "seticeServers") {
			iceServers = msg.iceServers
			iceTransportPolicy = msg.iceTransportPolicy === "relay" ? "relay" : undefined
			console.log("↓↓ seticeServers received");
		} else if (msg.type === 'hello') {
			reportPeerStreamBootstrap("session_connected")
			this.pixelStreamingProtocol = msg.pixelStreamingProtocol || 'unified'
			this.pixelStreamingPlugin = msg.pixelStreamingPlugin || this.pixelStreamingPlugin || (this.pixelStreamingProtocol === 'legacy' ? 'PixelStreaming' : 'PixelStreaming2')
			this.codecObservation = msg.codecObservation || this.codecObservation || {}
			this.projectName = msg.projectName || msg.projectId || ''
			this.dispatchEvent(new CustomEvent("sourceProjectInfo", { detail: msg }))
			this.dispatchEvent(new CustomEvent("sourceSessionConnected", { detail: { sessionId: msg.sessionId || "" } }))
			console.info('Pixel Streaming protocol:', this.pixelStreamingProtocol)
		} else if (msg.type === 'playerConnected') {
			const playerId = String(msg.playerId || "")
			if (playerGeneration !== this.playerConnectionGeneration || sourceWebSocket !== this.ws || !playerId || this.playerConnectionEstablishing || this.activePlayerId) {
				console.debug("[playerConnected ignored stale]", { generation: playerGeneration })
				return
			}
			this.activePlayerId = playerId
			this.activePlayerGeneration = playerGeneration
			this.playerConnectionEstablishing = true
			console.debug("[playerConnected accepted]", { generation: playerGeneration, playerId })
			if ((this.pixelStreamingProtocol || msg.pixelStreamingProtocol) === 'legacy') console.info('Legacy Pixel Streaming: browser is creating the offer')
			if (!this.setupPeerConnection_ue4(playerGeneration, playerId)) return
			if (msg.dataChannel !== false) this.setupDataChannel_ue4()
		} else if (msg.type === "ping") {
			console.log("↓↓ ping:", msg);
			msg.type = "pong"
			this.ws.send(JSON.stringify(msg));

			if (this.mouseReleaseTime) {
				let now = new Date()
				if ((now - this.lastmouseTime) > this.mouseReleaseTime * 1000) {
					msg.type = "mouseRelease"
					this.ws.send(JSON.stringify(msg));
				}
			}
		}
		else if (msg.type === "sessionIdleWarning") {
			this.dispatchEvent(new CustomEvent("sessionIdleWarning", { detail: msg }));
		}
		else if (msg.type === "session.idle_warning") {
			this.dispatchEvent(new CustomEvent("sourceSessionIdleWarning", { detail: msg }));
		}
		else if (msg.type === "instanceLifecycle") {
			this.dispatchEvent(new CustomEvent("instanceLifecycle", { detail: msg }));
		}
		else if (msg.type === "instance.lifecycle") {
			const terminal = (msg.state === "stopping" || msg.state === "ended") && TERMINAL_SESSION_REASONS.has(msg.reasonCode);
			if (terminal) {
				this.terminalSession = true;
				clearTimeout(this.reconnect);
				clearTimeout(this.publicShareReconnect);
			}
			if (msg.state === "running") this.reconnectStartedAt = 0;
			this.dispatchEvent(new CustomEvent("sourceInstanceLifecycle", { detail: msg }));
			if (terminal && msg.state === "ended" && this.ws?.readyState === WebSocket.OPEN) this.ws.close(1000, msg.reasonCode);
		}
		else if (msg.type === "error") {
			this.dispatchEvent(new CustomEvent("sourceConnectionFailure", { detail: { code: msg.code || "connection_failed" } }));
		}
		else if (msg.type === "session.control.role") {
			this.dispatchEvent(new CustomEvent("sourceControlRole", { detail: msg }));
		}
		else if (msg.type === "bitrate.policy") {
			this.dispatchEvent(new CustomEvent("sourceBitratePolicy", { detail: msg }));
		}
		else if (msg.type === "ueDisConnected") {
			this.dispatchEvent(new CustomEvent("ueDisConnected", { detail: msg }));
			console.log("↓↓ ueDisConnected:", msg);
		}
		else if (msg.type === "setmouseReleaseTime") {
			// 空闲会话由 video.html 的可见倒计时统一管理，避免旧逻辑提前断开后再次等待回收。
			this.mouseReleaseTime = 0
			this.lastmouseTime = new Date()
			console.log("↓↓ setmouseReleaseTime:", msg);
		}
		else if (msg.type === "getStatus") {
			console.log("↓↓ getStatus:", msg);
			this.handleGetStatus(msg)
		}
		else {
			console.warn("↓↓", msg);
		}
	}
	handleGetStatus(msg) {
		if (false == (this.pc instanceof RTCPeerConnection)) {
			msg.videoencoderqp = null
			msg.netrate = null
			this.ws.send(JSON.stringify(msg));
			console.log("↑↑ handleGetStatus:", msg);
			return
		}
		let initialBytesReceived = 0;
		// 获取初始统计信息
		this.pc.getStats(null).then(stats => {
			stats.forEach(report => {
				if (report.type === "transport") {
					initialBytesReceived = report.bytesReceived;
				}
			});
		});
		// 等待指定的时间间隔后再次获取统计信息
		let durationInSeconds = 0.2
		setTimeout(() => {
			this.pc.getStats(null).then(stats => {
				stats.forEach(report => {
					if (report.type === "transport") {
						const finalBytesReceived = report.bytesReceived;
						const bytesReceived = finalBytesReceived - initialBytesReceived;

						// 计算平均带宽（单位：字节/秒）
						const averageReceiveBandwidth = (bytesReceived / durationInSeconds)*8/1000/1000;
						msg.videoencoderqp = this.VideoEncoderQP
						msg.netrate = averageReceiveBandwidth.toFixed(2)
						this.ws.send(JSON.stringify(msg));
						console.log("↑↑ handleGetStatus:", msg);
					}
				});
			});
		}, durationInSeconds * 1000);
	}

	onDataChannelMessage(data) {
		data = new Uint8Array(data);
		const utf16 = new TextDecoder("utf-16");
		switch (data[0]) {
			case RECEIVE.VideoEncoderAvgQP: {
				this.VideoEncoderQP = +utf16.decode(data.slice(1));
				// console.debug("↓↓ QP:", this.VideoEncoderQP);
				break;
			}
			case RECEIVE.Response: {
				// user custom message
				const detail = utf16.decode(data.slice(1));
				this.dispatchEvent(new CustomEvent("message", { detail }));
				console.info("UE response received", { length: detail.length });
				break;
			}
			case RECEIVE.Command: {
				const command = JSON.parse(utf16.decode(data.slice(1)));
				console.info("UE command received");
				if (command.command === "onScreenKeyboard") {
					if (command.showOnScreenKeyboard !== false) this.focusTextInput();
					else this.stopTextInput(true);
				}
				break;
			}
			case RECEIVE.FreezeFrame: {
				const size = new DataView(data.slice(1, 5).buffer).getInt32(0, true);
				const jpeg = data.slice(1 + 4);
				console.info("↓↓ freezed frame:", jpeg);
				break;
			}
			case RECEIVE.UnfreezeFrame: {
				console.info("↓↓ 【unfreeze frame】");
				break;
			}
			case RECEIVE.LatencyTest: {
				const latencyTimings = JSON.parse(utf16.decode(data.slice(1)));
				console.info("↓↓ latency timings:", latencyTimings);
				break;
			}
			case RECEIVE.QualityControlOwnership: {
				this.QualityControlOwnership = data[1] !== 0;
				console.info("↓↓ Quality Control Ownership:", this.QualityControlOwnership);
				break;
			}
			case RECEIVE.InitialSettings: {
				this.InitialSettings = JSON.parse(utf16.decode(data.slice(1)));
				console.log("↓↓ initial setting:", this.InitialSettings);
				break;
			}
			case RECEIVE.InputControlOwnership: {
				this.InputControlOwnership = data[1] !== 0;
				console.log("↓↓ input control ownership:", this.InputControlOwnership);
				break;
			}
			case RECEIVE.Protocol: {
				let protocol = JSON.parse(utf16.decode(data.slice(1)));
				console.log(protocol)
				if (protocol.Direction === 0) {
					for (let key in protocol) {
						SEND[key] = protocol[key].id
					}
				} else if (protocol.Direction === 1) {
					for (let key in protocol) {
						RECEIVE[key] = protocol[key].id
					}
				}

				this.dc.send(new Uint8Array([SEND.RequestInitialSettings]));
				this.dc.send(new Uint8Array([SEND.RequestQualityControl]));

				break
			}
			default: {
				console.error("Unknown UE message", { type: data[0], length: data.length });
			}
		}
	}

	setupVideo() {
		this.tabIndex = 0; // easy to focus..
		// this.autofocus = true;
		this.playsInline = true;
		this.setAttribute("playsinline", "");
		this.setAttribute("webkit-playsinline", "");
		this.disablepictureinpicture = true;

		// Recently many browsers can only autoplay the videos with sound off
		this.muted = true;
		this.autoplay = true;

		// this.onsuspend
		// this.onresize
		// this.requestPointerLock();

		this.style["pointer-events"] = "none";
		this.style["object-fit"] = "contain";
	}

	attachRemoteTrack(event) {
		if (this.destroyed) return;
		if (!this.remoteStream) this.remoteStream = new MediaStream();
		if (!this.remoteStream.getTracks().some(track => track.id === event.track.id)) {
			this.remoteStream.addTrack(event.track);
		}
		this.srcObject = this.remoteStream;
		if (event.track.kind === "video") {
			void this.attemptVideoPlay("video-track-attached");
		}
		if (event.track.kind === "audio") {
			this.dispatchEvent(new CustomEvent("remoteAudioReady"));
			void this.resumeAudio();
		}
	}

	dispatchVideoPlayState(result, errorName = "", trigger = "") {
		this.dispatchEvent(new CustomEvent("videoPlayState", { detail: { result, errorName, trigger } }));
	}

	armVideoPlayRetry() {
		if (this.videoPlayRetryHandler) return;
		this.videoPlayRetryHandler = () => {
			this.videoPlayRetryHandler = null;
			void this.attemptVideoPlay("user-gesture-retry");
		};
		document.addEventListener("click", this.videoPlayRetryHandler, { once: true, capture: true });
	}

	async attemptVideoPlay(trigger = "explicit") {
		this.playsInline = true;
		this.setAttribute("playsinline", "");
		this.setAttribute("webkit-playsinline", "");
		try {
			await this.play();
			this.dispatchVideoPlayState("success", "", trigger);
			return true;
		} catch (error) {
			const standardNames = new Set(["AbortError", "InvalidStateError", "NotAllowedError", "NotSupportedError", "SecurityError", "TypeError"]);
			const errorName = standardNames.has(error?.name) ? error.name : "Error";
			this.muted = true;
			this.dispatchVideoPlayState("fail", errorName, trigger);
			this.armVideoPlayRetry();
			return false;
		}
	}

	async resumeAudio() {
		if (this.dataset.peerstreamAudioEnabled === "false") { this.muted = true; return false; }
		this.muted = false;
		try {
			await this.play();
			if (this.dataset.peerstreamAudioEnabled === "false") { this.muted = true; return false; }
			this.dispatchEvent(new CustomEvent("remoteAudioPlaying"));
			return true;
		} catch (error) {
			// Mobile browsers require play() to be retried from a user gesture.
			this.muted = true;
			this.dispatchEvent(new CustomEvent("remoteAudioBlocked", { detail: { error } }));
			return false;
		}
	}

	setupDataChannel(e) {
		// See https://www.w3.org/TR/webrtc/#dom-rtcdatachannelinit for values (this is needed for Firefox to be consistent with Chrome.)
		// this.dc = this.pc.createDataChannel(label, { ordered: true });

		this.releaseTouches?.();
		this.stopTextInput();
		this.dc = e.channel;
		const channel = this.dc;

		// Inform browser we would like binary data as an ArrayBuffer (FF chooses Blob by default!)
		this.dc.binaryType = "arraybuffer";

		this.dc.onopen = (e) => {
			console.log("✅", this.dc);
			this.style.pointerEvents = "auto";

			// setTimeout(() => {
			// 	this.dc.send(new Uint8Array([SEND.RequestInitialSettings]));
			// 	this.dc.send(new Uint8Array([SEND.RequestQualityControl]));
			// }, 500);
		};



		this.dc.onclose = (e) => {
			if (this.dc !== channel) return;
			this.releaseTouches?.();
			this.stopTextInput();
			console.info("❌ data channel closed");
			this.style.pointerEvents = "none";
			this.blur();
		};

		this.dc.onerror;

		this.dc.onmessage = (e) => {
			this.onDataChannelMessage(e.data);
		};
	}

	setupDataChannel_ue4(label = 'hello') {
		// See https://www.w3.org/TR/webrtc/#dom-rtcdatachannelinit for values (this is needed for Firefox to be consistent with Chrome.)
		this.releaseTouches?.();
		this.stopTextInput();
		this.dc = this.pc.createDataChannel(label, { ordered: true })
		const channel = this.dc;
		// Inform browser we would like binary data as an ArrayBuffer (FF chooses Blob by default!)
		this.dc.binaryType = 'arraybuffer'

		this.dc.onopen = (e) => {
			console.log('✅ data channel connected:', label)
			this.style.pointerEvents = 'auto'
			this.dc.send(new Uint8Array([SEND.RequestInitialSettings]))
			this.dc.send(new Uint8Array([SEND.RequestQualityControl]))
		}

		this.dc.onclose = (e) => {
			if (this.dc !== channel) return;
			this.releaseTouches?.();
			this.stopTextInput();
			console.info('❌ data channel closed:', label)
			this.style.pointerEvents = 'none'
		}

		this.dc.onmessage = (e) => {
			this.onDataChannelMessage(e.data)
		}
	}

	setupPeerConnection(playerGeneration = this.playerConnectionGeneration) {
		if (this.destroyed || playerGeneration !== this.playerConnectionGeneration) {
			console.debug("ignore stale player event", playerGeneration);
			return false;
		}
		this.releaseTouches?.();
		this.pc.close();
		this.offerGeneration += 1;
		this.offerInProgress = false;
		this.answerInProgress = false;
		this.remoteStream = new MediaStream();
		this.pc = new RTCPeerConnection({
			sdpSemantics: "unified-plan",
			bundlePolicy: "balanced",
			iceServers: iceServers,
			...(iceTransportPolicy ? { iceTransportPolicy } : {})
		});
		const pc = this.pc;

		this.pc.ontrack = (e) => {
			if (playerGeneration !== this.playerConnectionGeneration || this.pc !== pc) return;
			console.log(`↓↓ ${e.track.kind} track:`, e);
			this.attachRemoteTrack(e);
		};
		this.pc.onicecandidate = (e) => {
			if (playerGeneration !== this.playerConnectionGeneration || this.pc !== pc) return;
			// firefox
			if (e.candidate?.candidate) {
				this.ws.send(JSON.stringify({ type: "iceCandidate", candidate: e.candidate }));
			} else {
				// Notice that the end of negotiation is detected here when the event"s candidate property is null.
			}
		};

		this.pc.ondatachannel = (e) => {
			if (playerGeneration !== this.playerConnectionGeneration || this.pc !== pc) return;
			this.setupDataChannel(e);
		};
		this.watchPeerConnection();
		return true;
	}

	setupPeerConnection_ue4(playerGeneration = this.playerConnectionGeneration, playerId = this.activePlayerId) {
		if (this.destroyed || playerGeneration !== this.playerConnectionGeneration || this.activePlayerGeneration !== playerGeneration || this.activePlayerId !== playerId) {
			console.debug("[playerConnected ignored stale]", { generation: playerGeneration });
			return false;
		}
		this.releaseTouches?.();
		this.pc.close()
		this.offerGeneration += 1
		this.offerInProgress = false
		this.answerInProgress = false
		this.legacyIceRestartAttempts = 0
		this.remoteStream = new MediaStream()
		this.pc = new RTCPeerConnection({
			sdpSemantics: 'unified-plan',
			bundlePolicy: 'balanced',
			iceServers: iceServers,
			...(iceTransportPolicy ? { iceTransportPolicy } : {})
		})
		const pc = this.pc

		this.pc.ontrack = (e) => {
			if (playerGeneration !== this.playerConnectionGeneration || this.activePlayerId !== playerId || this.pc !== pc) return
			console.log(`↓↓ ${e.track.kind} track:`, e)
			this.attachRemoteTrack(e)
		}
		this.pc.onicecandidate = (e) => {
			if (playerGeneration !== this.playerConnectionGeneration || this.activePlayerId !== playerId || this.pc !== pc) return
			// firefox
			if (e.candidate?.candidate) {
				this.ws.send(
					JSON.stringify({ type: 'iceCandidate', candidate: e.candidate })
				)
			} else {
				// Notice that the end of negotiation is detected here when the event"s candidate property is null.
			}
		}
		this.pc.onnegotiationneeded = (e) => {
			if (playerGeneration !== this.playerConnectionGeneration || this.activePlayerId !== playerId || this.pc !== pc) return
			this.setupOffer(false, playerGeneration, playerId)
		}
		// Safari may ignore legacy offerToReceive options. Declare receivers once
		// per connection so the browser offer contains media, even without a data channel.
		if (this.hasAttribute('audio')) pc.addTransceiver('audio', { direction: 'recvonly' })
		pc.addTransceiver('video', { direction: 'recvonly' })
		this.watchPeerConnection()
		return true
	}

	async setupOffer(iceRestart = false, playerGeneration = this.playerConnectionGeneration, playerId = this.activePlayerId) {
		const pc = this.pc
		const ws = this.ws
		if (this.destroyed || playerGeneration !== this.playerConnectionGeneration || (playerId && (this.activePlayerGeneration !== playerGeneration || this.activePlayerId !== playerId))) return
		if (this.offerInProgress || pc.signalingState !== "stable") return
		this.offerInProgress = true
		const generation = this.offerGeneration
		try {
			const offer = await pc.createOffer({
				voiceActivityDetection: false,
				iceRestart,
			})

			// this indicate we support stereo (Chrome needs this)
			offer.sdp = offer.sdp.replace(
				'useinbandfec=1',
				'useinbandfec=1;stereo=1;sprop-maxcapturerate=48000'
			)

			if (playerGeneration !== this.playerConnectionGeneration || this.ws !== ws || this.pc !== pc || this.offerGeneration !== generation || pc.signalingState !== "stable") return
			await pc.setLocalDescription(offer)

			if (playerGeneration !== this.playerConnectionGeneration || this.ws !== ws || this.pc !== pc || this.offerGeneration !== generation || ws.readyState !== WebSocket.OPEN) return
			ws.send(JSON.stringify(offer))
		} finally {
			if (this.offerGeneration === generation) this.offerInProgress = false
		}
	}

	keysDown = new Set()
	textInputMode = "off"
	textInputActive = false

	setTextInputMode(mode) {
		this.stopTextInput();
		this.textInputMode = ["auto", "force", "off"].includes(mode) ? mode : "off";
		this.videoElement.dispatchEvent?.(new CustomEvent("textInputModeChanged", { detail: { mode: this.textInputMode } }));
	}

	stopTextInput(restoreFocus = false) {
		this.textComposing = false;
		this.textInputActive = false;
		if (this.textInput) this.textInput.value = "";
		this.textInput?.blur();
		this.releaseKeyboardKeys();
		this.notifyTextInputState();
		if (restoreFocus && !this.destroyed) this.videoElement.focus?.({ preventScroll: true });
	}

	notifyTextInputState() {
		this.videoElement.dispatchEvent?.(new CustomEvent("textInputState", { detail: { active: this.textInputActive } }));
	}

	positionTextInput() {
		if (!this.textInput) return;
		const bounds = this.videoElement.getBoundingClientRect();
		const content = this.videoContentRect();
		this.textInput.style.left = `${bounds.left + content.left + content.width / 2}px`;
		this.textInput.style.top = `${bounds.top + content.top + content.height * .75}px`;
	}

	canSendKeyboardInput() {
		return !this.destroyed && this.dc?.readyState === "open" && document.body?.dataset?.inputRole !== "viewer";
	}

	releaseKeyboardKeys() {
		if (this.dc?.readyState === "open") {
			for (const keyCode of this.keysDown) this.dc.send(new Uint8Array([SEND.KeyUp, keyCode]));
		}
		this.keysDown.clear();
	}

	sendText(text) {
		if (!this.canSendKeyboardInput() || !this.textInputActive || this.textInputMode === "off") return;
		// KeyPress carries one UTF-16 code unit, including surrogate pairs.
		for (let i = 0; i < text.length; i++) this.onkeypress({ keyCode: text.charCodeAt(i) });
	}

	focusTextInput() {
		if (!this.canSendKeyboardInput() || this.textInputMode === "off") return;
		if (!this.textInput) {
			const input = document.createElement("textarea");
			input.setAttribute("aria-label", "远程项目文字输入");
			input.setAttribute("autocomplete", "off");
			input.setAttribute("autocapitalize", "off");
			input.spellcheck = false;
			input.tabIndex = -1;
			// A real editable target allows browser IME without covering the video.
			Object.assign(input.style, { position: "fixed", left: "50%", top: "75%", width: "1px", height: "1px", padding: "0", border: "0", fontSize: "16px", opacity: "0.01", pointerEvents: "none" });
			(this.videoElement.parentElement || document.body).append(input);
			this.textInput = input;
			input.addEventListener("compositionstart", () => {
				this.textComposing = true;
				this.releaseKeyboardKeys();
			});
			input.addEventListener("compositionend", e => {
				if (!this.textComposing) return;
				this.textComposing = false;
				this.sendText(e.data || "");
				input.value = "";
			});
			input.addEventListener("input", e => {
				if (this.textComposing || e.isComposing) return;
				this.sendText(input.value);
				input.value = "";
			});
			input.addEventListener("paste", e => {
				e.preventDefault();
				if (this.textComposing) return;
				this.releaseKeyboardKeys();
				this.sendText((e.clipboardData?.getData("text/plain") || "").replace(/\r\n|\n/g, "\r"));
				input.value = "";
			});
			input.addEventListener("keydown", e => {
				if (e.key === "Escape" && !this.textComposing && !e.isComposing && e.keyCode !== 229) {
					e.preventDefault(); this.setTextInputMode("off"); this.videoElement.focus?.({ preventScroll: true }); return;
				}
				if (this.textComposing || e.isComposing || e.keyCode === 229) return;
				// The browser supplies clipboard text, not the remote host clipboard.
				if (((e.ctrlKey || e.metaKey) && e.code === "KeyV") || (e.shiftKey && e.code === "Insert")) return;
				this.onkeydown(e);
				if (e.key === "Enter") {
					e.preventDefault();
					this.onkeypress({ keyCode: 13 });
				}
			});
			input.addEventListener("keyup", e => this.onkeyup(e));
			input.addEventListener("blur", () => {
				this.textComposing = false;
				this.textInputActive = false;
				input.value = "";
				this.releaseKeyboardKeys();
				this.notifyTextInputState();
			});
		}
		this.positionTextInput();
		this.textInputActive = true;
		this.textInput.focus({ preventScroll: true });
		this.notifyTextInputState();
	}

	registerKeyboardEvents() {
		this.onkeydown = (e) => {
			if (!this.canSendKeyboardInput() || e.isComposing || this.textComposing || e.keyCode === 229) return;
			const keyCode = SpecialKeyCodes[e.code] || e.keyCode;
			this.dc.send(new Uint8Array([SEND.KeyDown, keyCode, e.repeat]));
			this.keysDown.add(keyCode);
			if (e.keyCode === SpecialKeyCodes.Backspace) this.onkeypress({ keyCode: SpecialKeyCodes.Backspace });
		};
		this.onkeyup = (e) => {
			const keyCode = SpecialKeyCodes[e.code] || e.keyCode;
			if (this.canSendKeyboardInput() && this.keysDown.has(keyCode)) this.dc.send(new Uint8Array([SEND.KeyUp, keyCode]));
			this.keysDown.delete(keyCode);
		};
		this.onkeypress = (e) => {
			if (!this.canSendKeyboardInput() || e.isComposing || this.textComposing) return;
			const data = new DataView(new ArrayBuffer(3));
			data.setUint8(0, SEND.KeyPress);
			data.setUint16(1, SpecialKeyCodes[e.code] || e.keyCode, true);
			this.dc.send(data);
		};
		this.onblur = () => {
			this.releaseTouches?.();
			this.releaseKeyboardKeys();
		};
		this.textInputClickHandler = () => {
			if (this.textInputMode === "force") this.focusTextInput();
		};
		this.videoElement.addEventListener("click", this.textInputClickHandler);
		this.textInputResizeHandler = () => this.positionTextInput();
		window.addEventListener?.("resize", this.textInputResizeHandler);
		document.addEventListener?.("fullscreenchange", this.textInputResizeHandler);
		this.videoElement.addEventListener("resize", this.textInputResizeHandler);
	}

	registerHybridTouchEvents() {
		// Reuse both protocol implementations, but never send both for one gesture.
		this.registerTouchEvents();
		const native = { start: this.ontouchstart, move: this.ontouchmove, end: this.ontouchend, release: this.releaseTouches };
		window.removeEventListener("blur", this.touchBlurHandler);
		document.removeEventListener("visibilitychange", this.touchVisibilityHandler);
		this.registerFakeMouseEvents();
		const mouse = { start: this.ontouchstart, move: this.ontouchmove, end: this.ontouchend, release: this.releaseTouches };
		const touches = new Map();
		let multi = false;
		const eventFor = (e, changedTouches = e.changedTouches) => ({ changedTouches, touches: [...touches.values()], preventDefault: () => e.preventDefault() });
		this.releaseTouches = () => {
			mouse.release();
			native.release();
			touches.clear();
			multi = false;
		};
		this.ontouchstart = e => {
			e.preventDefault();
			if (this.destroyed || this.dc?.readyState !== "open") return;
			const bounds = this.getBoundingClientRect();
			const started = [];
			for (const touch of e.changedTouches) {
				if (touches.has(touch.identifier) || !this.normalize(touch.clientX - bounds.left, touch.clientY - bounds.top).inRange) continue;
				touches.set(touch.identifier, touch);
				started.push(touch);
			}
			for (const touch of e.touches) if (touches.has(touch.identifier)) touches.set(touch.identifier, touch);
			if (!started.length) return;
			if (!multi && touches.size > 1) {
				mouse.release();
				multi = true;
				native.start(eventFor(e, [...touches.values()]));
			} else (multi ? native : mouse).start(eventFor(e, started));
		};
		this.ontouchmove = e => {
			for (const touch of e.touches) if (touches.has(touch.identifier)) touches.set(touch.identifier, touch);
			(multi ? native : mouse).move(eventFor(e));
		};
		this.ontouchend = e => {
			(multi ? native : mouse).end(eventFor(e));
			for (const touch of e.changedTouches) touches.delete(touch.identifier);
			// Keep native mode when two fingers become one: no synthetic mouse press.
			if (!touches.size) multi = false;
		};
		this.ontouchcancel = this.ontouchend;
	}

	registerTouchEvents() {
		// Native touch handles both single and multiple fingers, as in Epic's frontend.
		// FakeMouseWithTouches is only a fallback for applications without touch input.
		// https://github.com/EpicGamesExt/PixelStreamingInfrastructure/blob/UE5.5/Frontend/Docs/Customizing%20Player%20Input%20Options.md
		const fingers = [9, 8, 7, 6, 5, 4, 3, 2, 1, 0];
		const fingerIds = {};
		const activeTouches = new Map();
		this.style.touchAction = "none";
		const remember = touch => activeTouches.set(touch.identifier, {
			identifier: touch.identifier, clientX: touch.clientX, clientY: touch.clientY, force: touch.force
		});
		const forget = touch => {
			if (!activeTouches.has(touch.identifier)) return;
			fingers.push(fingerIds[touch.identifier]);
			fingers.sort((a, b) => b - a);
			delete fingerIds[touch.identifier];
			activeTouches.delete(touch.identifier);
		};
		this.releaseTouches = () => {
			this.emitTouchData(SEND.TouchEnd, [...activeTouches.values()], fingerIds);
			for (const touch of [...activeTouches.values()]) forget(touch);
		};
		this.touchBlurHandler = () => this.releaseTouches();
		this.touchVisibilityHandler = () => { if (document.hidden) this.releaseTouches(); };
		window.addEventListener("blur", this.touchBlurHandler);
		document.addEventListener("visibilitychange", this.touchVisibilityHandler);

		this.ontouchstart = (e) => {
			e.preventDefault();
			if (this.destroyed || this.dc?.readyState !== "open") return;
			const bounds = this.getBoundingClientRect();
			const started = [];
			for (const touch of e.changedTouches) {
				if (activeTouches.has(touch.identifier) || !this.normalize(touch.clientX - bounds.left, touch.clientY - bounds.top).inRange) continue;
				const finger = fingers.pop();
				if (finger === undefined) continue;
				fingerIds[touch.identifier] = finger;
				remember(touch);
				started.push(touch);
			}
			this.emitTouchData(SEND.TouchStart, started, fingerIds);
		};

		this.ontouchend = (e) => {
			this.emitTouchData(SEND.TouchEnd, e.changedTouches, fingerIds);
			for (const touch of e.changedTouches) forget(touch);
			e.preventDefault();
		};
		this.ontouchcancel = this.ontouchend;

		this.ontouchmove = (e) => {
			for (const touch of e.touches) {
				if (activeTouches.has(touch.identifier)) remember(touch);
			}
			this.emitTouchData(SEND.TouchMove, e.touches, fingerIds);
			e.preventDefault();
		};
	}

	// touch as mouse
	registerFakeMouseEvents() {
		let finger = undefined;
		this.style.touchAction = "none";
		this.releaseTouches = () => {
			if (!finger) return;
			if (this.dc?.readyState === "open") {
				const content = this.videoContentRect();
				this.emitMouseUp(MouseButton.MainButton, Math.max(content.left, Math.min(content.left + content.width - 0.01, finger.x)), Math.max(content.top, Math.min(content.top + content.height - 0.01, finger.y)));
				this.onmouseleave({ buttons: 0 });
			}
			finger = undefined;
		};
		this.touchBlurHandler = () => this.releaseTouches();
		this.touchVisibilityHandler = () => { if (document.hidden) this.releaseTouches(); };
		window.addEventListener("blur", this.touchBlurHandler);
		document.addEventListener("visibilitychange", this.touchVisibilityHandler);

		this.ontouchstart = (e) => {
			e.preventDefault();
			if (this.destroyed || this.dc?.readyState !== "open" || !e.changedTouches.length) return;
			if (finger === undefined) {
				const firstTouch = e.changedTouches[0];
				const { left, top } = this.getBoundingClientRect();
				if (!this.normalize(firstTouch.clientX - left, firstTouch.clientY - top).inRange) return;
				finger = {
					id: firstTouch.identifier,
					x: firstTouch.clientX - left,
					y: firstTouch.clientY - top,
				};
				// Hack: Mouse events require an enter and leave so we just enter and leave manually with each touch as this event is not fired with a touch device.
				this.onmouseenter(e);
				this.emitMouseDown(MouseButton.MainButton, finger.x, finger.y);
			}
			e.preventDefault();
		};

		this.ontouchend = (e) => {
			// filtering multi finger touch events temporarily
			if (finger) {
				for (const touch of e.changedTouches) {
					if (touch.identifier === finger.id) {
						const { left, top } = this.getBoundingClientRect();
						const x = touch.clientX - left;
						const y = touch.clientY - top;
						finger.x = x;
						finger.y = y;
						this.releaseTouches();
						break;
					}
				}
			}
			e.preventDefault();
		};

		this.ontouchmove = (e) => {
			// filtering multi finger touch events temporarily
			if (finger && this.dc?.readyState === "open") {
				for (const touch of e.touches) {
					if (touch.identifier === finger.id) {
						const { left, top } = this.getBoundingClientRect();
						const x = touch.clientX - left;
						const y = touch.clientY - top;
						this.emitMouseMove(x, y, x - finger.x, y - finger.y);
						finger.x = x;
						finger.y = y;
						break;
					}
				}
			}
			e.preventDefault();
		};
		this.ontouchcancel = this.ontouchend;
	}

	registerMouseHoverEvents() {
		this.registerMouseEnterAndLeaveEvents();

		this.onmousemove = (e) => {
			this.emitMouseMove(e.offsetX, e.offsetY, e.movementX, e.movementY);
			e.preventDefault();
		};

		this.onmousedown = (e) => {
			this.emitMouseDown(e.button, e.offsetX, e.offsetY);
			// e.preventDefault();
		};

		this.onmouseup = (e) => {
			this.emitMouseUp(e.button, e.offsetX, e.offsetY);
			// e.preventDefault();
		};

		// When the context menu is shown then it is safest to release the button which was pressed when the event happened. This will guarantee we will get at least one mouse up corresponding to a mouse down event. Otherwise the mouse can get stuck.
		// https://github.com/facebook/react/issues/5531
		this.oncontextmenu = (e) => {
			this.emitMouseUp(e.button, e.offsetX, e.offsetY);
			e.preventDefault();
		};

		this.onwheel = (e) => {
			this.emitMouseWheel(e.wheelDelta, e.offsetX, e.offsetY);
			e.preventDefault();
		};
	}

	registerPointerLockEvents() {
		this.registerMouseEnterAndLeaveEvents();

		console.info("mouse locked in, ESC to exit");

		const { clientWidth, clientHeight } = this;
		let x = clientWidth / 2;
		let y = clientHeight / 2;

		this.onmousemove = (e) => {
			x += e.movementX;
			y += e.movementY;
			x = (x + clientWidth) % clientWidth;
			y = (y + clientHeight) % clientHeight;

			this.emitMouseMove(x, y, e.movementX, e.movementY);
		};

		this.onmousedown = (e) => {
			this.emitMouseDown(e.button, x, y);
		};

		this.onmouseup = (e) => {
			this.emitMouseUp(e.button, x, y);
		};

		this.onwheel = (e) => {
			this.emitMouseWheel(e.wheelDelta, x, y);
		};
	}

	registerMouseEnterAndLeaveEvents() {
		this.onmouseenter = (e) => {
			this.dc.send(new Uint8Array([SEND.MouseEnter]));
		};

		this.onmouseleave = (e) => {
			if (this.dc.readyState === "open") this.dc.send(new Uint8Array([SEND.MouseLeave]));
			// 释放掉
			const content = this.videoContentRect();
			for (let i = 1; i <= 16; i *= 2) {
				if (e.buttons & i) {
					this.emitMouseUp(MouseButtonsMask[i], content.left + content.width / 2, content.top + content.height / 2)
				}
			}
		};
	}

	emitMouseMove(x, y, deltaX, deltaY) {
		const coord = this.normalize(x, y);
		if (!coord.inRange) return;
		const content = this.videoContentRect();
		deltaX = (deltaX * 65536) / content.width;
		deltaY = (deltaY * 65536) / content.height;
		const data = new DataView(new ArrayBuffer(9));
		data.setUint8(0, SEND.MouseMove);
		data.setUint16(1, coord.x, true);
		data.setUint16(3, coord.y, true);
		data.setInt16(5, deltaX, true);
		data.setInt16(7, deltaY, true);
		this.dc.send(data);
		this.lastmouseTime = new Date()
	}

	emitMouseDown(button, x, y) {
		const coord = this.normalize(x, y);
		if (!coord.inRange) return;
		const data = new DataView(new ArrayBuffer(6));
		data.setUint8(0, SEND.MouseDown);
		data.setUint8(1, button);
		data.setUint16(2, coord.x, true);
		data.setUint16(4, coord.y, true);
		this.dc.send(data);
		if (this.enableChinese) {
			this.dc.send(new Uint8Array([SEND.FindFocus]))
		}
	}

	emitMouseUp(button, x, y) {
		const coord = this.normalize(x, y);
		if (!coord.inRange) return;
		const data = new DataView(new ArrayBuffer(6));
		data.setUint8(0, SEND.MouseUp);
		data.setUint8(1, button);
		data.setUint16(2, coord.x, true);
		data.setUint16(4, coord.y, true);
		this.dc.send(data);
	}

	emitMouseWheel(delta, x, y) {
		const coord = this.normalize(x, y);
		if (!coord.inRange) return;
		const data = new DataView(new ArrayBuffer(7));
		data.setUint8(0, SEND.MouseWheel);
		data.setInt16(1, delta, true);
		data.setUint16(3, coord.x, true);
		data.setUint16(5, coord.y, true);
		this.dc.send(data);
	}

	emitTouchData(type, touches, fingerIds) {
		if (this.dc?.readyState !== "open") return;
		const bounds = this.getBoundingClientRect();
		const content = this.videoContentRect();
		for (const touch of touches) {
			const finger = fingerIds[touch.identifier];
			if (finger === undefined) continue;
			let x = touch.clientX - bounds.left;
			let y = touch.clientY - bounds.top;
			// An active finger must still release when it ends outside the video.
			if (type === SEND.TouchEnd) {
				x = Math.max(content.left, Math.min(content.left + content.width, x));
				y = Math.max(content.top, Math.min(content.top + content.height, y));
			}
			const coord = this.normalize(x, y);
			// Epic UE5.0/5.5: one touch per packet, including the final valid byte.
			// Frontend/library/src/Inputs/TouchController.ts in the official infrastructure.
			const data = new DataView(new ArrayBuffer(9));
			data.setUint8(0, type);
			data.setUint8(1, 1);
			data.setUint16(2, Math.min(65535, coord.x), true);
			data.setUint16(4, Math.min(65535, coord.y), true);
			data.setUint8(6, finger);
			const force = type === SEND.TouchEnd ? 0 : (touch.force > 0 ? Math.min(1, touch.force) : 1);
			// Tiny positive pressure must not quantize to a released (zero) value.
			data.setUint8(7, type === SEND.TouchEnd ? 0 : Math.max(1, Math.floor(255 * force)));
			data.setUint8(8, coord.inRange ? 1 : 0);
			this.dc.send(data);
		}
	}

	// emit string
	emitMessage(msg, messageType = SEND.UIInteraction) {
		if (typeof msg !== "string") msg = JSON.stringify(msg);

		// Add the UTF-16 JSON string to the array byte buffer, going two bytes at a time.
		const data = new DataView(new ArrayBuffer(1 + 2 + 2 * msg.length));
		let byteIdx = 0;
		data.setUint8(byteIdx, messageType);
		byteIdx++;
		data.setUint16(byteIdx, msg.length, true);
		byteIdx += 2;
		for (let i = 0; i < msg.length; i++) {
			// charCodeAt() is UTF-16, codePointAt() is Unicode.
			data.setUint16(byteIdx, msg.charCodeAt(i), true);
			byteIdx += 2;
		}
		this.dc.send(data);
	}

	videoContentRect() {
		const elementWidth = Math.max(1, this.clientWidth);
		const elementHeight = Math.max(1, this.clientHeight);
		const videoWidth = Math.max(1, this.videoWidth || elementWidth);
		const videoHeight = Math.max(1, this.videoHeight || elementHeight);
		const scale = Math.min(elementWidth / videoWidth, elementHeight / videoHeight);
		const width = videoWidth * scale;
		const height = videoHeight * scale;
		return { left: (elementWidth - width) / 2, top: (elementHeight - height) / 2, width, height };
	}

	normalize(x, y) {
		const content = this.videoContentRect();
		const normalizedX = (x - content.left) / content.width;
		const normalizedY = (y - content.top) / content.height;
		if (normalizedX < 0.0 || normalizedX > 1.0 || normalizedY < 0.0 || normalizedY > 1.0) {
			return {
				inRange: false,
				x: 65535,
				y: 65535,
			};
		} else {
			return {
				inRange: true,
				x: normalizedX * 65536,
				y: normalizedY * 65536,
			};
		}
	}


}

globalThis.PeerStreamController = PeerStreamController;
