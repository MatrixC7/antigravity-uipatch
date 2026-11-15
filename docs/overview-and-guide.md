# 原理与使用指南：Antigravity 桌面端实验开关门控与上下文推理遥测面板

> 本文档面向希望快速理解 Antigravity 桌面端在“企业网关模式”与“Google 原生账号模式”下部分前端界面（`Extensions` 插件菜单、内置 `Terminal`、多标签右侧栏、原生 `File Explorer` 标签页、`Settings -> Developer` 面板）被隐藏的真实原因、**`2.30+` 上下文容量与双层推理遥测指示器（`Context & Inference Indicator`）的指标含义与实机读数规律**、三层解耦补丁的工作方式、跨随机端口持久化机制以及日常升级维护流程的用户与开发者。底层协议验证、字节级补丁对比与完整开关清单请参阅配套技术文档：
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

## 2. 上下文容量与推理遥测面板（`Context & Inference Indicator`）读数指南与设计解惑

在 `antigravity 2.30+ / 2.31` 外部发行版中，Google 将入口插槽 `buildBindings.contextUsageIndicator` 置为了 `void 0` 并剔除了原版组件代码。本工具通过洁净室原创组件 `__AgyContextIndicator` 恢复并大幅增强了输入框右下角的上下文圆环指示器（同时自动恢复 `Settings -> Appearance -> Chat Layout -> Context and Quota Indicator` 外观开关）。

### 2.1 面板结构一览与二维正交矩阵设计

点击输入框右下角的圆环百分比按钮（如 `◯ 64% · 145 t/s`），将展开如下三段式浮层面板：

```text
Context Window             t/s [Off | Turn | Avg]   63.6%
▓▓▓▓████████████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
500.0K / 786.4K tokens used
─────────────────────────────────────────────────────────
● Instructions & tools ▾                      20.0K · 2.5%
  │ System            13.5K   Tools                  6.5K
● Conversation                              480.0K · 61.0%
○ Available                                 286.5K · 36.4%
─────────────────────────────────────────────────────────
Last Turn                                      [↻ 1 retry]
Input             644.1K   Output                     379
Cache hit          99.0%   Response                   230
In speed      402.5K t/s   Out speed            144.5 t/s
TTFT               1.60s   Duration                 4.22s
─────────────────────────────────────────────────────────
Σ Session · 24 turns                [! 1 error] [↻ 3 retries]
Σ Input           12.45M   Σ Output                 42.8K
Σ Cache hit        95.8%   Σ Response               14.7K
Avg In speed  368.0K t/s   Avg Out speed        139.2 t/s
Avg TTFT           1.74s   Avg Duration             4.08s
```

面板排版的四项核心取舍：
1. **左入右出、同行同维的 `4×2` 二维正交矩阵**：
   - **按列划分阶段**：**左列全部属于输入预填充阶段（Prefill）**，从发了多少输入（`Input`）→ 命中多少缓存（`Cache hit`）→ 输入处理速率（`In speed`）→ 首字等待多久（`TTFT`）形成完整因果链；**右列全部属于输出解码阶段（Decode）**，从生成多少总输出（`Output`）→ 其中正文占多少（`Response`）→ 吐字速率（`Out speed`）→ 整轮耗时（`Duration`）一气呵成。
   - **按行对齐量纲**：第 1 行对比核心总量、第 2 行对比有效构成、第 3 行对比吞吐速率（同为 `t/s`）、第 4 行对比时间延迟（同为秒），消除隔行横跳与单位混排。
2. **`Σ`（累积）与 `Avg`（平均）上下分区**：在全对话汇总区中，前两行体量与构成指标统一使用 `Σ` 标记全局总和，后两行速率与耗时指标统一使用 `Avg` 标记单轮均值（不用希腊字母 `μ` 以免在 `TTFT` 旁被误读为微秒 `μs`）。
3. **`Last Turn` 与 `Σ Session · N turns` 标题呼应**：下方汇总区无需额外点击切换即可同屏纵览；标题显式冠以 `Σ` 并附带单位 `turns`，与上方的 `Last Turn` 形成“最近 1 轮 vs. 当前会话累计 `N` 轮”的明确对照，避免被误读为“第 N 号会话”。
4. **克制减法（不堆砌冗余信息）**：Google OAuth 原生通道（CCPA）不向客户端回传内部后端路由模型代号，而当前选中的前端模型与配额状态已在输入框左下角模型选择器中直接可见，因此面板不重复展示模型名徽章与配额条。

---

### 2.2 各指标精确定义与悬停提示速查表

面板中几乎所有数值均支持**鼠标悬停（Tooltip）**查看未缩写的精确整数与拆分明细：

