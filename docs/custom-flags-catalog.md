# 技术参考：Antigravity 桌面端实验特性开关全景目录（含 Google 原生账号实测状态、网关默认基线与微调建议）

> **数据来源与对应版本**：
> 1. **前端门控静态全量提取**：由 [`tools/inspect_flags.mjs`](../tools/inspect_flags.mjs) 从 `antigravity 2.35.0-1`（`Built at CL: 1028447422`）内嵌 Web UI（`main.js`）只读提取，共识别出 **28 处直读 / 次级 Mendel 字面量调用点（按 `reader+key` 去重后为 25 组，覆盖 23 个唯一实验键）** 与 **106 个 `FeatureManagerV2` `customFlag` 门控开关**。历史版本的开关目录可在仓库对应 Tag（如 `v2.29`、`v2.31`、`v2.31-ctxui`）中查阅。
> 2. **Google OAuth 原生账号线上实测快照**：基线状态采集自隔离 Google 原生账号线上 `GetMendelFlags` 响应快照（共下发 **384** 项实验配置），覆盖当前脚本内置的全部 **`41` 项前端布尔基线**与 **`7` 项字符串/整数载荷基线**（其中部分旧标志如 `enable-aux-pane-redesign`、`enable-jetbox-terminal-v2`、`enable-split-view`、`remove-conversation-history` 等已在 `2.35.0-1` 转正为默认常驻，基线仍保留它们以兼容 `2.31`–`2.34`）；`2.31+` / `2.35` 新引入且未重新采集线上 OAuth 快照的开关在表中单独标为 `🆕 2.31+ 新增` 或 `🆕 2.35 新增`。
> 3. **`antigravity-uipatch` 默认基线与持久化策略**：
>    - **企业网关 / 离线模式（`GetMendelFlags` 返回空表 `{}`）**：主/次双通道共用 `__agyResolveExperiments()` 清空旧缓存并默认注入实测观测到的 Google 原生账号线上开启项（`41` 项前端布尔开关 + `7` 项参数配置）及 **`enable-developer-mode` + `enable-context-usage-indicator`**（在 `2.35.0-1` 的 `106` 项 `customFlag` 中合计 **`21` 项默认开启**，初始面板显示 `0 overrides`）；
>    - **Google OAuth 原生账号模式（`GetMendelFlags` 非空）**：原样保留云端实时下发的完整实验表，仅额外开启 **`enable-developer-mode` 与 `enable-context-usage-indicator`**（单次拉取异常时自动保留 last-known-good）；
>    - **跨随机端口与重装软件包持久化**：所有在 `Settings -> Developer` 中的手动增减均经 `clientStorageFeature`（底层 `window.nativeStorage`）落盘至 `~/.config/Antigravity/app_storage.json`，并通过本工具绑定同步至全部直读与次级通道。

---

## 1. 默认基线、持久化机制与个性化微调指南

在应用 `antigravity-uipatch` 后，企业网关模式开箱即拥有与 Google 原生账号**一致的默认功能集**（`Extensions` 插件面板、Git Diff 审查、PDF / Notebook 渲染、内置浏览器、全文搜索、快捷键自定义、生成式 UI 等均已默认就绪；内置 `Terminal`、多标签右侧栏与分屏在 `2.35.0-1` 已由上游转正常驻，在 `2.31`–`2.34` 则由本工具基线自动补齐），同时解锁了 **`Settings -> Developer -> Custom Flags`** 可视化控制面板。

因此，你无需手动逐个勾选基础功能，只需在此一致基线之上按个人习惯做少量加减微调：
- **手动开启额外实验项**（在面板中显示为 `forced on`）；
- **手动关闭某项原生默认项**（在面板中显示为 `forced off`，直读通道与 `FeatureManagerV2` 均实时双向生效）；
- **持久化与一键重置**：所有手动覆盖自动保存在 `~/.config/Antigravity/app_storage.json` 的 `jetski.developer.customFlagOverrides` 键中，客户端重启或通过 Pacman 升级/重装均自动恢复；随时点击面板右上角 **`Reset overrides`** 即可清空本地覆盖，回归纯净的原生基线 + 解锁项；
- **查看本机实时列表**：由于上游各版本开关增删较快，随时可运行 `node tools/inspect_flags.mjs` 提取当前已安装客户端的完整实时清单。

### 1.1 推荐按需增减的微调清单

