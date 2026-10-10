# 圣效像素流

UE 像素流局域网交付工具 · P1 版本（仅 UE，局域网访问）。

**选择打包好的 UE 主 exe → 一键后台启动信令服务 + UE 实例 → 浏览器（含手机/平板）访问**。

## 交付形态

- **便携版**：`npm run dist` 产出 `release/圣效像素流-便携版-<版本>.exe`，双击即用。
- **安装包**：同一次构建产出 `release/圣效像素流-安装包-<版本>.exe`（NSIS，可自选安装目录、
  建桌面/开始菜单快捷方式、带卸载；卸载保留 `%APPDATA%` 里的项目配置）。
- 两者都内置信令服务、进程代理、Node 运行时、自研播放页；便携版首次运行自动解包到
  `%APPDATA%\圣效像素流\server`（可写，项目配置持久保存）。
- 应用图标在 `build/icon.ico`（与托盘图标同一设计：蓝色圆角方块 + 播放键）。
- 开发模式：`npm start`。

## 功能

- ➕ **添加项目**：选择打包后的 UE 主程序 exe，自动识别引擎类型（UE / Unity / 未知）
- ▶️ **一键启动**：自动拉起内置信令服务 + 进程代理 → 后台预热 UE 实例 → 给出访问地址
- 🔀 **服务器模式**：
  - **内置服务（默认）** — 信令 + 进程代理 + 预热，UE 以
    `-PixelStreamingURL=ws://127.0.0.1:12188/engine/<项目>/<实例>`（或 PS2 的
    `-PixelStreamingConnectionURL=`）接入；播放页 `http://<主机>:12188/shengxiao.html?project=…&token=…`
  - **Epic SignallingWebServer** — 官方方案；**随包内置**（Epic PixelStreamingInfrastructure 的
    SignallingWebServer + 官方播放页 player.html，依赖已随包），传统 `-PixelStreamingIP/-PixelStreamingPort`
    方案（默认 80 / 8888），设置里选「只用官方 SignallingWebServer」即可，无需自备目录
- 📺 **自研播放页**：单文件 HTML（无 jQuery / 无外部 CDN），随窗口自适应、自动请求匹配分辨率保持高清；
  只使用局域网候选，出画面更快
- 🚀 **自动后台启动**：打开程序即自动拉起上次的项目并在后台预热 UE（默认开，可在设置关闭），
  用户打开浏览器时画面已就绪
- 📊 **启动进度条**：信令 → 进程代理 → UE 引擎加载 → 引擎接入，分阶段显示百分比与耗时提示
- 👥 **多端共用一个实例**：会话模式为 `shared`，本机、局域网、手机平板都看同一个 UE 实例
  （默认上限 10 人），不会每来一个人就新起一个实例
- 🧩 **多项目并发**：可同时启动多个项目，每个项目一个独立实例、独立访问地址，可单独启动/停止；
  共用一个信令服务与进程代理（播放页用 URL 的 `project` 参数区分）。
  受显卡显存限制（每个 UE 实例约 4~5.5GB），显存不足时新项目会启动失败并在日志中提示
- 🖥️ **托盘常驻**：推流运行时关闭窗口会最小化到托盘继续推流；托盘菜单可打开主界面/播放页、停止服务、退出
- 🖥️ **后台运行**：默认 `-RenderOffscreen` 无窗口模式（最小化也不停渲），可在设置中关闭
  （**例外：UE 5.8/PS2** —— 见下方「关键实现细节」，改用透明窗口实现"看不见但稳定推流"）
- 📡 **状态面板**：信令服务 / UE 实例 / 推流连接三灯 + 本机与局域网访问地址（一键复制）
- 📋 **运行日志**：信令、UE、工具三通道日志汇聚
- 🛡️ **一键放通防火墙**：设置里点一下即可添加 TCP 12188 与 UDP 49160-49259 入站规则（局域网连不上的首选排查项）
- ⚙️ **设置**：服务器模式、内置服务目录、Epic 信令目录、端口、局域网模式、附加启动参数

## 运行

```powershell
# 开发模式（构建 + 启动）
npm start

# 打包成单文件 exe
npm run dist
```

> 在 DSH 会话内启动需先清除 `ELECTRON_RUN_AS_NODE`（宿主是 Electron 应用会注入该变量，导致应用以纯 Node 模式启动而崩溃）。若当前环境 Chromium 沙箱初始化失败，可临时加 `--no-sandbox`。

## 服务器探测顺序

**PeerStream 模式**（默认优先）：

1. 设置中指定的 PeerStream 目录（管理器根目录或 `PeerStreamSource` 均可）
2. 常见安装位置（如 `D:\...\UEPixelStreamingManager-*\PeerStreamSource`）

**Epic 模式**（回退）：

1. 设置中手动指定的目录
2. 随包内置的官方 SignallingWebServer（`resources/official/SignallingWebServer`，含官方播放页）
3. `<exe目录>\Engine\Plugins\Media\PixelStreaming\Resources\WebServers\SignallingWebServer`
4. `<exe目录>\SignallingWebServer`

## 关键实现细节

- **多项目并发**：信令服务与进程代理是共享的单例，项目实例各自独立。信令服务启动时只读一次
  `signal.json`，因此服务端增加了**项目列表热重载**（`refreshProjectsConfig`，每 2 秒轮询）——
  启动器在服务运行期间新增/关闭项目时会自动加载并预热新项目，无需重启服务（重启会打断在跑的项目）。
