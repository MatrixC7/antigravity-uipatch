# CLI 命令参考、安全机制与支持契约

> 本文档完整收录 `antigravity_uipatch.mjs` 的子命令与参数说明、升级同步与卸载流程、诊断与测试工具、安全防护设计、已知运行边界以及正式支持范围与退出码契约（Support Scope）。
> - 通俗架构导读与推理遥测面板读数指南见 [《原理与使用指南》（`overview-and-guide.md`）](overview-and-guide.md)
> - 内部算法与逆向取证细节见 [《补丁架构与脚本实现详解》（`patch-internals.md`）](patch-internals.md)
> - 全量实验开关清单见 [《实验特性开关全景目录》（`custom-flags-catalog.md`）](custom-flags-catalog.md)

---

## 1. CLI 子命令与全局参数参考

### 1.1 子命令速查表

| 子命令（含别名） | 是否改写 `app.asar` | 功能说明 |
|---|:---:|---|
| `self-test` | 否（纯只读） | 内存校验 ASAR 空替换逐字节往返、内嵌 Web UI `main.js` CRC32、5 处锚点唯一性与 V8 语法解析 |
| `install`（`patch`） | 是 | 记录/校验配对备份，暂存提取并修补外置 UI，注入 `app.asar` 惰性环境变量钩子（不自动修改 `.desktop` 文件） |
| `sync` | 是 | 面向软件包升级后的全量同步：当新版 `app.asar` 未挂钩时自动刷新配对备份、重注钩子并重提新版 UI |
| `repair` | 否 | 仅从当前 `language_server` 重新提取并原子替换外置 Web UI（若 `.desktop` 已配置路径则自动沿用） |
| `verify`（`status`） | 否（纯只读） | 结构化检查构建 `CL`、备份配对、`uipatch.json` 与 `main.js` 哈希、可选 `.desktop` 配置及运行中进程 |
| `restore`（`uninstall`） | 是 | 经 `pairsWith` 内容级配对校验后原子写回原版 `app.asar` |
| `extract [dir]` | 否 | 将未打补丁的原厂内嵌 Web UI 解压至指定的新建或空目录（拒绝非空目录，绝不清空用户数据） |
| `pacman-hook` | 否 | 打印或经 Root 权限链审计后写入（`--write <file>`）Pacman `PostTransaction` Hook |

### 1.2 全局选项说明

- **`--user <username>`**：以 `root`（`sudo`）运行时指定目标桌面账号（用于定位该用户的 `~/.local/share/applications/antigravity.desktop` 与默认外置 UI 目录；亦可通过环境变量 `AGY_TARGET_USER` 传入）。
- **`--install-dir <dir>`**：指定 Antigravity 安装根目录（默认 `/opt/Antigravity`）。
- **`--ui-dir <dir>`**：自定义外置 Web UI 目录。未显式指定时按以下优先级自动解析：`--ui-dir` > `AGY_UI_DIR` > `.desktop` 当前已配置路径 > `~/.local/share/antigravity-uipatch`。
- **`--indicator-mode <custom|polyfill|stock>`**：上下文与推理遥测指示器挂载策略：
  - `custom`（默认）：挂载增强指示器组件 `__AgyContextIndicator`；若未来某版上游同时恢复非空原生组件并重构了内部会话 Hook，脚本自动安全回退并保留上游原生实现，绝不阻断升级同步；
  - `polyfill`：仅当上游插槽为 `void 0` 时挂载增强组件，上游提供原生实现时直接旁路；
  - `stock`：不修改 `contextUsageIndicator` 插槽。
- **`--dry-run`**：全局零写入预演，按子命令职责执行全部可只读判定的前置检查。
- **`--force`**：仅用于 `restore`，强制忽略备份与当前 `app.asar` 的配对失配。
- **`--quiet`**：仅用于 `sync`，正常完成时静默标准输出（适合自动化脚本）。

### 1.3 环境变量激活方式（终端与 `.desktop` 启动器）

`install` 与 `sync` 不会自动创建或改写 `~/.local/share/applications/antigravity.desktop`，避免覆盖用户自定义的桌面启动参数（如输入法、Wayland 或代理配置）。由于 `app.asar` 内的钩子仅在检测到环境变量 `AGY_UI_BUNDLE` 时才挂载外置 UI，请按自己的启动习惯手动传入该变量：

1. **终端命令行启动**：
   ```bash
   AGY_UI_BUNDLE="$HOME/.local/share/antigravity-uipatch" antigravity
   ```
   （不传该变量直接运行 `antigravity` 即可免卸载以原厂内置 UI 启动。）

