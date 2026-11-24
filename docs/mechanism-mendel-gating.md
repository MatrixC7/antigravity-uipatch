# 技术报告：Mendel 实验开关门控机制与本地注入路径实测取证

> **取证对象**：Antigravity 桌面端应用 `2.31.0-1`（Electron `44.9.1`，`language_server` `Built at CL: 1017595969`，Linux x86-64；线上 OAuth 实验表基线首次采集自 `2.29.1-1` / `CL 1015941558` 并在 `2.31.0-1` 逐键复核；三轨门控架构与 Electron Fuse 结论在 `2.35.0-1` / `CL 1028447422` 下复核依然成立）。
> **测试环境**：企业网关模式（`~/.gemini/config/config.json` 配置 `gateway.enabled: true`，`wireProtocol: "openai"`）、隔离 Google OAuth 原生账号沙盒实例与独立回环实例（`--standalone --gemini_dir <isolated>`）。
> **通俗导读**：如需快速了解结论与日常用法，请参阅 [《原理与使用指南》](overview-and-guide.md)。

---

## 1. 核心取证结论

1. **企业网关模式下 `Extensions` 与 `Terminal` 等 40 余项功能消失并非后端功能残缺，而是 `GetMendelFlags` 返回空对象触发了前端默认隐藏门控。**
   实测企业网关模式下，`GetServerConfiguration` 正常返回 `{"config":{"sidecars":{"enabled":true},...}}`，`GetAllPlugins` 正常加载全局与工作区插件，Sidecar Node.js 进程亦正常监听本地回环端口；唯独 `GetMendelFlags` 返回 `{"experimentConfig":{},"webrtcMeshReady":false}`，而 Google OAuth 原生账号线上实测快照返回 **384 项**实验配置（其中含 41 项前端开启的布尔开关与 7 项开启的字符串载荷参数，在 `2.31.0-1` `main.js` 中仍 100% 完整引用）。
2. **后端实验状态缓存（`MendelStateCache`）受服务端硬权限门禁保护，所有免修补的本地 RPC / 环境变量注入路径均被阻断或静默覆盖。**
   `SetMendelFlagOverrides` 在非开发模式下直接返回 `permission_denied: Mendel flag overrides require developer mode`；`SetBaseExperiments`、`UpdateDevExperiments`、`UpdateEnterpriseExperimentsFromUrl` 虽返回 HTTP 200 `{}`，但均无法令 `GetMendelFlags` 输出非空实验项，亦无法开启只读配置字段 `LanguageServerConfig.dev_mode`。
3. **直读 Mendel 通道与本地持久化存储在公开构建下处于断路状态。**
   宿主以 `--https_server_port 0` 在随机回环端口提供 UI。`2.31` 起前端虽引入 `clientStorageFeature`（经 Electron `window.nativeStorage` 读写 `~/.config/Antigravity/app_storage.json`）持久化 `FeatureManagerV2` 的 `customFlag`，但直读与次级 Mendel 布尔通道仍依赖被拒绝的 `SetMendelFlagOverrides` RPC，必须将 `storageService` 与直读读取器桥接才能实现全通道覆盖。
4. **`language_server` 原生提供 `-web_bundle_path` 静态资源覆盖接口，且 Electron 宿主二进制未启用嵌入式 ASAR 完整性校验 Fuse。**
   结合 `dist/languageServer.js` 的 5 行惰性环境变量钩子与外置 Web UI 五处结构化前端汇聚点修补，可在**零改动 `language_server` 二进制**的前提下完整对齐原生基线、打通双向实时覆盖、恢复增强型上下文推理遥测面板并实现跨重启/重装持久化。

---

## 2. 三轨前端门控链路与持久化机制逆向分析

对 `agy_hub_web_bundle` 中的 `main.js`（`2.31.0-1` 为 `11,871,831` 字节）、`app.asar` 中的 `dist/preload.js` 以及 `language_server` Protobuf / Go 符号表进行静态与动态联合分析，可完整还原实验开关从后端拉取到前端渲染的三条数据轨道（括号内为 `2.31.0-1` 编译符号）：