| 区域 / 指标 | `Last Turn`（单轮口径） | `Σ Session · N turns`（全会话口径） | 鼠标悬停（Tooltip）附加明细 |
|---|---|---|---|
| **`Context Window`** | 当前上下文已用估算值 / 窗口上限（`≥80%` 自动变琥珀色告警；压缩后带 `~ Approx` 标记；`Instructions & tools` 可点击折叠） | — | 精确到个位的已用 / 上限 Token 数 |
| **`t/s [Off \| Turn \| Avg]`** | `Turn`：在底栏圆环旁实时显示 `Last Turn` 的 `Out speed`（即时感知云端快慢） | `Avg`：在底栏显示全会话稳态均值 `Avg Out speed`（平滑单轮突发）；`Off`：仅显示百分比（设置持久保存于 `app_storage.json`） | 各档位说明 |
| **`Input`** | 当轮实际发送的总 Prompt 输入（`未命中新增 + 缓存读取 + 缓存写入`） | `Σ Input`：第 `1..N` 轮累计发送的总输入 Token 数 | 缓存命中 Token 数 + 未命中新计算 Token 数拆分 |
| **`Output`** | 当轮模型总输出 Token 数（`Response + Thinking`） | `Σ Output`：第 `1..N` 轮累计总输出 Token 数 | `Response` Token 数 + `Thinking` Token 数精确拆分 |
| **`Cache hit`** | 当轮前缀缓存命中率 `cacheRead ÷ Input`（一位小数；存在未命中 Token 时封顶 `99.9%`，防虚标 `100.0%`） | `Σ Cache hit`：全会话全局命中率 `ΣcacheRead ÷ ΣInput` | 精确命中数 / 总输入数（及本轮新增未缓存数） |
| **`Response`** | 当轮正文与工具调用参数 Token 数（对应 `responseOutputTokens`，不含思考） | `Σ Response`：第 `1..N` 轮累计正文与工具 Token 数 | 精确正文 Token 数及排除的 `Thinking` Token 数 |
| **`In speed`** | 当轮等效输入吞吐速率 `Input ÷ TTFT` | `Avg In speed`：全局加权平均 `ΣInput ÷ ΣTTFT` | 精确每秒输入 Token 数 |
| **`Out speed`** | 当轮流式解码吐字速率 `Output ÷ 纯流式耗时` | `Avg Out speed`：全局加权平均 `ΣOutput ÷ Σ流式耗时` | 精确每秒输出 Token 数 |
| **`TTFT`** | 首字响应等待时间（请求发出 → 首个流式分片到达） | `Avg TTFT`：各轮首字等待时间的算术平均值 | （若部分轮次无计时则注明覆盖轮数） |
| **`Duration`** | 当轮端到端总耗时（`TTFT + 纯流式耗时`） | `Avg Duration`：单轮平均总耗时 | **全会话累计总耗时**（如 `Total observed: 1m 38s across 24 calls`） |
| **`! error` / `↻ retry`** | 当轮发生的失败报错或后端静默自动重试次数（正常为 `0` 时完全隐藏） | 全会话第 `1..N` 轮累计的报错总数与静默重试总数 | 具体报错信息，或重试次数与累计退避等待秒数 |

---

### 2.3 实机读数常见现象与深度问答

#### Q1：为什么不在模型吐字过程中实时跳表，而是等每轮完成后才整组刷新（快照机制）？
这是针对 Agent 多步工作流专门做的体验优化，原因有二：
1. **流式中途缺乏精确 Token 分母，估算会导致速率“反向衰减”假象**：服务端仅在整轮流结束的最后一个数据包才下发精确的 `ModelUsageStats`。若在流式期间用 `可见字符数 / 4 / 已流逝秒数` 配合定时器强行估算，一旦模型进入**流式生成工具调用 JSON 参数**阶段（如 `edit_file`、`run_command`，其内容不计入聊天文本字符）或思考分块缓冲间隙，就会出现“分子停滞不动、分母秒表持续累加”，导致面板上的速率肉眼可见地一路暴跌，且中英文混排按字符除以 4 误差极大。
2. **避免 Agent 连续调工具时面板频繁闪回 `—`**：在一次任务中，Agent 往往连续执行十余轮“思考 → 调工具 → 0.5 秒后立即进入下一轮调用”。若新一轮一开始就把未出结果的指标清空成 `—`，任务运行期间点开面板 90% 的时间只能看到残缺横杠。采用**完成态原子快照机制**后，面板始终稳定展示最近一轮已完成的完整精确数据（新一轮生成期间仅在 `Last Turn` 旁轻提示 `· Generating…`），待新一轮彻底完成后再一次性无感刷新。

