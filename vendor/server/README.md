# PeerStream Signal / Execue Source Edition

An independent, source-maintainable Signal and Execue implementation derived from the public MIT-licensed `inveta/peer-stream` project. It runs in parallel with PeerStreamEnterprise and does not modify or unlock proprietary commercial code.

## Implemented in 0.1

- Separate Player, Engine, Execue and Admin WebSocket roles with role tokens.
- Versioned `peerstream.source.v1` control protocol.
- URL-prefix project routing and structured project configuration.
- One-to-one and shared allocation modes.
- Signal-authoritative activity, idle warning and user-idle termination.
- Network-disconnect recovery grace period.
- Structured UE start/stop requests; no arbitrary remote shell endpoint.
- Execue executable allowlist, PID registry and Windows process-tree termination.
- Instance/session lifecycle events, heartbeat and JSONL logs.
- Safe static path boundary and `/health` endpoint.
- Agent reconnection with exponential backoff.
- Dedicated source player adapter with separate Signal, WebRTC, data-channel, video and lifecycle diagnostics.
- Token-protected Admin status and precise instance-stop controls.
- Durable instance registry with verified PID, creation-time and executable identity checks.
- Automatic promotion from a packaged-UE launcher PID to the real runtime PID.
- Signal and Execue restart recovery without launching a duplicate UE instance.
- Five-second Execue heartbeat/snapshot reconciliation and configurable recovery timeouts.
- Per-project Pixel Streaming protocol selection: automatic, UE5/Unified Plan, or legacy UE/Browser-Send-Offer.
- UE4/legacy routing sends `playerConnected` to the browser, while UE5 routing sends it to the Engine.
- Native `IsUnifiedPlan`/`GetTransceivers` crashes are reported as `ue_webrtc_protocol_incompatible` instead of a generic disconnect.
- Engine connection timeouts now distinguish an unstarted UE from a running UE that may be missing the Pixel Streaming plugin.
- Pixel Streaming plugin/module load errors use the explicit `pixel_streaming_plugin_missing` reason. A connection timeout alone uses `ue_engine_connect_timeout` and is never treated as proof that the plugin is missing.

## Run alongside the existing service

```powershell
cd PeerStreamSource
npm install
npm test
npm run start:signal
```

In another terminal:

```powershell
cd PeerStreamSource
npm run start:execue
```

The source Signal listens on `127.0.0.1:12188`, so it does not conflict with the current Enterprise port `11188`.

Health check: `http://127.0.0.1:12188/health`.

Player page: `http://127.0.0.1:12188/?project=AA&token={playerToken}`.

## WebSocket endpoints

- Player: `ws://127.0.0.1:12188/player?project=AA&token=...`
- Engine: `ws://127.0.0.1:12188/engine/AA/{instanceId}?token=...`
- Execue: `ws://127.0.0.1:12188/execue?id=local&token=...`
- Admin: `ws://127.0.0.1:12188/admin?token=...`

The source player is isolated in `public/` and does not replace the Enterprise `dist/video.html`. The adapter emits `source-diagnostics` events and exposes the latest snapshot as `window.sourceDiagnostics` for the launcher and automated health checks.

## Verified integration baseline

On 2026-08-25, the integration profile passed a real packaged-UE test: Engine registration, WebRTC video decode at 1280×720, open UE input data channel, mouse-input transmission, two-player shared access to one instance, structured Admin reclaim, and complete cleanup of the registered UE process tree. Test screenshots and CDP probes live under `test/`.

The 4.1 recovery test additionally passed independent Execue and Signal restarts. The same instance ID and real UE PID were preserved, the browser and Engine reconnected, no duplicate UE was launched, and the recovered process tree remained controllable through Admin reclaim.

The 4.2 compatibility test passed against both the existing UE5 project and the legacy `XiangSu` project. Legacy mode kept the real UE process running, decoded video, opened the input data channel, and transmitted mouse input without the previous Unified Plan fatal error.

## Security notes

The upstream `/eval`, `/exec` and `/write` endpoints are intentionally absent. Execue only starts executable paths present in its local allowlist. Change every example token before binding Signal to a non-loopback address. For public deployment, place TLS/WSS and rate limiting in front of Signal.

## License

MIT. See `LICENSE` and `THIRD_PARTY_NOTICES.md`.