```text
language_server (Go, --https_server_port 0 -> https://127.0.0.1:<随机端口>)
  └─ (*Server).GetMendelFlags ──► Connect RPC: /exa.language_server_pb.LanguageServerService/GetMendelFlags
                                        │
                                        ▼ 返回 ExperimentConfig.experiments[]
                         （网关模式返回空 []；Google OAuth 原生账号下发 384 项）
                                        │
        ┌───────────────────────────────┴───────────────────────────────────────┐
        ▼ 主入口 Ola(a) -> MendelExperimentProvider (class Tla)                 ▼ 次级包装器 Qt().getMendelFlags
   stateProvider (内存字典: keyString -> ExperimentWithVariant)             NMb(flag) 本地缓存查询
        │                                                                       │
        ├──► 轨道 A：直读响应式 / 同步接口                                      └──► 轨道 C：次级 RPC Hooks
        │      • Ii(b, flag) / CKc(flag): Sidecar 菜单、音频转写、Automations        • IT(flag)       : 生成式 UI、Browser Subagent v2
        │      • Hi(b, flag)            : 右侧栏 V2 早期同步检查、草稿持久化          • JT(flag, def)  : 附件上限、Best-of-N 分支上限
        │      • Ji(flag)               : 公告横幅、插件市场免责声明 JSON
        │
        └──► 轨道 B：全局特性管理器 FeatureManagerV2（共 107 项 customFlag）
               • Sla(Fi()) 提取 disabled === false 的布尔键构造默认基线 v (enabledByDefault)
               • mna(v, n) 合并本地覆盖表 n (storageService["jetski.developer.customFlagOverrides"])
               • Vla(rule, runtimeEnv) 判定 runtimeGating.customFlag：
                   ├─ "enable-jetbox-terminal-v2" -> terminalFeature ("New Terminal")
                   ├─ "enable-aux-pane-redesign"  -> sidePanelV2 多标签右侧栏
                   ├─ "enable-file-explorer-tab"  -> 经典栏独立 File Explorer 图标
                   └─ "enable-developer-mode"     -> Settings -> Developer 面板
```

### 2.1 Google OAuth 原生账号 vs. 企业网关模式线上实测对比

在隔离目录（仅保留 OAuth 登录凭据、排除本地网关配置干扰）拉取真实 `GetMendelFlags` 线上响应快照（采集自 `2.29.1-1` / `CL 1015941558`，并在 `2.31.0-1` 中验证全部启用键仍完整命中）并与 `main.js` 静态常量交叉比对，得出精确分布（注：云端灰度可能随账号、地区或时段演进）：

| 统计维度 | 企业网关模式（未修补） | Google OAuth 原生账号（实测快照） | 对前端界面的直接影响 |
|---|---:|---:|---|
| 服务端下发实验总条目数 | `0`（`{}`） | `384` | 网关模式下所有缺省关闭的门控全部落入回退分支 |
| 初始快照命中前端常量的实验键 | `0` | `109` | 其余 275 项为服务端内部或非桌面端实验键 |
| 其中启用态（`disabled: false`）前端布尔键 | `0` | **`41`**（`31` 项 `customFlag` + `10` 项直读布尔） | 控制 `Extensions`、`Terminal`、多标签右侧栏、Git Diff、PDF/Notebook、分屏、搜索等核心功能 |
| 其中启用态字符串/数值载荷键 | `0` | **`7`**（另含 `1` 项复杂枚举） | 控制媒体附件上限（`"15"`）、Best-of-N 上限（`"10"`）、免责声明文案等 |
| 其中显式禁用态（`disabled: true`）前端键 | `0` | **`60`**（含 `enable-developer-mode`、`enable-file-explorer-tab` 等） | 原生账号同样默认隐藏 `Developer` 页与部分实验特性 |

由此可见：**在主入口（`Ola()`）与次级入口（`Qt().getMendelFlags`）共用 `__agyResolveExperiments()` 与 `__agyNormalizeMendel()`——当服务端返回空数组 `[]` 时清空旧缓存并回退注入上述 `41` 项原生开启布尔开关 + `7` 项字符串载荷 + `enable-developer-mode` 与 `enable-context-usage-indicator`；当服务端返回非空列表时完整保留线上表并仅确保上述两项解锁开关开启；当拉取抛错时保留上一次成功的实时表（last-known-good）**，即可使网关模式在 `0 overrides` 初始状态下与 Google 原生账号基线对齐。