> [!TIP]
> **上下文用量与推理遥测指示器：`enable-context-usage-indicator`**
> 在 `antigravity 2.30+`（截至实测 `2.35.0-1`）外部发行版（`appType: "external"`）中，Google 将 `buildBindings.contextUsageIndicator`（连同 `codeSearch`、`enhancedFileViewer`）置为了 `void 0` 并剔除了原版实现。本工具通过第 5 处结构化补丁向该插槽挂载了增强指示器组件 `__AgyContextIndicator`，同时默认开启 `enable-context-usage-indicator` 并自动恢复 `Settings -> Appearance -> Chat Layout -> Context and Quota Indicator` 开关（支持查看 `TokenType` 细分占比，以及 `Last Turn` 与全会话 `Σ Session · N turns` 两组 `4×2` 指标：`Input` / `Output`、`Cache hit` / `Response`、`In speed` / `Out speed` 与 `t/s [Off | Turn | Avg]` 底栏常驻开关、`TTFT` / `Duration` 及报错重试角标）。其余两项（`enable-code-search-palette` 与 `enable-enhanced-file-viewer`）仍为空壳，开启不生效。

#### 值得手动添加尝鲜的加分项（默认关闭）
- **`enable-bottom-terminal-panel`**：允许在多标签右侧栏架构下将内置终端停靠在底部面板
- **`enable-file-explorer-tab`**：启用独立原生文件树标签页
- **`enable-file-viewer-keyboard-navigation`**：原生文件查看器键盘快捷导航
- **`enable-conversation-forking`** + **`enable-fork-at-historical-step`**：支持从任意历史步骤分叉（Fork）派生新会话
- **`configure-artifact-width`**：开放外观设置中的 Artifact 排版宽度调节
- **`enable-browser-element-picker`** / **`enable-composer-connectors`**：内置浏览器 DOM 元素点选引用与底部输入栏 Connectors 入口
- **`enable-sidebar-redesign`** / **`enable-sidebar-inbox-mode`** / **`enable-move-conversation-to-project`**（`2.35` 新增）：新版左侧栏布局、收件箱视图与跨项目移动会话

#### 明确避坑提醒（切勿开启）
- **切勿开启 `project-4k`、`enable-project-4k`、`cli-hosted-session`、`enable-workspace-scoped-jetski-extension` 或 `enterprise-disabled`**：这些开关属于裁剪版宿主皮肤、简化模式或反向禁用标志，开启后会隐藏项目页、详细推理步骤乃至 `Settings -> Developer` 入口本身（若不慎误触导致面板隐藏，可在 `~/.config/Antigravity/app_storage.json` 中删除 `jetski.developer.customFlagOverrides` 字段后重启恢复）。

---

## 2. 直读 `MendelExperimentProvider` 与次级通道开关（23 个字面量键 / 25 组 `reader+key` / 28 处调用点）

除 `FeatureManagerV2` 的 `customFlag` 体系外，前端还通过 `rj()`、`dcd()`（`rj` 响应式 Hook）、`qj()`、`TZ()`、`UZ()`、`sj()` 与 `experiments[]` 直接读取 `GetMendelFlags` 返回结果（其中 `enable-developer-mode` 同时被 `rj` 与 `qj` 读取，`max-media-attachments` 同时被 `UZ` 与 `experiments[]` 读取，合计 28 处字面量调用点、25 组 `reader+key` 组合、23 个唯一字面量实验键）。

本工具在网关模式下已将其中 **全部 Google 原生开启项 1:1 注入基线**，且所有布尔读取器（`rj` / `dcd` / `qj` / `TZ`）均已接入 `__agyOvr()`，支持通过 `Custom Flags` 面板及 `app_storage.json` 实时双向覆盖：

