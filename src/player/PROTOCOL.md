# 圣效像素流 · 播放页协议说明

本文记录 `index.html` 实际实现的信令/控制流程，以及从 vendor 源码中核实的
**分辨率 / 码率控制命令格式**。

- 信令服务：`src/signal/index.js`（默认端口 `12188`）
- 客户端参考实现：`public/peer-stream.js`、`public/source-video.html`
- 服务端参考实现：`src/signal/server.js`、`src/shared/protocol.js`
- 协议版本字段：`protocol = "peerstream.source.v1"`（本页不校验，仅记录）

---

## 1. 地址与鉴权

| 角色 | WebSocket 地址 | Token（`config/signal.json → auth`） |
| --- | --- | --- |
| 播放页 | `ws://<host>:<port>/player?project=<项目编号>&token=<playerToken>` | `auth.playerToken` |
| 只读观看 | `ws://<host>:<port>/player?project=..&token=<viewerToken>&viewOnly=1` | `auth.viewerToken` |
| UE 引擎端 | `ws://<host>:<port>/engine/<projectId>/<instanceId>?token=<engineToken>` | `auth.engineToken`（或实例一次性 ticket） |
| 执行端 | `ws://<host>:<port>/execue?id=<execueId>&token=<execueToken>` | `auth.execueToken` |

补充规则（读自 `server.js#authorize`）：

- 角色由 **URL 路径第一段** 决定：`/player`、`/engine`、`/execue`、`/admin`。
- Token 也可用 `Authorization: Bearer <token>` 头传递。
- `viewOnly=1` 时服务端期望的是 `viewerToken`，并把该会话标记为只读。
- 公网入口（`publicAccess.enabled`）下必须带 `share=<分享票据>`，此时不再校验静态 token；
  局域网部署下 `share` 参数可原样透传但会被忽略，仍走 token 鉴权。
- 服务端**不校验** `Sec-WebSocket-Protocol`（`ws` 库未配置 `handleProtocols`），
  因此本页不声明子协议；vendor 页面声明的 `peer-stream` 仅为习惯写法。
- 可选能力上报（服务端用于编码器选择/带宽策略，缺失时按默认值处理）：
  `client`（32~40 位十六进制，用于断线重连识别）、`tab`、`codecs`（如 `H264,AV1`）、
  `mobile=0|1`、`platform`、`av1=0|1`、`av1Factor=1|0.8|0.7`。

### 播放页 URL 参数（本页）

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `project` | — | 必填，`signal.json → projects[].id` |
| `token` | — | 必填（除公网 `share` 场景） |
| `share` | 空 | 公网分享票据 |
| `host` | `location.hostname` | 信令主机（file:// 打开时需显式指定） |
| `port` | `12188` | 信令端口 |
| `scheme` | `https:` 时 `wss`，否则 `ws` | WebSocket 协议 |
| `ice` | `host` | ICE 候选策略，见 §6 |
| `adaptive` | `1` | `0` 关闭向 UE 申请分辨率 |
| `audio` | `1` | `0` 不接收音频轨 |
| `viewOnly` | `0` | `1` 只读观看 |
| `debug` | `0` | `1` 直接展开诊断面板 |

---

## 2. 握手时序

### 2.1 播放页 ← → 信令服务（两种协议共同部分）

```
播放页                                         信令服务
  │ ── WS 连接 /player?project&token ─────────► │
  │ ◄── {"type":"hello", sessionId, projectId, projectName,
  │       pixelStreamingProtocol:"legacy|unified",
  │       pixelStreamingPlugin:"PixelStreaming|PixelStreaming2",
  │       bitrateProfile, adaptiveResolution, screenPercentage,
  │       qualityTiers, readOnly, serverVersion, codecObservation}
  │ ◄── {"type":"instance.lifecycle", state:"starting", ...}
  │      （服务端分配/冷启动 UE 实例；队列时先给 playerqueue）
  │ ◄── {"type":"instance.lifecycle", state:"connecting", phase:"engine_configured"}
  │ ◄── {"type":"seticeServers", iceServers:[...], iceTransportPolicy?}
  │ ◄── {"type":"instance.lifecycle", state:"running", inputRole:"controller|viewer", ...}
  │
  │  之后进入 offer/answer/iceCandidate 协商（见 2.2 / 2.3）
  │
  │ ◄── {"type":"ping"}   ──►  回 {"type":"pong"}（原样回显，仅改 type）
  │ ── {"type":"session.activity"}  （用户操作时，1 秒节流，用于服务端空闲计时续期）
  │ ── {"type":"session.telemetry"} （每 5 秒，WebRTC 统计采样）
  │ ◄── {"type":"bitrate.policy", recommendedLimitMbps, mode, route, ...}
  │ ◄── {"type":"session.control.role", role}
  │ ◄── {"type":"session.idle_warning", remainingSeconds}
  │ ◄── {"type":"instance.lifecycle", state:"ended", reasonCode}
  │ ◄── {"type":"error", code:"allocation_failed"}
```