### 2.2 为什么原版前端在公开构建下无法覆盖轨道 A / C

原版前端 `Developer` 面板（`GGb()` 组件）通过 `jj("jetski.developer.customFlagOverrides", ...)` 将开关覆盖表写入 `clientStorageFeature`（底层经 `dist/preload.js` 暴露的 `window.nativeStorage` 落盘至 **`~/.config/Antigravity/app_storage.json`**），但仍存在两处链路缺口：

1. **轨道 A / C 覆盖断路**：
   - 轨道 B（`mna(v, n)`）在前端本地合并基线 `v` 与 `storageService` 覆盖表 `n`，因此对常规 `customFlag` 立即生效；
   - 但轨道 A（`Ii` / `CKc` / `Hi`）与轨道 C（`IT`）直接读取实验对象的 `!d.disabled`，原版依赖 `Tla.flagOverrideSync` 调用后端 `SetMendelFlagOverrides` RPC 来更新内存字典。由于公开构建中 `dev_mode == false`，该 RPC 恒定返回 `permission_denied`，导致用户在面板中拨动 `enable-ui-sidecars` 或 `enable-browser-subagent-v2` 时轨道 A/C 无法响应。
   - **修补方式**：在不篡改 `stateProvider` 原始基线（保证 `enabledByDefault` 与 `Reset overrides` 语义准确）的前提下，为 `Hi`、`Ii` 与 `IT` 接入纯前端覆盖查询 `__agyOvr()`；在 `Tla` 构造时通过 `__agyRegisterNotifier()` 注册状态刷新订阅者（于 `dispose()` 自动注销）并包装 `flagOverrideSync.set()`，使每次本地覆盖更新立即通知全体响应式订阅者重绘（完全解耦 `Mla` RPC 队列）。
2. **启动早期时序对齐**：
   - 由于 `Gi = new Tla(v.lsClient)` 的启动略早于 `getAppVariant()` 初始化 `hhd()`（`clientStorageFeature`），若 `Ola()` 先返回而尚未加载磁盘覆盖，早期同步/响应式订阅会短暂读到未覆盖基线。
   - **修补方式**：在 `Ola()` 返回前先 `await __agyHydrateDevStorage()` 从 `window.nativeStorage.getItems()` 预热覆盖字典，随后在 `hhd()` 完成初始化时通过 `__agyBindStorage()` 无缝接管 `storageService` 的同步缓存与 `onDidChange` 监听流。

---

## 3. 八条候选技术路径的实测取证记录

在确定最终方案前，我们在真实环境与隔离沙盒实例上逐一实测了 8 条潜在路径，完整取证结果如下：