| 读取通道（`2.35` 符号） | 实验开关名（`keyString`） | Google 原生实测快照 | 本工具网关默认基线 | 控制的前端功能与覆盖说明 |
|---|---|---|---|---|
| `rj` + `qj`（响应式+同步布尔） | **`enable-developer-mode`** | ❌ 关闭 | 🟢 **默认开启（解锁项）** | `Settings -> Developer` 与开发模式相关早/晚双阶段门控 |
| `rj`（响应式布尔） | **`enable-ui-sidecars`** | ✅ **开启** | 🟢 **默认开启** | 右上角 `+ -> Extensions` 子菜单及 `sidecar://` 面板总门控 |
| `rj`（响应式布尔） | **`enable-sidecars`** | ✅ **开启** | 🟢 **默认开启** | 前端 `subscribeToSidecars` 实时状态流订阅开关 |
| `rj`（响应式布尔） | `jetski-sidecar-declared-permissions` | ✅ **开启** | 🟢 **默认开启** | Sidecar 插件声明式权限展示（`showDeclaredPermissions`） |
| `rj`（响应式布尔） | `enable-audio-transcription` | ✅ **开启** | 🟢 **默认开启** | 语音输入 Worklet 转写开关 |
| `rj`（响应式布尔） | `permission-v2` | ✅ **开启** | 🟢 **默认开启** | 项目级 V2 权限模型与状态同步检查 |
| `dcd`（`rj` 布尔 Hook） | `deprecate-workflows` | ✅ **开启** | 🟢 **默认开启** | 旧版 Workflows 迁移提示与兼容收敛逻辑 |
| `dcd`（`rj` 布尔 Hook） | `enable-trajectory-debug-in-battle-mode` | ❌ 关闭 | ⚪ 默认关闭 | 对战评测（Battle Mode）下的轨迹调试侧边视图 |
| `qj`（同步布尔） | `enable-notifications-settings` | ✅ **开启** | 🟢 **默认开启** | 桌面通知设置同步检查（与同名 `customFlag` 联动） |
| `qj`（同步布尔） | `enable-input-draft-persistence` | ❌ 关闭 | ⚪ 默认关闭 | 输入框草稿同步持久化实验开关 |
| `TZ`（次级 RPC 布尔） | `enable-browser-subagent-v2` | ✅ **开启** | 🟢 **默认开启** | 新版浏览器子代理（Browser Subagent v2）前端协同门控 |
| `TZ`（次级 RPC 布尔） | `jetski-generative-ui` | ✅ **开启** | 🟢 **默认开启** | 对话内联生成式交互组件（Generative UI）挂载支持 |
| `TZ`（次级 RPC 布尔） | `cortex-snapshot-revert` | ❌ 关闭 | ⚪ 默认关闭 | 会话回退（Rewind）时的文件快照回滚实验文案与控制 |
| `UZ` + `experiments[]` | `max-media-attachments` | ✅ **开启**（`"15"`） | 🟢 **默认注入 `"15"`** | 单条消息允许添加的媒体附件数量上限（未注入时回退默认值较低） |
| `UZ`（次级整数参数） | `max-best-of-n` | ✅ **开启**（`"10"`） | 🟢 **默认注入 `"10"`** | Best-of-N 并行采样最大分支数上限（代码硬编码回退值为 `8`） |
| `UZ`（次级整数参数） | `best-of-nudge-length-threshold` | ✅ **开启**（`"150"`） | 🟢 **默认注入 `"150"`** | 触发 Best-of-N 提示的输入字符长度阈值 |
| `UZ`（次级整数参数） | `best-of-nudge-dismiss-cooldown-days` | 🆕 2.35 新增 | ⚪ 默认不注入 | 关闭 Best-of-N 提示后的冷却天数（缺省代码回退值为 `10` 天） |
| `UZ`（次级整数参数） | `battle-mode-max-turns` | ✅ **开启**（`"0"`） | 🟢 **默认注入 `"0"`** | 对战模式最大轮数上限（`"0"` 表示不限制） |
| `sj`（字符串载荷） | `agy-hub-announcement-message` | ✅ **开启**（`""`） | 🟢 **默认注入 `""`** | 顶部全局公告横幅文案（空字符串表示不展示横幅） |
| `sj`（字符串载荷） | `best-of-n-default-model-id` | ✅ **开启**（`""`） | 🟢 **默认注入 `""`** | Best-of-N 默认指定模型 ID（空字符串表示跟随当前模型） |
| `sj`（字符串载荷） | `third-party-tools-disclaimer-text` | ✅ **开启**（JSON） | 🟢 **默认注入原生 JSON** | 第三方插件市场连接时的隐私与免责声明标准文案 |
| `sj`（字符串载荷） | `project-4k-mode-copy` | 🆕 2.31+ 新增 | ⚪ 默认不注入 | Project 4K 模式界面自定义说明文案（缺省使用内置默认文案） |
| `sj`（字符串载荷） | `orchestrator-model-roles` | 🆕 2.35 新增 | ⚪ 默认不注入 | 编排器 / 执行器模型角色分组配置 JSON（缺省使用内置默认配置） |

---

## 3. `FeatureManagerV2` 全部 106 项 `customFlag` 实测状态、默认基线与微调建议

以下按功能域完整列出 `antigravity 2.35.0-1` 中的全部 **106** 项 `customFlag`（`16 + 21 + 32 + 37 = 106`；本工具网关基线在其中默认开启 `19` 项 Google 原生基线项 + `enable-developer-mode` + `enable-context-usage-indicator`，共 **`21` 项默认开启**）。

> **图例说明**：
> - **Google 原生实测快照**：`✅ 开启`（`disabled: false`） / `❌ 关闭`（`disabled: true`） / `⚪ 未下发`（不在 384 项快照中，等效关闭） / `🆕 2.31+ 新增` / `🆕 2.35 新增`（尚未重新采集对应版本 OAuth 线上快照）
> - **本工具默认状态**：`🟢 默认开启（解锁项）` / `🟢 默认开启（原生基线）` / `⚪ 默认关闭`

### 3.1 核心工作台、文件、终端与版本控制（16 项）

