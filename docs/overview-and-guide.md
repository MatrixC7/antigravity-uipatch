# 原理与使用指南：Antigravity 桌面端实验开关门控机制与解锁方案

> 本文档面向希望快速理解 Antigravity 桌面端在“企业网关模式”与“Google 原生账号模式”下部分前端界面（`Extensions` 插件菜单、内置 `Terminal`、多标签右侧栏、原生 `File Explorer` 标签页、`Settings -> Developer` 面板）被隐藏的真实原因、三层解耦补丁的工作方式、跨随机端口持久化机制以及日常升级维护流程的用户与开发者。底层协议验证、字节级补丁对比与完整开关清单请参阅配套技术文档：
> - [《补丁架构与脚本实现详解》（`patch-internals.md`）](patch-internals.md)
> - [《技术报告：Mendel 实验开关门控机制与本地注入路径实测取证》（`mechanism-mendel-gating.md`）](mechanism-mendel-gating.md)
> - [《技术参考：Antigravity 桌面端实验特性开关全景目录》（`custom-flags-catalog.md`）](custom-flags-catalog.md)

---

## 1. 核心机制问答

### 1.1 为什么切到“企业网关模式”后，右上角 `+` 菜单里的 `Extensions` 和 `New Terminal` 会同时消失？

**因为后端插件与终端服务本身正常就绪，但前端渲染层被空的 Mendel 云端实验开关表拦截了。**

Antigravity 桌面端并非单一进程，而是由职责分离的**三层结构**组成：

```text
┌─────────────────────────────────────────────────────────────────────────┐
│ 第 1 层：Electron 宿主外壳（/opt/Antigravity/antigravity + app.asar）    │
│   • 负责创建系统窗口、暴露 nativeStorage 桥接、拉起第 2 层本地引擎子进程 │
└───────────────────────────────────┬─────────────────────────────────────┘
                                    │ spawn language_server（参数数组硬编码）
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 第 2 层：Go 本地编排与推理引擎（resources/bin/language_server）          │
│   • 负责 Agent 推理、MCP / Sidecar 生命周期、终端后端与 Mendel 同步      │
│   • 每次启动在 127.0.0.1:<随机端口> 提供本地 HTTPS 服务，下发第 3 层 UI  │
└───────────────────────────────────┬─────────────────────────────────────┘
                                    │ HTTPS 提供前端资源（默认取自内嵌 ZIP）
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 第 3 层：React 前端界面（agy_hub_web_bundle，548 个条目（540 文件 + 8 目录），核心 main.js） │
│   • 负责全部界面渲染，并根据实验开关决定每个菜单、面板与标签页是否挂载   │
└─────────────────────────────────────────────────────────────────────────┘
```

在企业网关模式（`~/.gemini/config/config.json` 中启用 `gateway.enabled: true`，不经过 Google OAuth 登录链路）下，实测向第 2 层发起本地 RPC 检查可见：

1. **后端能力完全正常**：`GetServerConfiguration` 返回 `"sidecars": { "enabled": true }`，`GetAllPlugins` 也能正常发现并拉起本地 Sidecar 后台进程。
2. **云端实验表为空**：`GetMendelFlags` 返回 `{"experimentConfig":{},"webrtcMeshReady":false}`。
3. **前端门控默认闭合**：第 3 层 `main.js` 中的 `Extensions` 子菜单依赖布尔实验开关 `enable-ui-sidecars` 与 `enable-sidecars`（缺省均为 `false`），内置终端入口依赖 `customFlag: "enable-jetbox-terminal-v2"`（缺省为 `null`），多标签右侧栏依赖 `enable-aux-pane-redesign`。因此，尽管后端服务已在运行，40 余项受实验门控的前端功能仍被连带隐藏。

---

### 1.2 为什么即使使用 Google 原生账号登录（或应用本工具默认基线），右侧栏顶部默认也不是经典的常驻四图标栏？

**由两项线上 Mendel 实测事实叠加决定：一是 Google 原生账号默认开启了 `enable-aux-pane-redesign`（新版多标签右侧栏）；二是独立文件树图标 `enable-file-explorer-tab` 在线上处于关闭状态。**