| 编号 | 候选路径 | 实测命令 / 操作 | 实测返回结果 | 结论与根因 |
|---:|---|---|---|---|
| **1** | 修复桌面启动器错误代理语法后复查 | 修正 `.desktop` 中多余分号与缺失 scheme 的代理赋值（示例端口记作 `<proxy-port>`）并补充 `no_proxy`，重启后调用 `GetMendelFlags` | `{"experimentConfig":{},"webrtcMeshReady":false}` | **排除**：空表并非代理报错所致，而是网关模式无 Google OAuth 凭据拉取 Mendel。 |
| **2** | 直接调用 `SetMendelFlagOverrides` RPC | `POST .../SetMendelFlagOverrides` `{"overrides":{"enable-ui-sidecars":true}}` | `{"code":"permission_denied","message":"permission_denied: Mendel flag overrides require developer mode"}` | **阻断**：服务端校验内部 `dev_mode` 标志，普通运行态硬性拒绝。 |
| **3** | 调用 `SetBaseExperiments` 注入实验项或 `devMode` | `POST .../SetBaseExperiments` `{"experimentConfig":{"devMode":true,"experiments":[...]}}` | 返回 `{}`，但随后 `GetMendelFlags` 仍为 `{}`，`GetServerConfiguration.dev_mode` 仍为空 | **无效**：Base 层被空 Mendel 状态覆盖，且 `dev_mode` 无法经由该 RPC 翻转为真。 |
| **4** | 调用 `UpdateDevExperiments` RPC | `POST .../UpdateDevExperiments` `{"experimentConfig":{"devMode":true}}` | 返回 `{}`，`GetMendelFlags` 与 `SetMendelFlagOverrides` 状态未变 | **无效**：非开发构建下该接口不激活 `dev_mode`。 |
| **5** | 调用 `UpdateEnterpriseExperimentsFromUrl` 从本地 HTTP 服务拉取 | 本地起 HTTP 服务返回 `{"experiments":[...]}`，调用该 RPC 指向 `http://127.0.0.1:8899/experiments.json` | 返回 `{}`，`GetMendelFlags` 仍为 `{}` | **无效**：需企业门户签名/会话上下文配合，裸网关模式不采纳。 |
| **6** | 猜测环境变量或默认目录透传 Web UI | 测试 `ANTIGRAVITY_WEB_BUNDLE_PATH`、`WEB_BUNDLE_PATH` 及 `~/.gemini/config/webui`、`web_bundle`；以及测试命令行参数 `--is_google_internal`、`--use_mocked_data`、`--jetbox_release_channel=insiders` | 环境变量与默认目录均未改变返回的 `main.js`；各命令行标志下 `devMode` 仍为 `false` | **无效**：`language_server` 仅认命令行标志 `-web_bundle_path`，无环境变量回退。 |
| **7** | 通过 `NODE_OPTIONS=--require=...` 注入 Electron 主进程 | `NODE_OPTIONS=--require=/tmp/hook.cjs /opt/Antigravity/antigravity` | 报错 `Most NODE_OPTIONs are not supported in packaged apps` | **阻断**：Chromium / Electron 打包态限制了危险 `NODE_OPTIONS` 预加载参数。 |
| **8** | **`app.asar` 惰性环境变量钩子 + `language_server --web_bundle_path`** | 在 `dist/languageServer.js` 按 `AGY_UI_BUNDLE` 条件追加 `--web_bundle_path`，隔离实例拉起验证 | `GET /main.js` 返回 `HTTP 200` 且精确匹配外置修补文件 SHA256；GUI 正常渲染原生基线特性与 `Developer` 面板，且 `app_storage.json` 跨端口持久化生效 | **验证通过（最终采用）**。 |

---

## 4. Electron Fuses 二进制状态实测表

直接解析 `/opt/Antigravity/antigravity`（`2.31.0-1` 为 `228,826,440` 字节）偏移 `37,183,328` 处的官方 Fuse Wire 哨兵（`dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX`，版本 `1`，长度 `9`）：

| Fuse 索引 | Electron Fuse 名称 | 实测字节值 | 生效状态 | 对本工具的意义 |
|---:|---|---:|---|---|
| 0 | `RunAsNode` | `'1'` | **ENABLED** | 允许子进程以 Node 模式运行 Sidecar（`sidecar_sdk` 依赖此特性） |
| 1 | `EnableCookieEncryption` | `'0'` | DISABLED | — |
| 2 | `EnableNodeOptionsEnvironmentVariable` | `'1'` | ENABLED | 仅允许受限白名单选项，禁止 `--require`（见路径 7） |
| 3 | `EnableNodeCliInspectArguments` | `'1'` | ENABLED | — |
| 4 | **`EnableEmbeddedAsarIntegrityValidation`** | **`'0'`** | **DISABLED** | **未启用嵌入式 ASAR 整体哈希锁死**，重打包 `app.asar` 不会触发宿主拒载 |
| 5 | **`OnlyLoadAppFromAsar`** | **`'0'`** | **DISABLED** | 未锁死仅从原始 ASAR 加载 |
| 6 | `LoadBrowserProcessSpecificV8Snapshot` | `'0'` | DISABLED | 主进程直接加载 `app.asar` 中的 JS，不走固化快照 |
| 7 | `GrantFileProtocolExtraPrivileges` | `'1'` | ENABLED | — |
| 8 | `WasmTrapHandlers` | `'1'` | ENABLED | WebAssembly 陷阱处理器（与本工具无关） |


> Fuse 位名称依据 Electron 官方 `fuses` 仓库 `src/config.ts` 中的 `FuseV1Options` 枚举顺序；仅索引 0 / 4 / 5 对本工具有实际意义。