| `customFlag` 名称 | Google 原生实测 | 本工具默认状态 | 门控特性键 | 微调建议与功能说明 |
|---|---|---|---|---|
| **`enable-developer-mode`** | ❌ 关闭 | 🟢 **默认开启（解锁项）** | `developerMode` | **保持开启**：解锁 `Settings -> Developer -> Custom Flags` 面板（已启用原生防锁死保护） |
| **`enable-bottom-terminal-panel`** | ❌ 关闭 | ⚪ 默认关闭 | `auxPaneComponent` | **推荐按需开启**：支持将内置终端停靠在底部面板 |
| **`enable-file-explorer-tab`** | ❌ 关闭 | ⚪ 默认关闭 | `fileExplorerTab` | **按需开启**：启用独立原生文件树标签页 |
| **`enable-git-vcs-ui`** | ✅ **开启** | 🟢 **默认开启（原生基线）** | `gitVcsUiStrategy` | **保持开启**：右侧栏 Git 工作区变更 Diff 与分支对比视图 |
| **`enable-pdf-viewer`** | ✅ **开启** | 🟢 **默认开启（原生基线）** | `pdfViewer` | **保持开启**：右侧栏原生 PDF 文档预览器 |
| **`enable-notebook-rendering`** | ✅ **开启** | 🟢 **默认开启（原生基线）** | `notebookRendering` | **保持开启**：右侧栏原生 Jupyter Notebook（`.ipynb`）渲染 |
| `enable-enhanced-file-viewer` | 🆕 2.31+ 新增 | ⚪ 默认关闭 | `enhancedFileViewer`, `fileTokenization`, `toggleFileWordWrap` | ⚠️ **外部包空壳**：`buildBindings.enhancedFileViewer` 为 `void 0`，开启不生效 |
| `enable-file-viewer-keyboard-navigation` | ❌ 关闭 | ⚪ 默认关闭 | `fileViewerKeyboardNavigation` | **推荐按需开启**：原生文件查看器键盘快捷导航支持 |
| `enable-catch-file-viewer` | ⚪ 未下发 | ⚪ 默认关闭 | `fileViewerComponent` | 保持默认关闭：替代版实验性文件查看器组件 |
| `enable-code-search-palette` | ❌ 关闭 | ⚪ 默认关闭 | `codeSearchPalette` | ⚠️ **外部包空壳**：依赖的 `buildBindings.codeSearch` 为 `void 0`，开启不生效 |
| `enable-pane-selection-actions` | ❌ 关闭 | ⚪ 默认关闭 | `paneSelectionActions` | **按需尝鲜**：右侧栏选中文本后的快捷引用/操作浮条 |
| `enable-open-with` | 🆕 2.35 新增 | ⚪ 默认关闭 | `defaultHandlers`, `openWith` | **按需尝鲜**：启用「用外部应用打开（Open With）」与默认打开方式设置 |
| `enable-jj-vcs-ui` | ❌ 关闭 | ⚪ 默认关闭 | `jjVcsUiStrategy` | 本地仓库使用 Jujutsu（`jj`）版本控制时可手动开启 |
| `enable-permissioned-github` | ❌ 关闭 | ⚪ 默认关闭 | `githubSettings` | 需细粒度 GitHub 仓库授权管理页时可按需尝试 |
| `enable-github-decorator` | ❌ 关闭 | ⚪ 默认关闭 | `decorators` | 对话内 GitHub 链接富文本内联装饰器 |
| `enable-resource-manager` | ❌ 关闭 | ⚪ 默认关闭 | `runningItems` | 按需尝鲜：解锁 `Settings -> Running` 后台运行项管理页 |

### 3.2 对话交互、侧栏布局、搜索与排版（21 项）