在隔离环境拉取 Google 原生账号的线上 `GetMendelFlags`（共下发 384 项实验配置，完整逐项状态见 [《实验特性开关全景目录》](custom-flags-catalog.md)）并与 `main.js` 比对可见：

1. **`enable-aux-pane-redesign` 与 `enable-jetbox-terminal-v2` 线上状态均为 `ON`**：
   - 当 **`enable-aux-pane-redesign` 开启**时（Google 原生账号与本工具的开箱默认形态），右侧栏运行在新版 `sidePanelV2` 多标签页架构，由右上角 `+` 下拉菜单（`Open File` / `New Terminal` / `Browser` / `Extensions`）与 `Overview` 总览面板（其 `Files` 行自带工作区侧边文件树）承载交互。
2. **`enable-file-explorer-tab` 线上状态为 `OFF`（`disabled: true`）**：
   - 当你在 `Settings -> Developer -> Custom Flags` 中手动将 **`enable-aux-pane-redesign` 拨为关闭**，并添加 **`enable-file-explorer-tab`** 后，右侧栏即切回经典的 `sidePanel` 架构，顶部直接常驻显示四个固定小图标（`Overview` / `File Explorer` / `Review` / `Terminal`）。

应用本工具后，你可以在 `Settings -> Developer` 中随时自由切换这两种布局形态。

---

### 1.3 为什么不修改 `language_server` 二进制，而是采用“`app.asar` 惰性钩子 + 外置 Web UI”方案？