2. **桌面图标（`.desktop` 文件）启动**：
   直接编辑 `~/.local/share/applications/antigravity.desktop`（若该文件不存在，先启动一次 Antigravity 通常会自动生成，也可在桌面菜单右键「编辑应用程序」创建用户级副本；若仍不存在，再执行 `install -Dm644 /usr/share/applications/antigravity.desktop ~/.local/share/applications/antigravity.desktop` 以当前用户可写权限拷贝一份），将其中的 `Exec=` 行改为（注意 `.desktop` 标准不展开 `$HOME` 或 `~`，须填写绝对路径）：
   ```ini
   Exec=env AGY_UI_BUNDLE=/home/<你的用户名>/.local/share/antigravity-uipatch /usr/bin/antigravity %U
   ```
   （KDE Plasma 桌面若未立即生效，可执行一次 `kbuildsycoca6 --noincremental` 刷新启动器缓存。）

### 1.4 软件包升级同步与 Pacman 自动更新 Hook

每次系统升级 `antigravity` 软件包时，`/opt/Antigravity/resources/app.asar`（宿主钩子被覆盖）与 `language_server`（内嵌新版前端代码）都会更新。**切勿长期使用旧版外置 UI 搭配新版 `language_server` 后端**，请按以下任一方式同步：

1. **手动同步**（一行命令刷新配对备份、重注钩子并重提新版 UI，保留你在 `app_storage.json` 中的全部个人配置）：
   ```bash
   sudo node ~/antigravity-uipatch/antigravity_uipatch.mjs sync --user "$USER"
   ```
2. **Pacman 自动更新 Hook**（推荐，适用于 Arch Linux / EndeavourOS / CachyOS）：
   Pacman Hook 以 `root` 身份直接经 `execv(3)` 执行（不经过 shell，不展开 `~`）。**切勿在 Hook 中直接指向普通用户主目录下的可写脚本**，应先将单文件脚本安装至 `root:root` 拥有的系统只读路径，再由 `pacman-hook` 经权限链审计后生成 Hook：
   ```bash
   sudo install -D -o root -g root -m 0755 \
     ~/antigravity-uipatch/antigravity_uipatch.mjs \
     /usr/local/share/antigravity-uipatch/antigravity_uipatch.mjs

   sudo node /usr/local/share/antigravity-uipatch/antigravity_uipatch.mjs pacman-hook \
     --user "$USER" \
     --script-path /usr/local/share/antigravity-uipatch/antigravity_uipatch.mjs \
     --write /etc/pacman.d/hooks/99-antigravity-uipatch.hook
   ```
   模板亦提供于 [`pacman/99-antigravity-uipatch.hook`](../pacman/99-antigravity-uipatch.hook)。该 Hook 采用 `Type = Path` 监听 `opt/Antigravity/resources/app.asar`，按字典序自动排在 `99-antigravity-context-unlock.hook` 之后运行，并通过尾部追加式 ASAR 重打包完整保留前序 Hook 的所有改动。

### 1.5 临时停用与完整卸载还原

启动时不传入 `AGY_UI_BUNDLE` 环境变量即可直接运行原厂内置 UI（无需卸载补丁）。如需完整卸载还原：

```bash
# 完整卸载：经配对校验后原子还原原版 app.asar（若手动改过 .desktop 可自行删去环境变量）
sudo node ~/antigravity-uipatch/antigravity_uipatch.mjs restore --user "$USER"

# 若配置了 Pacman 自动更新 Hook，一并移除系统只读副本与 Hook 文件
sudo rm -f /etc/pacman.d/hooks/99-antigravity-uipatch.hook
sudo rm -rf /usr/local/share/antigravity-uipatch

# （可选）确认不再需要后清理用户目录下的外置 UI 与备份
# 注：你在 Developer 面板及指示器中的个人偏好独立保存在 ~/.config/Antigravity/app_storage.json，不会被误删
rm -rf ~/.local/share/antigravity-uipatch ~/.local/share/antigravity-uipatch-backup
```

---

## 2. 验证、静态扫描与自动化测试工具

### 2.1 静态状态、版本对齐与配对备份校验（纯离线只读）

```bash
node antigravity_uipatch.mjs self-test
node antigravity_uipatch.mjs verify
```

### 2.2 内嵌实验开关全景静态扫描（`tools/inspect_flags.mjs`）

无需解压落盘，直接从 `language_server` 内存提取 `main.js`、自动解析当前构建压缩后的读取器符号，列出全部 **107 个 `customFlag` 门控关系**与 **27 处直读 / 次级 Mendel 调用点（去重后为 24 组 `reader+key` 组合，覆盖 23 个唯一实验键）**（耗时约 `0.1s`）：