| `customFlag` 名称 | Google 原生实测 | 本工具默认状态 | 门控特性键 | 微调建议与功能说明 |
|---|---|---|---|---|
| **`enable-conversation-search-v2`** | ✅ **开启** | 🟢 **默认开启（原生基线）** | `conversationSearchV2` | **保持开启**：会话内全文关键词搜索 v2 |
| **`enable-conversation-navigator-chapter-titles`** | ✅ **开启** | 🟢 **默认开启（原生基线）** | *(inline)* | **保持开启**：对话跳转导航条自动展示阶段章节标题 |
| **`enable-context-menu-system`** | ✅ **开启** | 🟢 **默认开启（原生基线）** | `contextMenuSystem` | **保持开启**：应用级统一深色自定义右键菜单 |
| **`jetski-generative-ui`** | ✅ **开启** | 🟢 **默认开启（原生基线）** | `generativeUi` | **保持开启**：对话内联生成式交互组件（Generative UI）支持（与次级 `TZ` 联动） |
| **`enable-context-usage-indicator`** | ❌ 关闭 | 🟢 **默认开启（解锁项）** | `contextUsageIndicator`, `contextUsageIndicatorEnabled` | **默认已挂载增强指示器 `__AgyContextIndicator`**：恢复 `Appearance -> Chat Layout` 开关，展示上下文 `TokenType` 细分及 `Last Turn` / `Σ Session · N turns` 双 `4×2` 遥测（`Input`/`Output`/`Cache hit`/`Response`/`In speed`/`Out speed`/`t/s [Off\|Turn\|Avg]`/`TTFT`/`Duration` 与报错重试角标） |
| `enable-sidebar-redesign` | 🆕 2.35 新增 | ⚪ 默认关闭 | `sidebarRedesign` | **按需尝鲜**：启用新版左侧边栏重构界面与配套快捷键 |
| `enable-sidebar-inbox-mode` | 🆕 2.35 新增 | ⚪ 默认关闭 | `sidebarInboxMode` | **按需尝鲜**：左侧边栏启用收件箱（Inbox）会话视图切换 |
| `enable-sidebar-inbox-mode-default` | 🆕 2.35 新增 | ⚪ 默认关闭 | `sidebarInboxModeDefault` | 实验项：将左侧边栏默认视图设为收件箱模式（配合上一项使用） |
| `enable-conversation-groups` | ❌ 关闭 | ⚪ 默认关闭 | `conversationGroups` | **按需尝鲜**：左侧边栏会话自定义分组整理 |
| `enable-move-conversation-to-project` | 🆕 2.35 新增 | ⚪ 默认关闭 | `moveConversationToProject` | **按需尝鲜**：支持将已有对话移动到其他项目工作区 |
| `enable-conversation-forking` | ❌ 关闭 | ⚪ 默认关闭 | *(inline)* | **推荐按需开启**：允许将当前会话分支派生（Fork）为新会话 |
| `enable-fork-at-historical-step` | ❌ 关闭 | ⚪ 默认关闭 | *(inline)* | **推荐按需开启**：支持从任意历史步骤节点处分叉新会话（配合上一项） |
| `enable-fork-in-new-worktree` | ❌ 关闭 | ⚪ 默认关闭 | *(inline)* | **按需尝鲜**：分叉会话时支持自动创建独立 Git Worktree |
| `enable-side-question-rework` | ❌ 关闭 | ⚪ 默认关闭 | `sideQuestionRework` | **按需尝鲜**：新版侧边轻量追问（Side Question）交互 |
| `enable-input-autocomplete` | ❌ 关闭 | ⚪ 默认关闭 | *(inline)* | **按需尝鲜**：底部输入框内联自动补全建议 |
| `enable-paste-text-as-snippet` | ❌ 关闭 | ⚪ 默认关闭 | *(inline)* | **按需尝鲜**：粘贴长文本时自动折叠为代码片段附件块 |
| `enable-help-slash-command` | 🆕 2.31+ 新增 | ⚪ 默认关闭 | *(inline)* | **按需尝鲜**：启用输入框 `/help` 斜杠命令交互支持 |
| `configure-artifact-width` | ❌ 关闭 | ⚪ 默认关闭 | `markdownConfiguration` | **推荐按需开启**：在外观设置中开放 Artifact 视图排版宽度调节 |
| `markdown-virtualize-long-documents` | 🆕 2.31+ 新增 | ⚪ 默认关闭 | `markdownConfiguration` | **按需尝鲜**：对超长 Markdown 文档启用虚拟滚动优化 |
| `enable-text-transitions` | ❌ 关闭 | ⚪ 默认关闭 | *(inline)* | 按需开启：流式回复文本渐显平滑动画 |
| `enable-resume-conversations-from-restart` | ❌ 关闭 | ⚪ 默认关闭 | `resumeConversationsFromRestart` | 按需开启：客户端重启后提示恢复上次中断的运行态会话 |

### 3.3 插件、MCP、浏览器、权限、语音与通用设置（32 项）