只读 / 控制权：

- `hello.readOnly === true`（服务端由 `viewOnly=1` + `viewerToken` 判定）表示只读会话。
  此时服务端在 `playerConnected` 中给出 `dataChannel:false`，本页因此不创建数据通道，也不转发任何输入。
- `instance.lifecycle(state="running")` 里的 `inputRole` 与 `session.control.role` 都会给出
  `controller` / `viewer`。
- `{"type":"session.control.request"}` 申请控制权，**服务端仅在 `config.session.mode === "shared"`
  时受理**（`server.js#handlePlayerMessage`）；默认 `one2one` 模式下唯一观看者本身就是 controller，
  申请会收到 `session.control.role(controller)` 或直接无变化。

`hello` 关键字段用途：

| 字段 | 本页用法 |
| --- | --- |
| `pixelStreamingProtocol` | 决定谁创建 offer（`legacy`=浏览器，`unified`=UE） |
| `pixelStreamingPlugin` | 决定码率控制台命令前缀（`PixelStreaming.` / `PixelStreaming2.`） |
| `adaptiveResolution` | `false` 时不再下发 `r.SetRes`，仅本地自适应（当前实现为退化为纯本地缩放） |
| `screenPercentage` | 取值 `100/85/75/67` 时，在 `r.SetRes` 之后补发 `r.ScreenPercentage` |
| `readOnly` | 只读会话，不创建数据通道、不转发输入 |
| `codecObservation.ueVersion` | 用于 UE5.3 码率兼容判定 |

### 2.2 `protocol=legacy`（UE5.3 经典 PixelStreaming）

浏览器是 offer 发起方；**不会出现 `identify/endpointId`**。

```
UE 引擎端                信令服务                      播放页
   │ ── /engine/<p>/<i> ──► │
   │ ◄── {"type":"config", peerConnectionOptions, protocolVersion,
   │       pixelStreamingProtocol:"legacy"}     （legacy 不发 identify）
   │                         │ ── {"type":"seticeServers"} ──► │
   │                         │ ── {"type":"playerConnected", playerId,
   │                         │      dataChannel:true, sfu:false} ──► │
   │                         │                                     │ 创建 RTCPeerConnection
   │                         │                                     │ 创建 datachannel('hello')
   │                         │                                     │ addTransceiver(video/audio, recvonly)
   │ ◄── {"type":"offer", sdp, playerId} ◄── {"type":"offer", sdp} ─┤
   │ ── {"type":"answer", sdp, playerId} ──► {"type":"answer", sdp} ─► │
   │ ◄──► {"type":"iceCandidate", candidate}（双向，服务端补 playerId 转发）
```

服务端在 `bindPlayer()` 里先发 `seticeServers` 再发 `playerConnected`，顺序固定。

### 2.3 `protocol=unified`（UE5.8 PixelStreaming2）

UE 是 offer 发起方；**引擎端必须先完成 `identify/endpointId` 注册**，
否则服务端不会向该实例绑定任何播放端。

```
UE 引擎端                       信令服务                        播放页
   │ ── /engine/<p>/<i> ───────► │
   │ ◄── {"type":"config", peerConnectionOptions, protocolVersion,
   │       pixelStreamingProtocol:"unified"}          （先发 ICE 配置）
   │ ◄── {"type":"identify"}                          （仅 unified）
   │ ── {"type":"endpointId", id:"probe"} ──────────► │
   │ ◄── {"type":"endpointIdConfirm", committedId}     │
   │                               │  ── bindInstancePlayers → bindPlayer
   │ ◄── {"type":"playerConnected", playerId, dataChannel:true, sfu:false}
   │ ── {"type":"offer", sdp, playerId} ──► │
   │                               │ ── {"type":"offer", sdp}（去掉 playerId）──► │
   │                               │ ◄── {"type":"answer", sdp} ◄─────────────── │
   │ ◄── {"type":"answer", sdp, playerId}
   │ ◄──► {"type":"iceCandidate"}（双向）
```