- **UE 5.8/PS2 的收窗方式是"透明化"**（重要）：启动成功后把 UE 窗口设为
  `WS_EX_LAYERED + alpha=0`（并移出任务栏/Alt+Tab）——桌面上完全看不见，但窗口仍在显示器上
  被 DWM 合成，推流稳定。**不能**用 SW_HIDE / 最小化 / 移出屏幕：实测引擎都会在 2.5~4 分钟内
  `engine_disconnected`，预热实例被反复销毁（表现为"用几分钟就没画面"）。
  `-RenderOffScreen` 也不可用：经引导程序启动直接退出码 3；直启 Shipping 虽能运行但推流器
  不初始化（无画面或退出码 3）。5.3 及经典插件（PixelStreaming）不受影响，照常延时藏窗。
  健康检查每 ~16 秒幂等重放一次透明化，覆盖实例热重启后新窗口短暂可见的情况。
- **`-RenderOffScreen` 对 5.8/PS2 会直接导致启动失败（退出码 3）**：项目登记时自动移除该参数、
  补全参数时跳过；process-manager 启动期还会再剥离一次兜底。5.3/经典插件则需要它做无头推流。
- 信令 URL 参数按插件版本选择（对齐官方 `applySignallingUrlArgument`）：
  - PixelStreaming2 + UE 5.8+ → `-PixelStreaming2.ConnectionURL=` + `-PixelStreamingConnectionURL=`（查询串 `?token=`，自动开流）
  - PixelStreaming2 + UE 5.5 → `-PixelStreamingSignallingURL=`
  - PixelStreaming2 + UE 5.6/5.7 → `-PixelStreamingConnectionURL=`（路径 `/token=`）
  - 传统 PixelStreaming → `-PixelStreamingURL=`
- UE 启动参数沿用 `signal.json` 中该项目的登记项（含 `-PixelStreamingWebRTCMinPort/MaxPort=49160/49259` 等，局域网连通的必要项）
- **按包内信息自动识别插件与引擎版本**（决定参数名，写错就连不上信令）：
  - 优先读上级目录的 `<项目>.uproject`（`EngineAssociation` + `Plugins`）
  - 兜底看打包内 `Samples\PixelStreaming2` / `Samples\PixelStreaming`
  - 识别结果会写回 `signal.json` 并打印「配置校正」日志
- 项目未登记时自动写入 `signal.json` 与 `execue.json`（白名单），沿用模板参数替换 exe
- **预热独占**：只让当前启动的项目 `preload=true`，其它项目自动置 false —— 避免坏项目在后台反复失败，也避免多实例抢显存（`gpu_capacity_insufficient`）
- **UE 启动失败快速失败**：连续 2 次 `ue_start_failed` 立即中止并给出退出码，不再无意义重试拉起进程；只统计当前项目的失败，不被其它项目干扰
- **保持预热**：会话策略自动设为 `shared` + `lastPlayerExitPolicy=idle` + 空闲窗口 30 分钟，
  所有观看者共用一个实例，最后一人离开后实例不销毁，重新打开页面秒连
- 信令服务优先用管理器自带 `runtime\node.exe`，否则用 Electron 内置 Node（`ELECTRON_RUN_AS_NODE`），用户无需另装 Node
- 端口 80 若被占用（如 phpStudy/Apache）不影响 PeerStream 模式，其默认端口为 12188

## 排查备忘

打包产物本身起不来时的表现：进程 1~3 秒内退出、不写任何日志（例如退出码 `777006`）。
此时**先手动双击 exe 确认能出窗口**再用启动器 —— 启动器只负责编排，不能修复坏包。
注意 `Windows\` 下的 `<项目>.exe` 是 UE 的 `BootstrapPackagedGame` 引导程序，真正的游戏体在
`<项目>\Binaries\Win64\`。

信令服务报 `ERR_MODULE_NOT_FOUND: Cannot find package 'ws'`：`%APPDATA%\圣效像素流\server\node_modules`
缺失（随包只带 `ws` 一个依赖）。从管理器目录
`<UEPixelStreamingManager>\PeerStreamSource\node_modules` 复制 `ws` 过去即可。
「清除缓存」只清 `config`/`logs`，不会删 `node_modules`；副本重建时若缺依赖会自动从随包副本补。

## 技术栈

Electron 33 + TypeScript 5.6 + esbuild。无框架，渲染层为原生 DOM。

- `src/shared/types.ts` — 全进程共享类型（Project / Settings / Status / Api）
- `src/main/` — 主进程：`store`（JSON 持久化）、`detect`（引擎/服务器探测）、`orchestrator`（编排与健康检查）、`index`（窗口与 IPC）
- `src/preload/` — contextBridge 暴露受控 API
- `src/renderer/` — UI（侧栏项目列表 + 状态卡片 + 日志 + 设置弹窗）

## P2 规划

- Unity 接入（复用官方 Render Streaming webapp，双信令路由）
- JWT 分享链接（有效期 / 人数 / 只读）+ 单控制权申请
- 播放页诊断面板、手机适配、二维码
- 公网：SSH/frp 隧道 + TURN 兜底