1. **后端 RPC 注入均被服务端权限门禁拦截**：实测 `SetMendelFlagOverrides` 在非开发模式下直接返回 `permission_denied: Mendel flag overrides require developer mode`；`SetBaseExperiments`、`UpdateDevExperiments`、`UpdateEnterpriseExperimentsFromUrl` 虽返回 `{}`，但在空 Mendel 表下均不生效（详见 [《Mendel 门控取证报告》](mechanism-mendel-gating.md)）。
2. **与 `antigravity-context-unlock` 零冲突共存**：`language_server` 二进制往往已由 [`antigravity-context-unlock`](https://github.com/MatrixC7/antigravity-context-unlock) 打入上下文解锁补丁并维护 `.ctxunlock-backup` 哈希配对。本工具**完全不修改 `language_server` 二进制的任何一个字节**，两套工具职责正交、互不干扰。
3. **直接复用官方原生参数 `--web_bundle_path`**：`language_server` 原生提供 `-web_bundle_path` 命令行标志，用于优先加载外部目录中的前端静态资源。唯一阻碍是 Electron 宿主（`app.asar` 内的 `dist/languageServer.js`）硬编码了子进程启动参数数组。为此，本工具仅在 `dist/languageServer.js` 末尾注入一段 **5 行惰性钩子**：仅当检测到环境变量 `AGY_UI_BUNDLE` 时才追加 `--web_bundle_path`；未设置该环境变量时，启动参数与原厂构建 100% 一致。

---

### 1.4 本工具的默认开关策略是什么？为什么不把 90 多个开关全开，而是对齐 Google 原生账号基线？

**采用“Google 原生账号 1:1 线上基线 + 额外解锁 `enable-developer-mode` 可视化面板”策略：既开箱即享完整原生功能，又不误触内部危险开关，还能在面板上双向微调。**

`main.js` 中包含大量仅适用于 Google 内部环境（CitC / Cider / ABFS）或裁剪界面的开关（如 `project-4k` 会隐藏开发者工具），绝不能盲目全开。本工具采取最稳健的分层设计：

1. **企业网关模式（`GetMendelFlags` 为空 `{}`）**：主通道与次级通道经共享解析器 `__agyResolveExperiments()` 识别出服务端空表，清空旧缓存并自动回退注入实测观测到的 **Google 原生账号线上开启基线**（41 项前端布尔开关 + 7 项参数配置，涵盖 `New Terminal`、V2 多标签右侧栏、`Extensions`、Git Diff 审查、PDF / Notebook 预览、分屏、全文搜索、快捷键自定义等）以及 **`enable-developer-mode` 与 `enable-context-usage-indicator`**；
2. **Google 原生账号模式（`GetMendelFlags` 非空）**：原样保留云端实时下发的完整实验表（实测快照共 384 项），仅额外确保 `enable-developer-mode` 与 `enable-context-usage-indicator` 开启；若运行期间偶遇单次网络抖动导致拉取抛错，两条通道均自动保留上一次成功的实时表（last-known-good）；
3. **双向覆盖与实时响应**：在 `Settings -> Developer -> Custom Flags` 面板中，所有原生基线开启项初始均为默认开启态（`0 overrides`）。你可以随时手动**关掉**某项默认开关（标记 `forced off`，直读布尔通道同样实时生效），或通过底部向上展开的可滚动下拉框**添加**额外实验项（标记 `forced on`），点击 `Reset overrides` 即可随时一键回到纯净的 Google 原生基线。

---

### 1.5 为什么手动拨动实验开关时，本工具能让全部通道实时生效并跨随机端口与重装持久保留？

**因为 `language_server` 每次启动使用随机回环端口（`--https_server_port 0`），且服务端拒绝 `SetMendelFlagOverrides`；本工具将直读与次级 Mendel 通道统一绑定到了底层读写 `~/.config/Antigravity/app_storage.json` 的原生存储服务上。**

- **原版两处断点**：
  1. Electron 主进程拉起 `language_server` 时传入 `--https_server_port 0`，每次随机分配新端口（如 `https://127.0.0.1:41823` → `https://127.0.0.1:35910`），使同源 `window.localStorage` 每次重启清空。`2.31` 起上游虽引入 `clientStorageFeature`（底层调用 `window.nativeStorage` 读写 `~/.config/Antigravity/app_storage.json`）保存常规 `customFlag`，但直读与次级通道仍未打通；
  2. `Extensions` 菜单（`enable-ui-sidecars`）、浏览器子代理（`enable-browser-subagent-v2`）等 20 余项直读开关在原版中依赖后端 `SetMendelFlagOverrides` RPC 更新状态，而在公开构建下固定返回 `permission_denied`。
- **本工具全通道闭环**：在 `Ola()` 拉取实验表前先通过 `__agyHydrateDevStorage()` 从 `window.nativeStorage` 预热磁盘覆盖表，随后通过跳板绑定 `clientStorageFeature`（`hhd()`）的 `storageService` 与 `flagOverrideSync`，使 `~/.config/Antigravity/app_storage.json`（Pacman 升级或重装 `/opt/Antigravity` 绝不会触碰该目录）中的覆盖项同时作用于全部三条数据轨道。
- **关键工程加固（对用户可见的实际差异）**：
  1. **连续拨动与重置即时生效**：每次本地覆盖更新直接通过 `__agyRegisterNotifier()` 同步广播刷新，与后端 RPC 队列完全解耦，连续快速拨动开关或点击 `Reset overrides` 均零延迟响应；
  2. **零竞争复用宿主原生落盘队列**：直接挂载上游 `fgd(window.nativeStorage)` 的缓存与 `onDidChange` 事件流，不引入第二个竞争写进程；
  3. **读取失败与晚挂载桥接可重试**：预热读取带 `2000ms` 超时保护与 `8000ms` 桥接就绪宽限期，临时异常不会永久缓存，后续拉取可自动恢复；
  4. **区分网络抖动与空表切换**：已获取 Google OAuth 实时实验表后，网络异常保留 last-known-good；而服务端明确返回空表（如切回网关模式）则立即清空旧缓存并启用静态基线。

---

## 2. 全景横向对比：未修补各模式 vs. 应用 `antigravity-uipatch` 后

| 对比维度 | 原版：企业网关模式 | 原版：Google OAuth 个人账号 | 应用 `antigravity-uipatch` 后（任意模式） |
|---|---|---|---|
| **默认生效的实验开关集** | 空表 `{}`（40 余项原生功能连带关闭） | 云端按账号下发基线（不含 `Developer` 页） | **网关/离线时对齐实测原生基线 + 开启 `Developer` 页；OAuth 登录时保留线上表 + 开启 `Developer` 页** |
| **`Extensions` 与内置 `Terminal`** | 隐藏 | 默认可见（位于 `+` 菜单与 V2 右侧栏） | **开箱默认可见** |
| **`Settings -> Developer` 面板** | 隐藏 | 隐藏 | **默认可见**（支持对任意开关做双向增减与一键重置） |
| **未灰度实验项（如 `fileExplorerTab`）** | 隐藏 | 隐藏 | **可在 `Developer` 面板按需添加** |
| **手动修改开关的作用范围与持久化** | — | 面板隐藏；直读开关因 `SetMendelFlagOverrides` 权限拒绝无法本地覆盖 | **全通道实时响应覆盖，保存于 `~/.config/Antigravity/app_storage.json`，重启与重装均保留** |
| **网络抖动时的实验表** | — | 原版主入口在失败时返回 `undefined`，下游保留已加载的表 | **主/次双通道在请求失败时均保留 last-known-good；服务端成功返回空表时清空旧缓存并采用静态基线** |
| **上下文容量与推理遥测指示器** | `2.30+` 外部包已剥离为 `void 0` | `2.30+` 外部包已剥离为 `void 0` | **开箱默认挂载洁净室增强版（展示 `TokenType` 细分、真实响应模型、`TPS`/`Pin t/s`、`TTFT`、`Cache hit`、`Duration`、`Output`/`Thinking` 与重试角标）** |
| **开关候选框滚动体验** | — | 原生 `<datalist>` 弹窗白底且**无法滚动** | **深色主题向上展开，支持滚轮 / 键盘导航 / 自动滚动入视区，含 ARIA listbox 语义** |
| **误删/误覆盖防护** | — | — | **`--dry-run` 绝对零写入；`extract` 拒绝非空目录；UI 切换双失败时保留旧副本并给出恢复路径** |
| **是否修改 `language_server` 二进制** | 否 | 否 | **否**（纯内存只读提取内嵌 ZIP） |
| **临时回退原厂 UI 成本** | — | — | 执行 `disable` 移除桌面启动器环境变量即可（`verify` 识别主动 `OFF` 状态并返回 `0`） |

---

## 3. 常见注意事项与边界说明

1. **务必从系统应用菜单（桌面启动器）启动 Antigravity**：
   - `AGY_UI_BUNDLE` 环境变量写入在 `~/.local/share/applications/antigravity.desktop` 的 `Exec=` 行中。若直接在终端裸敲 `antigravity` 命令且当前 shell 未导出 `AGY_UI_BUNDLE`，由于 `app.asar` 钩子处于惰性状态，应用会按原厂内置 UI 启动（这也是紧急排查时免卸载回退原厂 UI 的快捷方式）。
2. **KDE Plasma 桌面缓存（`ksycoca6`）机制**：
   - KDE 启动器通过二进制服务缓存索引 `.desktop` 文件。手动编辑 `.desktop` 后若未刷新缓存，短时间内从菜单启动仍可能读取旧环境变量。本工具的 `install`、`sync`、`disable`、`restore` 均会自动调用 `kbuildsycoca6 --noincremental` 与 `update-desktop-database` 完成刷新。
3. **切勿在未执行 `disable` 的情况下直接删除 `~/.local/share/antigravity-uipatch` 目录**：
   - `language_server` 的 `--web_bundle_path` 参数在目标目录不存在时不会回退至内嵌 ZIP，而是直接返回 `HTTP 500`（表现为空白窗口）。如需清理外置 UI 目录，请先运行 `node antigravity_uipatch.mjs disable`（或 `restore`）。
4. **软件包升级后请同步更新外置 UI（推荐配置 Pacman Hook）**：
   - 当系统更新 `antigravity` 软件包时，`app.asar` 与 `language_server` 会同时更新。运行 `sync`（或配置本仓库提供的 `pacman/99-antigravity-uipatch.hook`）会自动从**新版** `language_server` 重新提取并修补前端代码，避免出现“旧版外置前端搭配新版后端 API”的版本错位，同时完整保留你在 `app_storage.json` 中的自定义开关配置。
5. **误开危险开关后的离线应急恢复**：
   - 若不慎手动开启了 `project-4k` 等裁剪皮肤导致设置入口不可见，只需关闭客户端，编辑 `~/.config/Antigravity/app_storage.json` 删除其中的 `"jetski.developer.customFlagOverrides"` 键，重新启动即可恢复默认原生基线。