播放侧实现要点：

- 收到 `offer` 后 `setRemoteDescription`；**仅当远端 SDP 没有对应 `m=` 行时**才补
  `addTransceiver('video'|'audio', {direction:'recvonly'})`，避免产生多余 m 行
  （vendor 为无条件添加，本页做了更保守的处理）。
- 数据通道由 UE 创建，播放页通过 `pc.ondatachannel` 接收，不主动创建。
- `identify` / `endpointId` / `endpointIdConfirm` 只存在于引擎端，播放页不参与。

---

## 3. 数据通道（UE 输入 / 控制通道）

- 标签：legacy 为 `hello`（`ordered:true`），unified 由 UE 侧决定。
- `binaryType = "arraybuffer"`。
- 打开后立即发送 `RequestInitialSettings(7)` 与 `RequestQualityControl(1)`；
  **unified 下先等 UE 下发 `Protocol(255)` 完成 id 重映射**，2 秒未收到才用默认 id 兜底。
- 字符串编码：**UTF-16LE**，解码统一用 `TextDecoder('utf-16')`（含 BOM 嗅探）。

### 3.1 浏览器 → UE

| id | 名称 | 负载 |
| --- | --- | --- |
| 0 | `IFrameRequest` | — |
| 1 | `RequestQualityControl` | — |
| 7 | `RequestInitialSettings` | — |
| 50 | `UIInteraction` | `[50][uint16 长度][UTF-16LE JSON]` |
| 51 | `Command` | `[51][uint16 长度][UTF-16LE JSON]`，JSON 形如 `{"ConsoleCommand":"..."}` |
| 60 | `KeyDown` | `[60][uint8 keyCode][uint8 repeat]` |
| 61 | `KeyUp` | `[61][uint8 keyCode]` |
| 62 | `KeyPress` | `[62][uint16 keyCode]` |
| 70/71 | `MouseEnter`/`MouseLeave` | — |
| 72/73 | `MouseDown`/`MouseUp` | `[id][uint8 button][uint16 x][uint16 y]` |
| 74 | `MouseMove` | `[74][uint16 x][uint16 y][int16 dx][int16 dy]` |
| 75 | `MouseWheel` | `[75][int16 delta][uint16 x][uint16 y]` |

坐标是 `0..65535` 归一化值，按**画面内容区**（`object-fit` 计算出的实际显示区域）映射；
特殊键码：`Backspace 8 / ShiftLeft 16 / ControlLeft 17 / AltLeft 18 /
ShiftRight 253 / ControlRight 254 / AltRight 255`。

### 3.2 UE → 浏览器

| id | 名称 | 说明 |
| --- | --- | --- |
| 0 | `QualityControlOwnership` | 画质控制权 |
| 1 | `Response` | 自定义消息回执 |
| 2 | `Command` | JSON 指令，如 `{"command":"onScreenKeyboard","showOnScreenKeyboard":true}` |
| 3/4 | `FreezeFrame`/`UnfreezeFrame` | 冻结/解冻画面 |
| 5 | `VideoEncoderAvgQP` | 编码 QP |
| 6 | `LatencyTest` | 延迟测量 |
| 7 | `InitialSettings` | 初始设置 JSON |
| 12 | `InputControlOwnership` | 输入控制权 |
| 255 | `Protocol` | `{"Direction":0|1, "<Name>":{"id":n}}`，`Direction=0` 重映射 `SEND`，`1` 重映射 `RECEIVE` |

---

## 4. 分辨率控制命令（已核实）

来源：`public/source-video.html` 的 `sendAdaptiveResolution()` 与 `scheduleScreenPercentageReapply()`，
经数据通道以 `emitMessage(payload, 51)` 发出。