```bash
node tools/inspect_flags.mjs
node tools/inspect_flags.mjs --filter terminal
node tools/inspect_flags.mjs --json
```

### 2.3 独立引擎回环在线验证（`verify_live.mjs`）

不启动 Electron GUI、不触碰 `~/.gemini` 用户目录，在随机回环端口拉起临时 `--standalone` 引擎实例，通过 HTTPS 实测校验 `GET /`、`GET /main.js`（磁盘 SHA256 一致性与 V8 语法解析）、**10 项静态包内补丁断言**以及 `GetServerConfiguration` Connect RPC（合计 11 项 `[OK]` 检查输出）：

```bash
node verify_live.mjs
```

### 2.4 离线单元测试套件

包含 **38 项自动化测试**（`37` 项核心单元与回归测试 + `1` 项扫描工具测试：涵盖合成与真实 `app.asar` 逐字节往返一致性、单条目替换隔离性、ASAR `link` 节点容错、备份配对判定与坏备份拒绝、STORE/DEFLATE ZIP 解压与单比特 CRC32 损坏拦截、EOCD 诱饵与中央目录边界校验、路径穿越与规范化名冲突拦截、双 ZIP 时区归档排除、全部 5 处结构化前端补丁与 V8 语法校验、Closure 压缩符号含 `$` 前缀重命名自适应测试、结构扫描器 fail-closed 断言、VM 沙盒验证 Google 原生基线与双向覆盖语义、主/次双通道共享成功空表清缓存与错误保留 last-known-good、`clientStorageFeature` + `nativeStorage` 跨随机端口持久化与 hydrate 失败重试、上下文指示器 `TokenType` 细分 / 压缩后近似 / `Last Turn` 与 `Σ Session · N turns` 双 `4×2` 正交指标 / 真实缓存总输入分母 / `PROD_UI` 步骤 `createdAt` 时间戳回退 / 流式期间快照稳定 / 原生 `h-7` 胶囊尺寸与 `t/s [Off | Turn | Avg]` 三段式底栏切换持久化及三模式自适应策略、解耦 RPC 队列的本地即时通知与 `dispose` 注销、UI 提交状态机双失败保护、`resolveWriteRoot` 与符号链接隔离策略，以及 `.desktop` `Exec=` 只读解析器的 `GKeyFile`+`Exec` 双层反转义、`env` 选项解析与程序后诱饵参数隔离）：

```bash
node --test tests/
```

---

## 3. 安全机制与已知运行边界

### 3.1 安全防护设计

- **零改动 `language_server` 二进制**：绝不修改 Go 二进制文件，彻底避免破坏 ELF 签名或干扰 `antigravity-context-unlock` 的备份配对。
- **不分发完整第三方编译产物**：仓库不包含完整的 Antigravity Web UI 编译包或其提取资源；所有前端文件均在用户本机安装时从本机 `language_server` 实时提取。源码中仅含少量用于唯一匹配的原厂代码锚点字符串及默认免责声明基线载荷（`third-party-tools-disclaimer-text`），不构成可用软件再分发。
- **故障闭合（Fail-Closed）与先预备后提交顺序**：任何锚点出现次数不为 `1`、ZIP 条目 CRC32 不符或修改后未通过 V8 `vm.Script` 语法解析时，脚本在暂存阶段即安全中止（退出码 `3`）；`install` / `sync` 均先在暂存目录完成新前端包的完整构建与校验（`preparePatchedUi`），确认无误后才改写 `app.asar` 并原子切换目录（`commitPatchedUi`），绝不留下半成品或白屏包。
- **`--dry-run` 全局零写入与按命令前置预检**：所有子命令在 `--dry-run` 模式下绝不新增、修改或删除任何文件与目录，并按各自职责执行只读预检，使可只读判定的失败场景在预演中以相同退出码提前暴露。
- **UI 切换的提交状态机**：显式区分 `prepared` → `old-moved` → `committed` / `rolled-back` / `rollback-failed`，只有当新包确认落位或回滚确认成功后才删除旧副本；若替换与回滚同时失败，旧目录会被保留并在错误信息中给出绝对恢复路径与 `mv` 命令。
- **不删除用户数据**：`extract` 只允许写入新建或空目录，对非空目录直接拒绝（绝不递归清空），并显式拒绝 `/`、`$HOME`、安装根目录及其父目录等危险目标。
- **区分“授权根”与“根以下的链接”**：普通文件与目录写入前先把目标根一次规范化到 `realpath`（因此用户自己的 `$HOME`、`--ui-dir` 或 `/tmp` 是符号链接也能正常工作），此后根以下出现任何符号链接立即中止；Pacman Hook 的 Root 脚本审计则拒绝词法链上的任何符号链接，并在 `realpath` 解析后的物理祖先链上逐级复核 `root:root` 归属与非组/他写权限。
- **内容级配对还原与坏备份隔离重建**：`restore` 在写回备份前验证“对备份重施钩子能否逐字节复现当前 `app.asar`”，防止跨版本误还原导致客户端降级。当已安装归档为未挂钩原版而旧备份损坏时，脚本将坏备份隔离改名为 `app.asar.orig.unusable-<timestamp>` 后直接重建新备份。

