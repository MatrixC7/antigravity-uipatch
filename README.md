# antigravity-uipatch

**解锁 Antigravity 桌面端应用在无 Google OAuth 会话（企业网关 / 自定义模型模式）及未命中云端灰度状态下被隐藏的实验门控前端界面（`Extensions` 扩展菜单、内置 `Terminal`、多标签右侧栏、原生 `File Explorer` 标签页以及 `Settings -> Developer` 实验开关控制面板），修复原生 `<datalist>` 选择器在 Chromium 下无法滚动的缺陷，并将手动开关微调跨随机端口与软件包升级持久保存至用户配置目录。**

- **适用软件**：Antigravity 桌面端应用（Electron 宿主归档 `/opt/Antigravity/resources/app.asar` + 内嵌 Web UI 的本地引擎 `/opt/Antigravity/resources/bin/language_server`；本地上下文自动压缩预算解锁请参阅配套项目 [`antigravity-context-unlock`](https://github.com/MatrixC7/antigravity-context-unlock) 与命令行版 [`agy-context-unlock`](https://github.com/MatrixC7/agy-context-unlock)）
- **已验证版本**：`antigravity 2.29.1-1` Linux x86-64（`Built at CL: 1015941558`，Electron `44.5.1`），并通过代码锚点唯一性断言、IEEE 802.3 CRC32 校验与 V8 语法预检支持跨版本安全同步
- **各通道表现与解锁效果**：
  - **企业网关 / 自定义模型通道**（`~/.gemini/config/config.json` 启用 `gateway.enabled: true`，无 Google OAuth 会话）：未修补时 `GetMendelFlags` 返回空表 `{}`，导致受实验开关控制的 `Extensions`、`New Terminal`、V2 多标签右侧栏、Git Diff 审查等 40 余项原生功能全部连带关闭；**应用本工具后，网关模式默认注入该构建实测观测到的 Google 原生账号线上开启基线（41 项布尔开关 + 7 项参数配置），并额外开启 `Settings -> Developer` 面板，支持在可视化界面中对任意开关做双向增减微调、一键重置与跨重装持久化**
  - **Google OAuth 原生通道**：原样保留云端实时下发的完整 Mendel 实验表（实测快照共 384 项），**仅额外确保 `enable-developer-mode` 开启**，允许突破账号灰度限制在 `Settings -> Developer` 面板中自由开启或关闭任意实验特性，并通过 `window.nativeStorage` 实时落盘至 `~/.config/Antigravity/app_storage.json`（彻底解决随机回环端口导致重启丢失覆盖项的问题）
- **运行依赖**：仅需 Node.js `>= 18` 标准库（已在 `Node.js v26.13.1` 实测验证；零第三方 npm 依赖，无需外部 `unzip` 或 `@electron/asar` CLI）
- **许可证**：[MIT License](LICENSE)

---

## 1. 背景与问题定义

在 Antigravity 桌面端中切换至企业网关模式（或使用未被云端实验灰度的 Google 账号）时，右上角 `+` 菜单仅剩 `Open File` 一项，`Extensions`（UI 插件子菜单）与 `New Terminal`（内置终端）入口完全消失，右侧边栏亦无法自由切换多标签栏或原生树状文件浏览器（`File Explorer`）。

通过对桌面端 Electron 宿主包 `app.asar`、Go 编排引擎 `language_server` 与本地 Connect RPC 接口的联合取证，可以确认以下四项核心事实：

1. **后端扩展与终端能力本身处于正常就绪状态，隐藏行为纯粹发生在前端渲染门控层。**
   实测企业网关模式下，`GetServerConfiguration` 正常返回 `"sidecars": { "enabled": true }`，`GetAllPlugins` 正常加载并拉起本地 Sidecar 进程；问题根源在于 `GetMendelFlags` 在无 Google OAuth 凭据时返回空对象 `{"experimentConfig":{}}`，使前端所有缺省关闭的实验门控全部回退为隐藏。
2. **本地 RPC 与环境变量均无法绕过服务端的实验开关权限门禁。**
   `language_server` 虽包含 `SetMendelFlagOverrides` RPC，但在公开构建中受内部只读标志 `dev_mode` 硬性拦截，直接调用返回 `permission_denied: Mendel flag overrides require developer mode`；其余实验接口（`SetBaseExperiments`、`UpdateDevExperiments`、`UpdateEnterpriseExperimentsFromUrl`）虽返回 `{}`，但在空 Mendel 表下均不生效（完整实测记录见 [《Mendel 门控取证报告》](docs/mechanism-mendel-gating.md)）。
3. **随机回环端口导致原版 `localStorage` 开关覆盖在每次重启或重装后丢失。**
   Electron 宿主每次均以 `--https_server_port 0` 在随机端口（`https://127.0.0.1:<随机端口>`）启动本地前端服务。由于 Chromium 按 `协议 + 主机 + 端口` 严格隔离 `window.localStorage`，原版前端仅将手动修改写入 `localStorage` 的设计会导致重启客户端或升级软件包后所有自定义开关归零。
4. **原版 `Developer` 面板的开关添加框存在 Chromium 原生 `<datalist>` 不可滚动缺陷。**
   即便解锁 `Settings -> Developer` 页面，原版前端底部用于搜索和添加开关的组件 `mtb()` 采用了 HTML `<datalist>`。在 Linux Electron / Chromium 中，该原生弹窗不仅强制渲染为脱离深色主题的白底黑字，且**完全不支持滚轮滚动**，导致首屏之外的数十个实验开关无法浏览点选。

---

## 2. 解决方案：惰性 ASAR 钩子 + Google 原生基线对齐 + 跨端口持久化

`language_server` 原生提供命令行参数 `-web_bundle_path`，支持从外部目录优先加载前端静态资源（覆盖编译进 Go 二进制内的 `agy_hub_web_bundle` ZIP 归档），且**无需修改 `language_server` 二进制的任何一个字节**。

`antigravity_uipatch.mjs` 采用完全解耦、随时可逆的三步设计：

| 组件层级 | 目标路径 | 改动内容与体量 | 技术作用 |
|---|---|---|---|
| **① 宿主惰性钩子** | `/opt/Antigravity/resources/app.asar`<br>（仅改 `dist/languageServer.js`） | 新增 **5 行**（2 行注释 + 3 行条件代码；原厂其余 1,091 个文件条目及前序第三方注入条目的偏移与字节 0 变动） | 仅当环境变量 `AGY_UI_BUNDLE` 存在时向 `language_server` 追加 `--web_bundle_path`；未设置该变量时行为与原厂 100% 一致。 |
| **② 外置前端补丁** | `~/.local/share/antigravity-uipatch/`<br>（仅改 `main.js` 四处汇聚点） | 提取 548 个归档条目（540 个文件 + 8 个目录，其余 539 个文件原样保留），对 `main.js`（`11,188,738` → `11,199,216` B）施加 **4 处唯一锚点补丁** | 1. **`fka()`（Mendel 原生基线 + 持久化预热）**：启动早期从 `~/.config/Antigravity/app_storage.json` 回填手动覆盖至新端口 `localStorage`；通过 `__agyResolveExperiments()` 区分“实时非空表 / 成功空表（清空旧缓存并启用 **41 项布尔开关 + 7 项参数配置 + `enable-developer-mode`** 基线） / 请求失败（保留 last-known-good）”；<br>2. **`lB().getMendelFlags`**：捕获次级通道 RPC 异常，与主通道共用同一套 `__agyResolveExperiments()` + `__agyNormalizeMendel()` 归一化策略；<br>3. **`jj` / `kj` / `FS` / `flagOverrideSync` / `mk()`**：使全部直读布尔通道实时响应双向覆盖，通过 `__agyRegisterNotifier()` 解耦 RPC 队列即时刷新界面，并将 `jetski.developer.*` 修改经串行合并队列（含删除墓碑）同步落盘至 `window.nativeStorage`（`app_storage.json`）；<br>4. **`mtb()`**：替换不可滚动的原生 `<datalist>` 为深色主题适配、向上展开（`bottom-full mb-1`）、支持滚轮与键盘导航及 ARIA `listbox` 语义的可滚动下拉框。 |
| **③ 启动器开关** | `~/.local/share/applications/antigravity.desktop` | 基于统一解析器 `analyseDesktopExec()` 与双层编码（`Exec` argv → `GKeyFile` 字符串）注入 `AGY_UI_BUNDLE=<ui-dir>` 并刷新桌面缓存 | 从系统应用菜单启动时自动挂载修补后的外置 UI；执行 `disable` 移除该变量即可零成本切回原厂内置 UI。 |

### 为什么采用“Google 原生账号基线 + `Developer` 面板微调 + `app_storage.json` 持久化”设计

开箱状态下（`0 overrides`），企业网关模式与 Google 原生账号拥有**一致的默认前端功能集**（内置终端 `Terminal`、多标签右侧栏、侧边栏 `Extensions`、Git Diff 审查、PDF / Notebook 预览、分屏、全文搜索、快捷键自定义等全部直接就绪），同时避免误开依赖 Google 内部专有基建或裁剪皮肤的危险开关。在此一致基线之上，你可以随时打开 `Settings -> Developer -> Custom Flags`：
- **关闭不喜欢的默认项**（如关掉隐藏独立历史列表的 `remove-conversation-history`，或关掉 `enable-aux-pane-redesign` 切回经典常驻四图标栏）—— 面板会清晰标记 `forced off`；
- **开启原生账号尚未灰度的进阶项**（如添加 `enable-context-usage-indicator`、`enable-bottom-terminal-panel`、`enable-conversation-forking` 等）—— 面板会标记 `forced on`；
- **跨重启与重装自动保留，亦可一键重置** —— 修改实时保存在 `~/.config/Antigravity/app_storage.json`，Pacman 重装或升级软件包均不会冲掉；点击右上角 `Reset overrides` 即可随时清空微调，回到纯净的 Google 原生默认状态 + `enable-developer-mode`。

---

## 3. 安装与使用指南

### 前置条件

1. 确认系统已安装 Node.js `>= 18`（运行 `node -v` 检查）。
2. 若 `/opt/Antigravity/resources/app.asar` 属主为 `root:root`，请在写入宿主归档的命令（`install`、`sync`、`restore`）前加上 `sudo` 并显式传入 `--user "$USER"`；若 `resources/` 目录已归属当前桌面用户，无需 `sudo` 即可直接运行。

### 标准操作流程

```bash
git clone https://github.com/MatrixC7/antigravity-uipatch.git ~/antigravity-uipatch
cd ~/antigravity-uipatch

# 1. 纯只读自检：校验 ASAR 零改动字节往返、内嵌 ZIP main.js CRC32、四处补丁唯一锚点与 V8 语法解析
node antigravity_uipatch.mjs self-test

# 2. 安装补丁（若 app.asar 归属 root，使用：sudo node antigravity_uipatch.mjs install --user "$USER"）
node antigravity_uipatch.mjs install

# 3. 校验安装状态、构建版本对齐与备份配对关系（确认输出 PATCHED、pairs : yes、align : matches）
node antigravity_uipatch.mjs verify
```

完成后，**从桌面环境的应用菜单重启 Antigravity**（若仅通过 `repair` 更新了外置 UI 补丁而宿主钩子与启动器早已生效，在窗口内按 `Ctrl+R` 重载即可）：
- 开箱即享与 Google 原生账号一致的全部默认功能（右上角 `+` 菜单已包含 `New Terminal`、`Browser`、`Extensions` 等）；
- 如需进一步增减实验开关，进入 **`Settings -> Developer -> Custom Flags`** 即可直接拨动已有开关或通过底部向上展开的选择器添加新开关（完整开关状态与推荐配置见 [《实验特性开关全景目录》](docs/custom-flags-catalog.md)）。

### 子命令与常用参数速查

| 子命令（含别名） | 是否改写 `app.asar` | 功能说明 |
|---|:---:|---|
| `self-test` | 否（纯只读） | 内存校验 ASAR 空替换逐字节往返、内嵌 Web UI `main.js` CRC32、4 处锚点唯一性与 V8 语法 |
| `install`（`patch`） | 是 | 记录/校验配对备份，暂存提取并修补外置 UI，注入 `app.asar` 惰性钩子，开启 `.desktop` 开关 |
| `sync` | 是 | 面向软件包升级后的全量同步：当新版 `app.asar` 未挂钩时自动刷新配对备份并重提新版 UI |
| `repair` | 否 | 仅从当前 `language_server` 重新提取并原子替换外置 Web UI（自动优先沿用 `.desktop` 当前指向的目录） |
| `verify`（`status`） | 否（纯只读） | 结构化检查构建 `CL`、备份配对、启动器四态（`ON`/`OFF`/`UNKNOWN`/`INVALID`）、`uipatch.json` 与 `main.js` 哈希及运行中进程 |
| `disable` | 否 | 仅从 `.desktop` 移除 `AGY_UI_BUNDLE` 并刷新桌面缓存，重启即回退原厂内置 UI |
| `restore`（`uninstall`） | 是 | 经 `pairsWith` 内容级配对校验后原子写回原版 `app.asar`，并关闭 `.desktop` 启动器开关 |
| `extract [dir]` | 否 | 将未打补丁的原厂内嵌 Web UI 解压至指定的新建或空目录（拒绝非空目录，绝不清空用户数据） |
| `pacman-hook` | 否 | 打印或经 Root 权限链审计后写入（`--write <file>`）Pacman `PostTransaction` Hook |

常用全局选项：`--user <username>`（以 `root` 运行时指定目标桌面账号，亦可通过环境变量 `AGY_TARGET_USER` 传入）、`--install-dir <dir>`（默认 `/opt/Antigravity`）、`--ui-dir <dir>`（自定义外置 UI 目录；未指定时按 `--ui-dir` > `AGY_UI_DIR` > `.desktop` 已配置路径 > `~/.local/share/antigravity-uipatch` 顺序解析）、`--dry-run`（全局零写入预演）、`--force`（仅 `restore` 强制忽略配对失配）、`--quiet`（仅 `sync` 静默标准输出）。

### 软件包升级后的处理方式与 Pacman 自动更新 Hook

每次系统升级 `antigravity` 软件包时，`/opt/Antigravity/resources/app.asar`（宿主钩子被覆盖）与 `language_server`（内嵌新版前端代码）都会更新。**切勿长期使用旧版外置 UI 搭配新版 `language_server` 后端**，请按以下任一方式同步：

1. **手动同步（一行命令同时刷新配对备份、重注钩子并重提新版 UI，保留你在 `app_storage.json` 中的手动开关配置）**：
   ```bash
   sudo node ~/antigravity-uipatch/antigravity_uipatch.mjs sync --user "$USER"
   ```
2. **Pacman 自动更新 Hook（推荐，适用于 Arch Linux / EndeavourOS / CachyOS）**：
   - Pacman Hook 以 `root` 身份直接经 `execv(3)` 执行（不经过 shell，不展开 `~`）。**切勿在 Hook 中直接指向普通用户主目录下的可写脚本**，应先将单文件自包含脚本安装至 `root:root` 拥有的系统只读目录，再由 `pacman-hook` 子命令经权限链审计后写入：
   ```bash
   # 1. 将自包含脚本安装至 root:root 拥有的系统只读路径
   sudo install -D -o root -g root -m 0755 \
     ~/antigravity-uipatch/antigravity_uipatch.mjs \
     /usr/local/share/antigravity-uipatch/antigravity_uipatch.mjs

   # 2. 审计路径权限链并生成 /etc/pacman.d/hooks/99-antigravity-uipatch.hook
   sudo node /usr/local/share/antigravity-uipatch/antigravity_uipatch.mjs pacman-hook \
     --user "$USER" \
     --script-path /usr/local/share/antigravity-uipatch/antigravity_uipatch.mjs \
     --write /etc/pacman.d/hooks/99-antigravity-uipatch.hook
   ```
   - 模板文件亦提供于 [`pacman/99-antigravity-uipatch.hook`](pacman/99-antigravity-uipatch.hook)（默认不带 `--quiet`，以便在 `pacman -Syu` 事务日志中直接查看同步状态与错误诊断）。该 Hook 采用 `Type = Path` 监听 `opt/Antigravity/resources/app.asar`，按字典序自动排在 `99-antigravity-context-unlock.hook` 之后运行，并通过尾部追加式 ASAR 重打包完整保留前序 Hook 的所有改动。

---

## 4. 适用场景与各模式表现对比

| 接入模式 / 场景 | 未修补时的前端表现 | 应用 `antigravity-uipatch` 后的表现 | 与配套工具的关系 |
|---|---|---|---|
| **桌面端：企业网关通道**<br>（`gateway.enabled: true`） | `GetMendelFlags` 为 `{}`；`Extensions`、`New Terminal`、多标签右侧栏、Git Diff 等 40 余项功能与 `Developer` 页全部隐藏 | **默认注入 Google 原生账号线上开启基线（41 项布尔 + 7 项载荷）+ 开启 `Settings -> Developer`**；手动增减自动持久化至 `app_storage.json` | 网关模式下上下文预算默认已达 `872K`，无需二进制补丁 |
| **桌面端：Google OAuth 原生通道** | 有 `Extensions` 与 `Terminal`，但 `Developer` 页及未灰度特性（如 `fileExplorerTab`、`bottomTerminalPanel`）隐藏；随机端口导致 `localStorage` 覆盖重启即丢 | **保留云端实时下发实验表 + 开启 `Settings -> Developer`**，支持双向覆盖任意实验项并跨重启/重装持久保留 | 可与 [`antigravity-context-unlock`](https://github.com/MatrixC7/antigravity-context-unlock)（解锁原生通道 `983K` 上下文预算）**零冲突同时安装** |

---

## 5. 验证与诊断工具

### 1. 静态状态、版本对齐与配对备份校验（纯离线只读）

```bash
# 只读自检（ASAR 零改动往返哈希、内嵌 ZIP main.js CRC32、四处锚点唯一性、V8 语法解析）
node antigravity_uipatch.mjs self-test

# 查看当前安装状态、启动器四态（ON/OFF/UNKNOWN/INVALID）、构建 CL 对齐、备份配对及运行中进程状态
node antigravity_uipatch.mjs verify
```

### 2. 内嵌实验开关全景静态扫描（`tools/inspect_flags.mjs`）

无需解压落盘，直接从 `language_server` 内存提取 `main.js` 并列出全部 **96 个 `customFlag` 门控关系**与 **29 处直读 / 次级 Mendel 调用点（去重后为 24 组 `reader+key` 组合，覆盖 22 个唯一实验键）**（耗时约 `0.1s`）：

```bash
# 查看全部实验开关及受控特性映射
node tools/inspect_flags.mjs

# 按关键字过滤或输出机器可读 JSON
node tools/inspect_flags.mjs --filter terminal
node tools/inspect_flags.mjs --json
```

### 3. 独立引擎回环在线验证（`verify_live.mjs`）

不启动 Electron GUI、不触碰 `~/.gemini` 用户目录，在随机回环端口拉起临时 `--standalone` 引擎实例，通过 HTTPS 实测校验 `GET /`、`GET /main.js`（磁盘 SHA256 一致性与 V8 语法解析）、**9 项静态包内补丁断言（static bundle assertions）**以及 `GetServerConfiguration` Connect RPC（合计 10 项 `[OK]` 检查输出）：

```bash
node verify_live.mjs
```

### 4. 离线单元测试套件

包含 **40 项自动化测试**（`39` 项核心单元与回归测试 + `1` 项扫描工具测试：涵盖合成与真实 `app.asar` 逐字节往返一致性、单条目替换隔离性、ASAR `link` 节点容错、备份配对判定与坏备份拒绝、STORE/DEFLATE ZIP 解压与单比特 CRC32 损坏拦截、EOCD 诱饵与中央目录边界校验、路径穿越与规范化名冲突拦截、双 ZIP 时区归档排除、全部 4 处前端补丁与 V8 语法校验、结构扫描器 fail-closed 断言、VM 沙盒验证 Google 原生基线与双向覆盖语义、主/次双通道共享成功空表清缓存与错误保留 last-known-good、解耦 RPC 队列的本地即时通知与释放器、`nativeStorage` 跨随机端口持久化与 hydrate 失败重试及墓碑合并、UI 提交状态机双失败保护、`resolveWriteRoot` 与符号链接隔离策略，以及 `.desktop` 双层编码幂等重写、`env` 选项顺序、程序后诱饵参数保留与启动器四态解析）：

```bash
node --test tests/
```

---

## 6. 仓库文档导航

本仓库按“通俗概念导读 → 补丁工程实现 → 门控逆向取证 → 全量开关目录”提供完整中文文档体系：

### 通俗导读与补丁实现原理
- **[《原理与使用指南（通俗导读）》（`docs/overview-and-guide.md`）](docs/overview-and-guide.md)**
  面向所有读者：解释 Antigravity 三层架构、企业网关与原生账号各自隐藏按钮的原因、为什么对齐 Google 原生基线并配合 `app_storage.json` 跨端口持久化最稳妥、以及 KDE `ksycoca6` 缓存等日常注意事项。
- **[《补丁架构与脚本实现详解》（`docs/patch-internals.md`）](docs/patch-internals.md)**
  面向开发者与系统管理员：深入解析尾部追加式无损 ASAR 打包器、双内嵌 ZIP 识别与 CRC32 校验器、`fka()` / `lB().getMendelFlags` / `jj`·`kj`·`FS`·`mk()`（`nativeStorage` 桥接）/ `mtb()` 四处补丁实现、统一桌面启动器解析器 `analyseDesktopExec()`、原子切换状态机以及 Pacman Hook 的 Root 信任边界审计。

### 深度技术报告与参考手册
- **[《技术报告：Mendel 实验开关门控机制与本地注入路径实测取证》（`docs/mechanism-mendel-gating.md`）](docs/mechanism-mendel-gating.md)**
  完整记录前端三轨门控调用链、Google OAuth 线上 384 项快照对比、随机端口导致 `localStorage` 失效的根因、8 条候选技术路径的实测返回结果，以及 Electron 主程序 9 项 Fuse 位的二进制实测表。
- **[《技术参考：Antigravity 桌面端实验特性开关全景目录》（`docs/custom-flags-catalog.md`）](docs/custom-flags-catalog.md)**
  包含全部 **22 个直读 / 次级实验键（29 处调用点 / 24 组组合）** 与 **96 项 `FeatureManagerV2` `customFlag`** 的 Google OAuth 原生实测状态、本工具默认基线状态及逐项微调建议。

---

## 7. 安全机制、已知边界与一键回滚

### 安全防护设计
- **零改动 `language_server` 二进制**：绝不修改 Go 二进制文件，彻底避免破坏 ELF 签名或干扰 `antigravity-context-unlock` 的备份配对。
- **不分发完整第三方编译产物**：仓库体积仅百余 KB，不包含完整的 Antigravity Web UI 编译包或其提取资源；所有前端文件均在用户本机安装时从本机 `language_server` 实时提取。为完成定点修补，源码中含有少量用于唯一匹配的原厂代码锚点字符串，以及 Google 原生的第三方工具免责声明文案（`third-party-tools-disclaimer-text` 的默认载荷，用于在网关模式下复刻原生基线）。它们仅作为兼容性定位与基线数据存在，不构成可用软件的再分发。
- **故障闭合（Fail-Closed）与先预备后提交顺序**：任何锚点出现次数不为 `1`、ZIP 条目 CRC32 不符或修改后未通过 V8 `vm.Script` 语法解析时，脚本在暂存阶段即安全中止（退出码 `3`）；`install` / `sync` 均先在暂存目录完成新前端包的完整构建与校验（`preparePatchedUi`），确认无误后才改写 `app.asar` 并原子切换目录（`commitPatchedUi`），绝不留下半成品或白屏包。
- **`--dry-run` 全局零写入与按命令前置预检**：所有子命令在 `--dry-run` 模式下**绝不新增、修改或删除任何文件与目录**，并按各自职责执行只读预检（`install`/`sync` 执行完整 `self-test` 及备份可用性/缺失检查；`repair` 在内存中跑完提取、4 处补丁与 V8 语法验证；`restore`/`disable`/`extract`/`pacman-hook` 分别校验配对、启动器、空目录及 Root 路径权限链），使可只读判定的失败场景在预演中以相同退出码提前暴露。
- **UI 切换的提交状态机**：显式区分 `prepared` → `old-moved` → `committed` / `rolled-back` / `rollback-failed`，只有当新包确认落位或回滚确认成功后才删除旧副本；若替换与回滚同时失败，旧目录会被保留并在错误信息中给出绝对恢复路径与 `mv` 命令，绝不出现“唯一可用副本被清空”的情况。
- **不删除用户数据**：`extract` 只允许写入**新建或空目录**，对非空目录直接拒绝（绝不递归清空），并显式拒绝 `/`、`$HOME`、安装根目录及其父目录等危险目标。
- **区分“授权根”与“根以下的链接”**：普通文件与目录写入前先把目标根**一次**规范化到 `realpath`（因此用户自己的 `$HOME`、`--ui-dir` 或 `/tmp` 是符号链接也能正常工作），此后根以下出现任何符号链接立即中止；Pacman Hook 的 Root 脚本审计则更严格——词法链上出现任何符号链接即拒绝，并在 `realpath` 解析后的**物理**祖先链上逐级复核 `root:root` 归属与非组/他写权限。
- **内容级配对还原与坏备份隔离重建**：`restore` 在写回备份前验证“对备份重施钩子能否逐字节复现当前 `app.asar`”，防止跨版本误还原导致客户端降级。当已安装归档处于已挂钩（hooked）状态时，备份缺失、损坏或失配均会导致 `install` / `sync` 报错退出（退出码 `3`）；若已安装归档确认为未挂钩的原版（例如刚完成重装）而旧备份损坏，脚本会将坏备份隔离改名为 `app.asar.orig.unusable-<timestamp>`（保留证据）后直接重建新备份，无需重复重装。

### 已知边界说明
1. **前端入口解锁不替代云端专有服务**：开启前端实验开关仅解除本地界面门控；部分标记为 Google 内部专用的开关（如 CitC、ABFS、Critique、Google Drive 上传等）因缺少对应云端后端权限，在外部网络下开启后无法实际工作（详见 [《全景目录》第 3.4 节](docs/custom-flags-catalog.md#34-历史列表策略内部专有基建远程通道与裁剪皮肤36-项)）。
2. **请勿在启用状态下直接删除外置 UI 目录**：当 `.desktop` 仍带有 `AGY_UI_BUNDLE` 时，若手动删空 `~/.local/share/antigravity-uipatch`，`language_server` 会因目录缺失返回 `HTTP 500`。清理目录前请务必先运行 `disable` 或 `restore`。
3. **多 Hook 的执行顺序与还原边界**：本工具采用尾部追加式重打包，因此与其他修改 `app.asar` 的 Hook **在其之后运行**时可无损共存（前序改动全部保留）。但若在本工具之后又有第三方工具改写了别的条目，`restore` 的字节级配对会判定失配并**拒绝还原**（保护行为）——此时请重装 `antigravity` 后再 `install`。
4. **`verify` 的四态启动器契约与实时进程提示**：`verify` 将启动器严格区分为 `ON`、`OFF`、`UNKNOWN`、`INVALID` 四种状态。当全部资产健康且启动器为有效 `ON`，或启动器被主动停用为明确的 `OFF`（如执行 `disable` 后使用原厂内置 UI，此时不再强制要求已停用的默认外置目录存在）且其余受检项无损坏时，均返回退出码 `0`；而备份缺失/损坏、UI 未打补丁或语法/哈希异常、`CL` 不对齐、启动器缺 `Exec=` / 含不支持的 `env -S` 包装器、或 `ON` 状态下指向缺失目录时，统一返回退出码 `1` 并列出全部问题。注意：启动器为 `ON` 仅代表磁盘配置就绪，若后台已有旧 `language_server` 进程在运行，`live proc` 行会提示重启应用使其生效。

### 一键停用与完整还原

```bash
# 轻量停用：仅移除 .desktop 中的 AGY_UI_BUNDLE 开关并刷新桌面缓存（重启即回原厂内置 UI）
node ~/antigravity-uipatch/antigravity_uipatch.mjs disable

# 完整卸载：经配对校验后原子还原原版 app.asar，关闭启动器开关
sudo node ~/antigravity-uipatch/antigravity_uipatch.mjs restore --user "$USER"

# 若配置了 Pacman 自动更新 Hook，一并移除系统只读副本与 Hook 文件
sudo rm -f /etc/pacman.d/hooks/99-antigravity-uipatch.hook
sudo rm -rf /usr/local/share/antigravity-uipatch

# （可选）确认不再需要后清理用户目录下的外置 UI 与备份
# 注：你在 Developer 面板中的个人开关偏好独立保存在 ~/.config/Antigravity/app_storage.json，不会被误删
rm -rf ~/.local/share/antigravity-uipatch ~/.local/share/antigravity-uipatch-backup
```

---

## 8. 支持范围与状态契约（Support Scope）

本节明确“本工具保证什么”与“明确不做什么”，避免把有意的工程边界误判为隐式承诺。

### 8.1 已验证环境

| 项目 | 状态 |
|---|---|
| 平台 | Linux x86-64（已实测验证） |
| Antigravity | `2.29.1-1` / `CL 1015941558`（已实测验证） |
| Node.js | `v26.13.1` 实跑验证；`>= 18` 为标准库 API 预期兼容下限，未逐版本建立测试矩阵 |
| 运行依赖 | 仅 Node.js 标准库，无第三方 npm 依赖 |

### 8.2 补丁对象与前端结构

- 仅替换 ASAR 中的固定**普通打包条目** `dist/languageServer.js`；**绝不修改** `language_server` 二进制。
- 4 处前端补丁依赖**当前已验证的锚点与组件结构**。若上游版本改动导致锚点失配，工具会 **fail-closed 退出（退出码 `3`）**，绝不产出半成品；升级后需适配新锚点，不承诺跨任意未来版本自动兼容。
- `mtb()` 定位采用“严格结构扫描 + 嵌套 `function` 声明安全网”：遇到注释（`//`、`/*`）或无法明确判定为除法的 `/` 一律拒绝。**已知边界**：该扫描器并非完整 JS 词法解析器，仅面向当前已验证的编译组件结构设计，不承诺对任意合成 JS 语法（如紧邻箭头函数表达式与伪装为除法的复杂标记组合）提供完备词法级证明。

### 8.3 ASAR / ZIP 格式范围

- ASAR 支持当前 Chromium Pickle 归档格式及 `unpacked`、`link` 条目的**原样保留**；不支持将 `link` 节点作为替换目标（本工具仅替换固定的普通条目）。
- ZIP 支持单卷非加密的 `STORE (0)` / `DEFLATE (8)` 及流式 data descriptor 标志；**不支持** ZIP64、分卷/多盘、加密或数字签名扩展。单条目上限 `128 MiB`、整包解压预算 `512 MiB`（当前前端资源远小于阈值）。
- ZIP 条目名拒绝空段、`.` 段、`..`、前导 `/` 与反斜线；按规范化路径去重并拦截文件/目录同名冲突（如 `a` 与 `a/`）。

### 8.4 桌面启动器 `Exec=` 范围

- 严格区分两层编码：写入时先对单个参数执行 **Exec argv 层引号与转义**（含 `%` → `%%`），拼接后再整体执行 **GKeyFile 字符串层转义**（`\` 双写、换行/制表符转义、行首空格 `\s`）；读取时按相反顺序解码。
- 支持直接命令，以及 `env` / `/usr/bin/env` 前缀下的**已列明选项**（无参 `-i`/`--ignore-environment`、`-0`/`--null`、`-v`/`--debug`，带参 `-u`/`--unset`、`-C`/`--chdir`，以及选项终止符 `--`）与**任意多个** `NAME=value` 赋值；本工具注入的赋值恒位于选项之后、程序名之前，程序名之后的同形参数按普通参数原样保留。
- **不支持** `env -S` / `--split-string`、未知 `env` 选项及复杂 shell 包装器：遇到此类形式会**明确拒绝改写（退出码 `3`）或在 `verify` 中报告不可用**，绝不静默猜测为 `OFF`。
- 对受支持格式，`disable` 与 `restore` 承诺保持 `argv` 参数语义、未触碰参数的原始引号及其他环境变量不变（单空格分隔的标准行可逐字节往返，连续空白分隔符会规范化为单空格；首次修改前的原始文件亦备份于 `~/.local/share/antigravity-uipatch-backup/antigravity.desktop.orig`）。

### 8.5 路径与权限边界

- 普通用户的授权根（`$HOME`、`--ui-dir`）**可以**是符号链接：工具将其解析一次到物理根，此后**根以下**出现任何符号链接均中止写入。
- Pacman Hook 的 Root 脚本审计拒绝词法路径上的任何符号链接，并在 `realpath` 解析后的物理祖先链上逐级复核 `uid === 0` 且 `mode & 0o022 === 0`。
- 上述非竞争路径检查**不等同于**操作系统内核级无 TOCTOU 保证；未在宿主 Root 环境下执行真实提权利用实验。

### 8.6 持久化与并发边界

- 单 renderer 内：`window.nativeStorage.updateItems` 写入**串行合并**，失败时保留未确认批次并执行**有界自动重试**（1 次初始发送 + 最多 3 次重试，线性退避 `150 / 300 / 450 ms`）。
- 对提交结果未知（底层 IPC 挂起无返回）的调用不执行并发超时重发，以免破坏写入顺序；极端挂死场景下需重启窗口恢复。
- **不保证跨窗口 / 跨 renderer 的事务强一致性**——宿主内置 `StorageManager` 采用全表 read-modify-write 实现，属于上游架构边界。
- 启动预热以桌面端默认的**每次新随机端口（空 origin）**为主支持路径；若手动固定端口复用旧 origin，前端极早期的同步读取（`s7c()`）可能先于异步预热完成，必要时重载一次窗口即可。此外，若在预热完成前对同一键先删除再恢复，元数据中可能残留无害的历史墓碑记录（有效字符串值始终优先，不影响读取结果）。

### 8.7 账号与实验表解析语义

- 主通道 `fka()` 与次级通道 `lB().getMendelFlags` 共用 `__agyResolveExperiments()` 与 `__agyNormalizeMendel()`：
  - **服务端成功返回非空数组**：更新 `__agyLastGood` 并原样保留线上实验表，仅确保 `enable-developer-mode` 开启；
  - **服务端成功返回空数组 `[]`**（含网关模式常见响应 `{"experimentConfig":{}}` 经 Protobuf 解码补全为空数组的情形）：视为服务端撤回实验表（如切换至网关模式），**清空 `__agyLastGood` 并采用静态观测基线**；若响应连外层 `experimentConfig` 消息本身都缺失（顶层 `{}`），解码结果为 `undefined`，将按未知/异常响应保留上一次缓存；
  - **RPC 请求抛出异常**：两条通道均捕获异常并回退至 `__agyLastGood`（从未成功拉取过实时表时回退静态基线）。
- `41 + 7` 静态基线为**指定账号与构建版本下的实测快照**，不承诺所有 Google 账号、地区或未来时段云端下发集合恒等。

### 8.8 退出码契约

| 退出码 | `antigravity_uipatch.mjs` 含义 | `verify_live.mjs` 含义 |
|---:|---|---|
| `0` | 命令成功完成；或 `verify` 确认为健康的 `ON` / 明确主动停用的 `OFF` | 全部在线 HTTP / Connect RPC 与 9 项静态包内断言通过 |
| `1` | `verify` 判定存在健康问题（含启动器 `INVALID`/`UNKNOWN`），或目标不可写等运行期错误 | 在线断言不匹配或 HTTP / RPC 响应失败 |
| `2` | 命令行参数错误、目标账号非法（如解析到 UID 0）或 Hook 脚本路径未通过 Root 审计 | 命令行参数非法，或独立引擎启动失败（含二进制缺失、`spawn` 失败、早退及等待监听端口超时） |
| `3` | 安全或兼容性故障闭合拒绝（锚点失配、V8 语法失败、CRC32/ZIP 异常、不可信备份、不支持的启动器形式、非空提取目录、符号链接拦截等） | — |

`--dry-run` 仅检查该子命令可只读判定的前置条件，不承诺真实写入时刻的文件系统权限、剩余空间或外部并发状态永不变化。

### 8.9 发布物范围

本仓库仅包含原创脚本、自动化测试与技术文档，以及为定点修补所需的少量原厂代码锚点字符串与默认免责声明基线载荷；**绝不分发**提取出的 Antigravity Web UI 编译资源。

---

## 9. 致谢与配套项目

本项目与以下同系列研究仓库共同构成 Antigravity 客户端本地机制审计与增强工具集，三者职责正交、可独立或组合使用：

- **[`antigravity-context-unlock`](https://github.com/MatrixC7/antigravity-context-unlock)**：解除 Antigravity 桌面端 `language_server` 在 Google OAuth 原生通道下的 256K 本地上下文自动压缩限制。
- **[`agy-context-unlock`](https://github.com/MatrixC7/agy-context-unlock)**：解除命令行工具 `antigravity-cli`（`/usr/bin/agy`）的 256K 本地上下文压缩限制并恢复 `/model` 与 `settings.json` 持久化闭环。

在机制逆向、全路径实测取证、零依赖脚本实现、多轮评审迭代、自动化测试与中文技术文档撰写中，主要工作由以下大语言模型协作完成：**Gemini 4 Carbon**、**DeepSeek V4.1 Flash 1017** 与 **GPT 6 Astra**；仓库维护者提供了问题定义、实机网关测试环境与架构取舍决策。谨致谢意。

---

## 10. 许可证

本项目基于 [MIT License](LICENSE) 发布（仅涵盖本仓库内的原创脚本与文档代码；运行期在本机提取的 Antigravity Web UI 资源归属 Google 所有，永不随本仓库分发）。