| 目的 | 命令（`ConsoleCommand` 内容） |
| --- | --- |
| 修改 UE 渲染尺寸 | `r.SetRes <宽>x<高>w`（结尾 `w` 表示窗口模式，**必须带**） |
| 固定渲染比例 | `r.ScreenPercentage <100\|85\|75\|67>` |
| 查/改编码器 | 任意 UE 控制台命令，同一通道 |

- 示例：`{"ConsoleCommand":"r.SetRes 2560x1440w"}`、`{"ConsoleCommand":"r.ScreenPercentage 100"}`。
- 服务端前置条件：`hello.adaptiveResolution !== false`（对应
  `config/signal.json → rendering.adaptiveResolution`），否则 UE 端不会响应尺寸变更；
  本页在该字段为 `false` 时只做本地渲染自适应（见 §7）。
- 目标尺寸算法（参考 `resolution-policy.js`，本页做了简化）：
  `height = max(max(360, viewportH, 640*viewportH/viewportW) * min(dpr,2), 1080)`，
  `width = height * viewportW/viewportH`，再限制最长边 ≤ 3840、总像素 ≤ 3840×2160，
  宽高各自取偶。窗口变化（含全屏、`visualViewport` 变化、旋屏）后延迟 500~800 ms 下发，
  与上次目标相对差 < 3% 时跳过，两次下发间隔 ≥ 2 s。
- 下发后 4 秒内若 `videoWidth/Height` 未跟上目标，则清除"已下发"记录，允许下次重发。
- `screenPercentage ∈ {100,85,75,67}` 时，在 `r.SetRes` 之后 350 ms 补发 `r.ScreenPercentage`。

## 5. 码率控制命令（已核实）

来源：`public/source-video.html` 的 `sendBitrateCommands()`。

```
<前缀>.Encoder.TargetBitrate <bitrate>     // 目标码率，单位 bit/s；UE5.3 用 -1 表示不固定
<前缀>.WebRTC.MinBitrate     min(100000, bitrate)
<前缀>.WebRTC.StartBitrate   min(1000000, bitrate)
<前缀>.WebRTC.MaxBitrate     bitrate
```

- `<前缀>`：`PixelStreaming2`（PixelStreaming2 插件，UE5.4+）或 `PixelStreaming`（经典插件，UE5.3）。
- `bitrate = Mbps * 1000000`。
- UE5.3（`codecObservation.ueVersion` 匹配 `^5\.3`）时 `Encoder.TargetBitrate` 传 `-1`，
  即"不固定编码器目标码率，跟随 WebRTC 自适应"，只限制带宽上限。
- 触发来源：服务端 `{"type":"bitrate.policy"}`。`mode !== "auto"` 表示管理员固定/仅观察，
  此时本页不下发；`recommendedLimitMbps` 与上次相同或距上次下发 < 3 s 时跳过。
- 服务端侧要求播放页每 5 s 上报 `session.telemetry`（含
  `packetsReceivedDelta / packetsLostDelta / framesDecodedDelta / framesDroppedDelta /
  rttMs / bitrateMbps / connectionType / qualityMode / localCandidateType / remoteCandidateType /
  transportProtocol`），否则 `bitrate-policy.js` 不会产生新的策略。
  `session.telemetry` 无 UE 回执，属于单向控制。

---

## 6. ICE 与"局域网优先"

- 默认（`ice=host`，本页默认）**不配置任何 ICE 服务器**：`new RTCPeerConnection({iceServers: []})`，
  只收集 host / mDNS 主机候选，不解析外网 STUN，避免数秒握手延迟。
- 服务端会在 `bindPlayer` 前后下发 `seticeServers`（内容来自 `config/signal.json → iceServers`，
  该文件当前指向外网 STUN）。默认模式下本页**忽略**该消息；需要时用 `ice=server` 采纳。
- `ice=<url,url...>`：显式指定 STUN/TURN；`ice=host`（默认）只走本地候选。
- `iceTransportPolicy` 仅在 `ice=server` 时采纳服务端下发的 `relay`。
- 若两端不在同一网段，默认 host 模式会连接失败，此时页面会提示并自动重连一次，
  需要跨网访问时应改用 `ice=server` 或显式配置 TURN。

---

## 7. 未实现 / 与 vendor 的差异