### 3.2 已知运行边界

1. **前端入口解锁不替代云端专有服务或其余已被编译期剥离的专有组件**：部分 Google 内部专用开关（CitC、ABFS、Critique 等）因缺少云端后端权限无法工作；`2.31.0-1` 外部包中被置为 `buildBindings: void 0` 的三项组件里，**`contextUsageIndicator` 已由本工具挂载增强组件完整恢复**，其余两项（`enable-code-search-palette` 与 `enable-enhanced-file-viewer`）因无实现代码仍不会生效。
2. **请勿在启用状态下直接删除外置 UI 目录**：当启动环境仍带有 `AGY_UI_BUNDLE` 时，若手动删空 `~/.local/share/antigravity-uipatch`，`language_server` 会因目录缺失返回 `HTTP 500`。清理目录前请先移除环境变量或运行 `restore`。
3. **多 Hook 的执行顺序与还原边界**：本工具采用尾部追加式重打包，因此与其他修改 `app.asar` 的 Hook 在其之后运行时可无损共存。但若在本工具之后又有第三方工具改写了别的条目，`restore` 的字节级配对会判定失配并拒绝还原（保护行为）——此时请重装 `antigravity` 后再 `install`。
4. **`verify` 的校验范围与实时进程提示**：`verify` 强制校验 `app.asar` 钩子、配对备份与外置 UI 包完整性（若 `.desktop` 中显式配置了 `AGY_UI_BUNDLE`，同时校验该路径可达；未配置 `.desktop` 不视为错误）；若后台已有旧 `language_server` 进程在运行，`live proc` 行会显示当前进程是否已挂载 `--web_bundle_path`。

---

## 4. 支持范围与状态契约（Support Scope）

本节明确“本工具保证什么”与“明确不做什么”，避免把有意的工程边界误判为隐式承诺。

### 4.1 已验证环境

| 项目 | 状态 |
|---|---|
| 平台 | Linux x86-64（已实测验证） |
| Antigravity | 当前 `main` 主线：`2.31.0-1` / `CL 1017595969`（Electron `44.9.1`）；其他客户端版本请切换至仓库对应 Tag |
| Node.js | `>= 18`（仅使用内置标准库 API） |
| 运行依赖 | 仅 Node.js 标准库，无第三方 npm 依赖 |

### 4.2 补丁对象与前端结构

- 仅替换 ASAR 中的固定普通打包条目 `dist/languageServer.js`；绝不修改 `language_server` 二进制。
- 5 处前端补丁依赖当前已验证的结构签名（自动捕获 Closure Compiler 重命名的局部变量与函数名）。若上游改动了目标函数的真实语法结构导致匹配数不为 `1`，工具会 fail-closed 退出（退出码 `3`）；唯一例外是当未来上游在 `buildBindings` 中已恢复非空原生 `contextUsageIndicator` 且同时重构了内部会话 Hook 时，默认 `custom` 模式会安全退让保留上游原生组件。
- 底部开关选择器组件（`EGb()`）采用“严格结构扫描 + 嵌套 `function` 声明安全网”：遇到注释（`//`、`/*`）或无法明确判定为除法的 `/` 一律拒绝。该扫描器并非完整 JS 词法解析器，仅面向当前已验证的编译组件结构设计。

### 4.3 ASAR / ZIP 格式范围

- ASAR 支持当前 Chromium Pickle 归档格式及 `unpacked`、`link` 条目的原样保留；不支持将 `link` 节点作为替换目标。
- ZIP 支持单卷非加密的 `STORE (0)` / `DEFLATE (8)` 及流式 data descriptor 标志；不支持 ZIP64、分卷/多盘、加密或数字签名扩展。单条目上限 `128 MiB`、整包解压预算 `512 MiB`。
- ZIP 条目名拒绝空段、`.` 段、`..`、前导 `/` 与反斜线；按规范化路径去重并拦截文件/目录同名冲突（如 `a` 与 `a/`）。