| `customFlag` 名称 | Google 原生实测 | 本工具默认状态 | 门控特性键 | 微调建议与功能说明 |
|---|---|---|---|---|
| **`enable-plugins`** | ✅ **开启** | 🟢 **默认开启（原生基线）** | `plugins` | **保持开启**：插件市场与已安装插件管理总开关 |
| **`enable-plugin-auth`** | ✅ **开启** | 🟢 **默认开启（原生基线）** | `pluginAuth` | **保持开启**：插件外部账号连接与鉴权面板支持 |
| **`enable-mcp-plugin-auth`** | ✅ **开启** | 🟢 **默认开启（原生基线）** | `mcpPluginAuth` | **保持开启**：MCP 服务插件 OAuth / 凭据鉴权流程支持 |
| **`enable-hub-builtin-browser`** | ✅ **开启** | 🟢 **默认开启（原生基线）** | *(inline)* | **保持开启**：右侧栏 `+ -> Browser` 内置网页预览标签页 |
| **`enable-auto-permission-preset`** | ✅ **开启** | 🟢 **默认开启（原生基线）** | `additionalPermissionPresets` | **保持开启**：权限预设档位新增智能 `Auto` 模式 |
| **`enable-permissions-selector`** | ✅ **开启** | 🟢 **默认开启（原生基线）** | *(inline)* | **保持开启**：底部输入栏快捷权限档位切换器 |
| **`enable-keybinding-customization`** | ✅ **开启** | 🟢 **默认开启（原生基线）** | `keybindings` | **保持开启**：解锁 `Settings -> Shortcuts` 全局快捷键自定义页 |
| **`enable-notifications-settings`** | ✅ **开启** | 🟢 **默认开启（原生基线）** | `notificationsSettings` | **保持开启**：解锁 `Settings -> Notifications` 桌面通知设置页 |
| `enable-composer-connectors` | 🆕 2.31+ 新增 | ⚪ 默认关闭 | `composerConnectors` | **按需尝鲜**：在底部输入栏启用外部连接器（Connectors）快捷入口 |
| `enable-marketplace-card-status` | 🆕 2.31+ 新增 | ⚪ 默认关闭 | `marketplaceCardStatus` | **按需尝鲜**：展示插件市场卡片连接/安装实时状态标记 |
| `enable-marketplace-new-badge` | 🆕 2.35 新增 | ⚪ 默认关闭 | `customizations` | 按需尝鲜：在插件市场新上架条目上展示 `New` 角标 |
| `enable-plugin-ranking` | 🆕 2.35 新增 | ⚪ 默认关闭 | `customizations` | 按需尝鲜：面向外部用户启用插件市场排序展示（`rankedMarketplace`） |
| `enable-mcp-oauth-redirect` | 🆕 2.31+ 新增 | ⚪ 默认关闭 | `mcpOAuthRedirect` | 按需开启：启用 MCP 插件 OAuth 本地回调跳转支持 |
| `enable-plugin-bundles` | ❌ 关闭 | ⚪ 默认关闭 | `customizations` | **按需尝鲜**：`Customizations` 面板中显示插件组合包管理 |
| `enable-plugin-sidebar-section` | ❌ 关闭 | ⚪ 默认关闭 | `pluginSidebarSection` | **按需尝鲜**：左侧栏显示 `Extensions` 分区（仅安装含 `SIDEBAR` 入口插件时可见） |
| `enable-sidecar-pill-auto-open` | ❌ 关闭 | ⚪ 默认关闭 | `sidecarPillAutoOpen` | **按需尝鲜**：对话输出 `sidecar://` 快捷胶囊时自动展开右侧对应面板 |
| `enable-plugin-card-auto-resume` | ❌ 关闭 | ⚪ 默认关闭 | `pluginCardAutoResume` | 按需开启：从对话内插件推荐卡片安装插件后自动恢复 Agent 执行 |
| `enable-plugin-context-providers` | ❌ 关闭 | ⚪ 默认关闭 | `pluginContextProviders` | 按需开启：允许插件注册自定义 `@` 上下文引用提供器 |
| `enable-plugin-themes` | ❌ 关闭 | ⚪ 默认关闭 | *(inline)* | 按需开启：支持插件提供自定义界面主题包 |
| `enable-conversation-scoped-permissions` | ❌ 关闭 | ⚪ 默认关闭 | `conversationScopedPermissions` | 按需开启：单会话级细粒度工具权限控制 |
| `enable-browser-element-picker` | 🆕 2.31+ 新增 | ⚪ 默认关闭 | `browserElementPicker` | **按需尝鲜**：内置浏览器标签页 DOM 元素点选引用工具 |
| `enable-browser-site-data-controls` | 🆕 2.35 新增 | ⚪ 默认关闭 | `browserSiteDataControls` | **按需尝鲜**：内置浏览器站点数据（Cookie / 存储）清理与管理控件 |
| `enable-browser-subagent-inline-pdf` | 🆕 2.35 新增 | ⚪ 默认关闭 | `browserSubagentInlinePdf` | 实验项：允许浏览器子代理在 Electron 内联渲染 PDF 页面 |
| `enable-browser-subagent-url-binding` | 🆕 2.31+ 新增 | ⚪ 默认关闭 | `browserSubagentUrlBinding` | 实验项：浏览器子代理 URL 绑定联动支持 |
| `enable-browser-subagent-webmcp` | 🆕 2.31+ 新增 | ⚪ 默认关闭 | `browserSubagentWebviewScript` | 实验项：浏览器子代理内嵌 Webview WebMCP 支持 |
| `enable-browser-subagent-webview` | ❌ 关闭 | ⚪ 默认关闭 | `browserSubagentWebview` | 实验项：浏览器子代理内嵌 Webview 渲染（需与下方两项配套） |
| `enable-browser-subagent-webview-script` | ❌ 关闭 | ⚪ 默认关闭 | `browserSubagentWebviewScript` | 实验项：浏览器子代理内嵌 Webview 脚本注入 |
| `enable-browser-subagent-webview-ux` | ❌ 关闭 | ⚪ 默认关闭 | `browserSubagentWebviewUx` | 实验项：浏览器子代理内嵌 Webview 交互工具栏 |
| `enable-dictation-rework` | 🆕 2.35 新增 | ⚪ 默认关闭 | `dictationLanguages`, `dictationRework` | 按需尝鲜：新版语音听写交互与识别语言设置项 |
| `enable-orchestrator-model-selection` | 🆕 2.35 新增 | ⚪ 默认关闭 | *(inline)* | 实验项：开放编排器（Orchestrator）独立模型选择设置项 |
| `context-window-selector` | ❌ 关闭 | ⚪ 默认关闭 | `contextWindowSelector` | 保持默认关闭：前端上下文档位选择器（网关模型目录或 `context-unlock` 已在后端直接接管上限） |
| `disable-mcp-app-frame-mounter` | ⚪ 未下发 | ⚪ 默认关闭 | `mcpAppFrameMounter` | **保持默认关闭**：反向排障开关（开启反而会禁用 MCP 交互面板挂载） |