| 项 | 说明 |
| --- | --- |
| 码率实测闭环 | 服务端 `bitrate.policy` 只做下发，不做"实测均值超限"校验（vendor 有 `bitrate-observer.js`） |
| 分辨率压力降级 | 未实现 `updateBitrateDrivenResolution()` 的网络压力降级逻辑 |
| `session.diagnostics` | 未上报（vendor 用于公网诊断编号与路由计费） |
| `codec.bitrate.sample` | 未发送（服务端会映射为 `session.telemetry`，本页只发标准遥测） |
| AV1 主动回退 | 未实现 `codecFallbackRequest` |
| 原生多点触控 | 单指映射为鼠标；未实现 `TouchStart/Move/End(80/81/82)` 原生触屏协议 |
| 画质档位下拉 | 未实现"高清/均衡/流畅"档位选择，遥测固定上报 `qualityMode:"balanced"` |
| 共享控制权申请 | 已实现发送与角色显示，但服务端仅在 `session.mode="shared"` 时受理 |
| 指针锁定 | 未实现 Pointer Lock 输入模式 |
| `adaptiveResolution=false` | 退化为**仅本地渲染尺寸自适应**（`object-fit` 缩放），不做任何服务端请求 |
| 静态资源 | 无外部依赖；图标为内联 SVG data URI |

## 8. 断线重连

- WebSocket 非正常关闭、或 `RTCPeerConnection` 变为 `failed` 时：最多重连 6 次，
  间隔 1.2s → 8s 递增；每次重连复用 `localStorage` 中的 `client` 与 `sessionStorage` 中的 `tab`，
  便于服务端按同一设备恢复会话。
- 收到 `instance.lifecycle(state="ended"|"stopping")` 或 `error` 时标记为终止态，不再自动重连，
  并在界面上用中文显示 `reasonCode` 对应的原因。

---

## 9. 本页实测记录（2026-10-09）

对 `config/signal.json` 中登记的两个项目做了真机验证（信令服务由管理器自带
`runtime\node.exe src/signal/index.js config/signal.json` 启动，端口 12188）：

| 项目 | 插件 | 协议 | 播放端实际收到 | 引擎端实际收到 |
| --- | --- | --- | --- | --- |
| `PCC3476A`（UE5.8） | PixelStreaming2 | `unified` | `hello` → `instance.lifecycle(starting)` → `session.control.role` → `seticeServers` → `instance.lifecycle(running)` → `offer` → `iceCandidate` ×2 → `bitrate.policy` | `config` → `identify` → `endpointIdConfirm` → `playerConnected` → `answer` |
| `P164009D`（UE5.3） | PixelStreaming | `legacy` | `hello` → `instance.lifecycle(starting)` → `session.control.role` → `seticeServers` → `playerConnected` → `instance.lifecycle(running)` → `answer` → `iceCandidate` → `ping` → `bitrate.policy` | `config` → `offer`（含 playerId） |

补充验证（无头 Edge 加载本页 + 浏览器内 UE 端模拟器，真实 WebRTC/数据通道）：

- 无 `allocation_failed`；`ping` 已回 `pong`；`session.activity` / `session.telemetry` 使服务端回推
  `bitrate.policy`（`lanP2p`，`recommendedLimitMbps=50`，`mode=auto`）。
- 两种协议都完成 ICE（`iceServers: []`，host 候选直连）与数据通道握手，
  引擎端收到控制通道首字节 `[7]`（RequestInitialSettings）与 `[1]`（RequestQualityControl）。
- 改变窗口尺寸后引擎端依次收到 `r.SetRes 1728x1080w`、`r.SetRes 2560x1440w`，随后各跟一条
  `r.ScreenPercentage 100`。
- 引擎端收到的码率命令：
  - unified（UE5.8）：`PixelStreaming2.Encoder.TargetBitrate 50000000`、
    `PixelStreaming2.WebRTC.MinBitrate 100000`、`PixelStreaming2.WebRTC.StartBitrate 1000000`、
    `PixelStreaming2.WebRTC.MaxBitrate 50000000`；
  - legacy（UE5.3）：前缀为 `PixelStreaming.`，且 `Encoder.TargetBitrate -1`（5.3 兼容）。
- 输入通路：`[70]` MouseEnter、`[74]` MouseMove、`[72]/[73]` MouseDown/Up、
  `[60]/[62]/[61]` KeyDown/KeyPress/KeyUp（`KeyA` → 60:65、62:97、61:65）。