#### Q2：这里的 `Cache hit` 指的是哪种缓存？为什么早期简单相除会出现超过 `100%` 的怪象？
1. **缓存类型**：它是大模型服务端的 **Context / Prefix KV Cache（上下文前缀缓存）**。在多轮对话或 Agent 连续工具调用中，每一轮请求都要把「系统提示词 + 工具定义 + 此前全部对话历史」重新发给模型（长对话单轮输入常达 `500K～700K` tokens）。服务端会将前序轮次算过的长前缀注意力 Key/Value 张量缓存在显存或高速缓存池中，下一轮直接复用前 `98%～99%` 的历史前缀，只需对末尾新增的几千 tokens 做预填充计算。
2. **底层字段口径**：反汇编 `language_server` 的 `genairesponse.MapUsageMetadata` 可见，后端在将 Gemini 原始返回的 `promptTokenCount`（总输入）与 `cachedContentTokenCount`（缓存命中）写入前端 `ModelUsageStats` 时，为了对齐 Anthropic 的计费字段惯例，**提前执行了减法 `inputTokens = promptTokenCount - cachedContentTokenCount`**。也就是说，`u.inputTokens` 存的只是**未命中缓存的新增输入**（例如 `6,505`），而非总输入（`644,060`）。本工具将其还原为真实总输入 `totIn = inputTokens + cacheReadTokens + cacheWriteTokens` 作分母，并在未达 100% 全命中时封顶显示 `99.9%`，确保读数真实严谨。

#### Q3：为什么即便 `99%` 命中了缓存，上下文越长时 `TTFT` 也依然会变慢？`In speed` 与 `TTFT` 该怎么配合看？
从 Transformer 推理的物理机制来看，Prefix KV Cache 省掉的是「把几十万历史 tokens 重新计算一遍 K/V 向量」的算力，但**有两笔开销依然随总上下文长度线性增长**：
1. **KV 缓存搬运开销**：几十万 tokens 对应的数 GB 乃至数十 GB 历史 KV 张量，仍需从远端缓存池或高带宽显存（HBM）加载进计算核心；
2. **交叉注意力计算（Cross-Attention）**：本轮新增的未缓存 tokens，仍需在每一层与前面全部几十万个历史 K/V 向量做注意力点积（耗时正比于 `新增长度 × 总上下文长度`）。

把左列的 **`In speed`（`Input ÷ TTFT`）**、**`TTFT`** 与 **`Cache hit`** 三者结合起来看，诊断效率极高：
- **消除长度干扰看吞吐**：上下文从 `20K` 涨到 `650K` 时，`TTFT` 从 `0.4s` 升至 `1.6s` 属于正常物理增长；此时左侧 `In speed` 高达 **`400K+ t/s`**，一眼就能确认缓存加速正在高效工作；
- **区分“缓存过期”与“服务端拥堵”**：
  - 若 `TTFT` 突然飙到 `20s`，且 `Cache hit` 掉到 **`0.0%`**、`In speed` 跌至 `20K～30K t/s` → 说明停顿超过约 5 分钟导致服务端前缀缓存过期，正在全量重算长上下文；
  - 若 `TTFT` 飙到 `15s`，但 `Cache hit` 依然高达 **`99.0%`** → 说明缓存并未失效，纯粹是当前云端推理队列正在排队拥堵。

#### Q4：为什么偶尔能看到某一轮流式生成耗时只有 `0.1～0.3s`、输出却有 100 多 tokens，导致单轮 `Out speed` 飙到近千 `t/s`？
这是由 **Gemini 服务端的工具调用整包缓冲机制（FunctionCall Buffering）** 引起的真实协议现象：
- **普通文字回复**是边生成边推送的（几个词一个 SSE 分片），因此客户端测到的「首包 → 末包」时长（`streamingDuration`）基本等于真实的逐词生成耗时（常规约 `110～180 t/s`）。
- **结构化工具调用（如 `run_command`、`read_file` 的 JSON 参数）**则不同：服务端为确保下发的工具调用 JSON 语法完整合法，会在云端把整个工具调用参数全部生成并校验完毕后，**装进单个数据包一次性推给客户端**。
- 当某一轮模型没有输出长段可见思考文本、直接发起工具调用时（例如总共输出 `138` tokens），服务端实际花掉的数秒生成时间因为尚未发出首包，**全部被计入了客户端的 `TTFT`（如 `14.35s`）**；等整包 `138` tokens 到达客户端触发“首包计时”后，仅隔 `0.15s` 就收到了流结束包，于是客户端视角下的瞬时接收速率 `138 ÷ 0.15s` 就会高达 `900+ t/s`（同理，短轮次若首包已打包大块思考文本，也会使剩余流式窗口偏短）。
- **如何看待该数值**：在 `Last Turn` 中结合 `TTFT` 与 `Duration` 对照即可一眼识别此类“整包突发轮”；而在下方的 **`Σ Session`** 中，`Avg Out speed` 采用的是 **全局总输出 ÷ 全局总流式耗时（$\sum \text{Output} \div \sum \text{StreamDur}$）** 的加权平均而非简单算术平均，因此偶发的 `0.15s` 短包突发不会拉偏整场对话的真实平均速率。底栏右上角的 **`t/s [Off | Turn | Avg]`** 开关也允许按个人偏好自由选择：想实时观察当前云端快慢选 **`Turn`**，想看平稳不跳变的长期吞吐选 **`Avg`**。