### 4.4 桌面启动器 `Exec=` 只读解析范围

- 本工具所有子命令均**只读检查、绝不改写** `~/.local/share/applications/antigravity.desktop`，仅在 `makePaths()`（供 `repair` 自动跟随自定义路径）与 `verify` 中使用 `analyseDesktopExec()` 读取用户可能配置的 `AGY_UI_BUNDLE=<dir>`。
- 解析时按 **GKeyFile 字符串层反转义**（`keyFileUnescapeValue()`）→ **Desktop Entry `Exec` 参数分词与去引号**（`tokenizeDesktopExec()` / `unquoteDesktopExecToken()`，含 `%%` → `%`）两层顺序解码。
- 支持识别 `env` / `/usr/bin/env` 前缀下的标准选项（`-i`/`--ignore-environment`、`-0`/`--null`、`-v`/`--debug`、`-u`/`--unset`、`-C`/`--chdir`、`--`）与程序名前的 `NAME=value` 赋值（程序名之后的同形参数按普通程序参数忽略）；若用户使用了 `env -S` 或自定义 shell 包装器，`verify` 仅作信息提示而不报错阻断。

### 4.5 路径与权限边界

- 普通用户的授权根（`$HOME`、`--ui-dir`）可以是符号链接：工具将其解析一次到物理根，此后根以下出现任何符号链接均中止写入。
- Pacman Hook 的 Root 脚本审计拒绝词法路径上的任何符号链接，并在 `realpath` 解析后的物理祖先链上逐级复核 `uid === 0` 且 `mode & 0o022 === 0`。上述非竞争路径检查不等同于操作系统内核级无 TOCTOU 保证。

### 4.6 持久化与并发边界

- `2.31` 桌面端持久层由上游内置 `clientStorageFeature`（`fgd(window.nativeStorage)` → `~/.config/Antigravity/app_storage.json`）通过 `flushDelayer` 合并落盘；本工具直接绑定该 `storageService` 的同步缓存与 `onDidChange` 事件流，并在主 Mendel 请求前通过 `__agyHydrateDevStorage`（`2000ms` 超时保护 + `8000ms` 桥接宽限期）预热内存覆盖表，不引入竞争写入器。
- 不保证跨窗口 / 跨 renderer 的事务强一致性（宿主内置 `StorageManager` 采用全表 read-modify-write 实现）。在无 `window.nativeStorage` 的纯浏览器环境下，自动回退至同源 `window.localStorage`。

### 4.7 账号与实验表解析语义

- 主通道（`Ola()`）与次级通道（`Qt().getMendelFlags`）共用 `__agyResolveExperiments()` 与 `__agyNormalizeMendel()`：
  - **服务端成功返回非空数组**：更新 `__agyLastGood` 并原样保留线上实验表，仅确保 `FLAGS`（`enable-developer-mode` 与 `enable-context-usage-indicator`）开启；
  - **服务端成功返回空数组 `[]`**（含网关模式常见响应 `{"experimentConfig":{}}`）：视为服务端撤回实验表，清空 `__agyLastGood` 并采用静态观测基线（`41 + 7`）；若外层 `experimentConfig` 缺失，按未知/异常响应保留上一次缓存；
  - **RPC 请求抛出异常**：两条通道均捕获异常并回退至 `__agyLastGood`（从未成功拉取过实时表时回退静态基线）。

### 4.8 退出码契约

| 退出码 | `antigravity_uipatch.mjs` 含义 | `verify_live.mjs` 含义 |
|---:|---|---|
| `0` | 命令成功完成；或 `verify` 确认 `app.asar` 钩子、配对备份与外置 UI 包全部健康 | 全部在线 HTTP / Connect RPC 与 10 项静态包内断言通过 |
| `1` | `verify` 判定存在健康问题（钩子缺失、备份失配、UI 包异常或 `.desktop` 显式指向不存在的目录），或目标不可写等运行期错误 | 在线断言不匹配或 HTTP / RPC 响应失败 |
| `2` | 命令行参数错误、目标账号非法（如解析到 UID 0）或 Hook 脚本路径未通过 Root 审计 | 命令行参数非法，或独立引擎启动失败 |
| `3` | 安全或兼容性故障闭合拒绝（锚点失配、V8 语法失败、CRC32/ZIP 异常、不可信备份、非空提取目录、符号链接拦截等） | — |

### 4.9 发布物范围

本仓库仅包含原创脚本、自动化测试与技术文档，以及为定点修补所需的少量原厂代码锚点字符串与默认免责声明基线载荷；**绝不分发**提取出的 Antigravity Web UI 编译资源。