### 3.4 内部专有基建、远程通道、平台限定与裁剪皮肤（37 项）

本组包含两类开关：
- 前 **4 项**在 Google 原生账号下为 `✅ 开启`，本工具为保持 **1:1 原生基线一致性**同样默认开启（均受云端中继或父级环境约束，在网关或离线模式下自动静默无副作用）；
- 后 **33 项**在 Google 原生账号下处于关闭、未下发或为后续版本新增的专用宿主/平台限定开关，本工具默认保持关闭（其中裁剪皮肤与企业禁用开关标有 **⛔ 切勿开启**）。

| `customFlag` 名称 | Google 原生实测 | 本工具默认状态 | 门控特性键 | 微调建议与行为说明 |
|---|---|---|---|---|
| `enable-remote-ai` | ✅ **开启** | 🟢 **默认开启（原生基线）** | *(inline)* | 无需改动：云端远程触发器入口（网关模式下无云端远程会话后端，不产生副作用） |
| `remote-control-setting-enabled` | ✅ **开启** | 🟢 **默认开启（原生基线）** | `remoteControl` | 无需改动：移动端远程控制配对设置页（需 Google OAuth 云端中继配合） |
| `enable-remote-control-audio-transcription` | ✅ **开启** | 🟢 **默认开启（原生基线）** | `inputComponent` | 无需改动：远程控制通道语音转写支持 |
| `enable-voice-relay` | ✅ **开启** | 🟢 **默认开启（原生基线）** | *(inline)* | 无需改动：原生语音中继通道开关 |
| `project-4k` | ⚪ 未下发 | ⚪ 默认关闭 | `verboseConversationSteps` | ⛔ **切勿开启**：强制切入简化版 Project 4K 皮肤，隐藏详细推理步骤与开发者面板 |
| `enable-project-4k` | ❌ 关闭 | ⚪ 默认关闭 | `project4kSettings` | ⛔ **切勿开启**：暴露 Project 4K 简化模式切换入口 |
| `cli-hosted-session` | ⚪ 未下发 | ⚪ 默认关闭 | `commandSetupScript`, `contextUsageIndicator`, `inputComponent`, `labs` | ⛔ **切勿开启**：面向 CLI 托管内嵌视图的裁剪模式 |
| `enable-workspace-scoped-jetski-extension` | ⚪ 未下发 | ⚪ 默认关闭 | `settings` | ⛔ **切勿开启**：面向 IDE 插件宿主的单工作区裁剪模式（会隐藏项目导航页） |
| `enterprise-disabled` | 🆕 2.31+ 新增 | ⚪ 默认关闭 | `loginOptions` | ⛔ **切勿开启**：禁用企业登录选项的内部反向门控标志 |
| `cde` | 🆕 2.31+ 新增 | ⚪ 默认关闭 | `loginOptions` | 保持默认关闭：云端开发环境（Cloud Dev Environment）专用宿主标志 |
| `enable-enterprise-remote-ai` | 🆕 2.35 新增 | ⚪ 默认关闭 | *(inline)* | 保持默认关闭：企业云端远程触发器入口（需企业云端后端配合） |
| `enable-agy-hub-cua-macos` | 🆕 2.35 新增 | ⚪ 默认关闭 | `computerPermissions`, `customSidePanels` | 保持默认关闭：仅针对 macOS（`os: ["darwin"]`）Electron 宿主的计算机操作权限与侧板 |
| `windows-titlebar-redesign` | 🆕 2.35 新增 | ⚪ 默认关闭 | `desktopWindow`, `sidebarComponent` | 保持默认关闭：仅针对 Windows（`os: ["windows"]`）Electron 宿主的标题栏重构 |
| `enable-jetski-chat` | ❌ 关闭 | ⚪ 默认关闭 | `defaultHandlers` | 保持默认关闭：`Settings -> Jetski Chat` 内部页（额外受 `userCohort: ["google"]` 限制） |
| `enable-abfs-workspace-ui` | ❌ 关闭 | ⚪ 默认关闭 | `abfsWorkspaceUi` | 保持默认关闭：Google 内部 ABFS 虚拟文件系统工作区专用 |
| `enable-fork-in-new-abfs-workspace` | ❌ 关闭 | ⚪ 默认关闭 | *(inline)* | 保持默认关闭：Google 内部 ABFS 分叉工作区专用 |
| `enable-fork-in-new-citc-workspace` | ❌ 关闭 | ⚪ 默认关闭 | *(inline)* | 保持默认关闭：Google 内部 CitC（Clients in the Cloud）工作区专用 |
| `enable-critique-decorator` | ❌ 关闭 | ⚪ 默认关闭 | `decorators` | 保持默认关闭：Google 内部 Critique 代码评审链接装饰器 |
| `enable-critique-preview` | ❌ 关闭 | ⚪ 默认关闭 | `critiquePreview` | 保持默认关闭：Google 内部 Critique 变更预览面板 |
| `enable-chatski-connect-page` | ❌ 关闭 | ⚪ 默认关闭 | `chatskiConnectPage` | 保持默认关闭：内部连接引导页 |
| `google-workspace-mentions` | ❌ 关闭 | ⚪ 默认关闭 | *(inline)* | 保持默认关闭：Google Workspace 文档 `@` 引用（需企业云端目录授权） |
| `enable-upload-html-artifact-to-drive` | ❌ 关闭 | ⚪ 默认关闭 | `uploadHtmlArtifactToDrive` | 保持默认关闭：上传 HTML 产物至 Google Drive（需对应 OAuth 作用域） |
| `enable-remote-conversation-preview` | 🆕 2.31+ 新增 | ⚪ 默认关闭 | `remoteConversationBrowserPane` | 保持默认关闭：云端远程容器会话浏览器预览面板开关 |
| `enable-remote-conversation-side-question` | 🆕 2.31+ 新增 | ⚪ 默认关闭 | `remoteConversationCapabilities` | 保持默认关闭：云端远程容器会话侧边追问能力开关 |
| `enable-remote-conversation-terminal` | ❌ 关闭 | ⚪ 默认关闭 | `remoteConversationCapabilities` | 保持默认关闭：云端远程容器会话终端开关 |
| `enable-voice-remote` | ❌ 关闭 | ⚪ 默认关闭 | `remoteConversationCapabilities` | 保持默认关闭：云端远程会话语音交互开关 |
| `enable-voice-remote-control` | ❌ 关闭 | ⚪ 默认关闭 | `inputComponent` | 保持默认关闭：移动端远程控制语音输入开关 |
| `enable-battle-mode` | ❌ 关闭 | ⚪ 默认关闭 | `battleModeFeature` | 保持默认关闭：模型双盲对战评测（Arena）专用模式 |
| `enable-battle-contrib-variants` | ❌ 关闭 | ⚪ 默认关闭 | `battleHarnesses` | 保持默认关闭：对战评测内部变体配置 |
| `enable-conversation-sharing-prototype` | ❌ 关闭 | ⚪ 默认关闭 | `conversationSharing` | 保持默认关闭：早期会话链接分享原型 |
| `enable-role-onboarding` | ❌ 关闭 | ⚪ 默认关闭 | `onboarding` | 保持默认关闭：首次启动角色调查引导页 |
| `show-all-models-in-gemini-app` | ❌ 关闭 | ⚪ 默认关闭 | `models` | 保持默认关闭：仅针对 `gemini-app` 宿主变体生效 |
| `enable-gil-logging` | ❌ 关闭 | ⚪ 默认关闭 | `gilLogging` | 保持默认关闭：Google 内部交互遥测日志（GIL） |
| `enable-per-conversation-telemetry-toggle` | ❌ 关闭 | ⚪ 默认关闭 | `conversationTelemetryToggle` | 保持默认关闭：单会话遥测上报调试开关 |
| `enable-trajectory-debug-tools` | ⚪ 未下发 | ⚪ 默认关闭 | `trajectoryDebugTools` | 保持默认关闭：内部 Agent 轨迹调试工具栏 |
| `labs-concierge-agent` | ⚪ 未下发 | ⚪ 默认关闭 | `conciergeAgent` | 保持默认关闭：Labs 礼宾代理实验项 |
| `labs-inline-actions` | ⚪ 未下发 | ⚪ 默认关闭 | `inlineActions` | 保持默认关闭：Labs 内联快捷动作实验项 |