#### Q5：全会话 `Σ Session · N turns` 汇总上百轮历史记录，会不会多占内存或拖慢长对话滚动？
**完全不会。** Antigravity 在底层将对话数据拆分为体积悬殊的两份独立列表：
1. **`steps`（聊天正文与工具输出，体积大）**：包含全部对话文本、思考原文及读写文件/命令输出日志，长对话可达数十 MB。官方默认采用**最近 50 步滚动懒加载**（`startIndex: -50`），向上翻阅历史时才按需加载。**本工具对 `steps` 的懒加载策略未做任何改动**，聊天窗口流畅度与原版 100% 一致。
2. **`generatorMetadatas`（纯数字统计账本，体积微小）**：由于实时流在 `PROD_UI` 模式下会清空 `chatModel` 字段，本工具通过专用本地 RPC `getCascadeTrajectoryGeneratorMetadata` 按偏移量**增量拉取**服务端已剥离消息正文的轻量统计记录（每轮仅约百余字节，即便聊满 200 轮也仅约二三十 KB，后续每完成一轮仅增量拉取最新 1 条）。因此，哪怕经历了 `/compact` 上下文压缩、按 `Ctrl+R` 刷新或重启软件重开老对话，`Σ Session · N turns` 依然能零负担地精确还原从第 1 轮至今的全部历史数据。

---

## 3. 全景横向对比：未修补各模式 vs. 应用 `antigravity-uipatch` 后

| 对比维度 | 原版：企业网关模式 | 原版：Google OAuth 个人账号 | 应用 `antigravity-uipatch` 后（任意模式） |
|---|---|---|---|
| **默认生效的实验开关集** | 空表 `{}`（40 余项原生功能连带关闭） | 云端按账号下发基线（不含 `Developer` 页） | **网关/离线时对齐实测原生基线 + 开启 `Developer` 页；OAuth 登录时保留线上表 + 开启 `Developer` 页** |
| **`Extensions` 与内置 `Terminal`** | 隐藏 | 默认可见（位于 `+` 菜单与 V2 右侧栏） | **开箱默认可见** |
| **`Settings -> Developer` 面板** | 隐藏 | 隐藏 | **默认可见**（支持对任意开关做双向增减与一键重置） |
| **未灰度实验项（如 `fileExplorerTab`）** | 隐藏 | 隐藏 | **可在 `Developer` 面板按需添加** |
| **手动修改开关的作用范围与持久化** | — | 面板隐藏；直读开关因 `SetMendelFlagOverrides` 权限拒绝无法本地覆盖 | **全通道实时响应覆盖，保存于 `~/.config/Antigravity/app_storage.json`，重启与重装均保留** |
| **网络抖动时的实验表** | — | 原版主入口在失败时返回 `undefined`，下游保留已加载的表 | **主/次双通道在请求失败时均保留 last-known-good；服务端成功返回空表时清空旧缓存并采用静态基线** |
| **上下文容量与推理遥测指示器** | `2.30+` 外部包已剥离为 `void 0` | `2.30+` 外部包已剥离为 `void 0` | **开箱默认挂载洁净室增强版（展示 `TokenType` 细分，以及 `Last Turn` 与 `Σ Session · N turns` 双 `4×2` 遥测：`Input`/`Output`/`Cache hit`/`Response`/`In speed`/`Out speed`/`t/s [Off\|Turn\|Avg]`/`TTFT`/`Duration` 与报错重试角标）** |
| **开关候选框滚动体验** | — | 原生 `<datalist>` 弹窗白底且**无法滚动** | **深色主题向上展开，支持滚轮 / 键盘导航 / 自动滚动入视区，含 ARIA listbox 语义** |
| **误删/误覆盖防护** | — | — | **`--dry-run` 绝对零写入；`extract` 拒绝非空目录；UI 切换双失败时保留旧副本并给出恢复路径** |
| **是否修改 `language_server` 二进制** | 否 | 否 | **否**（纯内存只读提取内嵌 ZIP） |
| **临时回退原厂 UI 成本** | — | — | 执行 `disable` 移除桌面启动器环境变量即可（`verify` 识别主动 `OFF` 状态并返回 `0`） |

---

## 4. 常见注意事项与边界说明

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
