# 技术参考：Antigravity 桌面端实验特性开关全景目录（含 Google 原生账号实测状态、网关默认基线与微调建议）

> **数据来源与对应版本**：
> 1. **前端门控静态全量提取**：由 [`tools/inspect_flags.mjs`](../tools/inspect_flags.mjs) 从 `antigravity 2.31.0-1`（`Built at CL: 1017595969`）内嵌 Web UI（`main.js`）只读提取，共识别出 **27 处直读 / 次级 Mendel 字面量调用点（按 `reader+key` 去重后为 24 组，覆盖 23 个唯一实验键；另有 `enable-aux-pane-redesign` 经辅助函数间接传入同步读取器 `Hi`）** 与 **107 个 `FeatureManagerV2` `customFlag` 门控开关**。
> 2. **Google OAuth 原生账号线上实测快照**：基线状态采集自隔离 Google 原生账号线上 `GetMendelFlags` 响应快照（共下发 **384** 项实验配置），并在 `2.31.0-1` 中逐键比对核实：全部 **`41` 项前端启用布尔开关**与 **`7` 项启用字符串/整数载荷配置**在 `2.31.0-1` 中均 100% 完整保留；`2.31` 新增的开关在表中单独标为 `🆕 2.31 新增`。
> 3. **`antigravity-uipatch` 默认基线与持久化策略**：
>    - **企业网关 / 离线模式（`GetMendelFlags` 返回空表 `{}`）**：主/次双通道共用 `__agyResolveExperiments()` 清空旧缓存并默认注入实测观测到的 Google 原生账号线上开启项（`41` 项前端布尔开关 + `7` 项参数配置）及 **`enable-developer-mode`**（在 107 项 `customFlag` 中合计 **`32` 项默认开启**，初始面板显示 `0 overrides`）；
>    - **Google OAuth 原生账号模式（`GetMendelFlags` 非空）**：原样保留云端实时下发的完整实验表，仅额外开启 **`enable-developer-mode`**（单次拉取异常时自动保留 last-known-good）；
>    - **跨随机端口与重装软件包持久化**：所有在 `Settings -> Developer` 中的手动增减均经 `clientStorageFeature`（底层 `window.nativeStorage`）落盘至 `~/.config/Antigravity/app_storage.json`，并通过本工具绑定同步至全部直读与次级通道。

---

## 1. 默认基线、持久化机制与个性化微调指南

在应用 `antigravity-uipatch` 后，企业网关模式开箱即拥有与 Google 原生账号**完全一致的默认功能集**（内置终端 `Terminal`、多标签右侧栏、`Extensions` 插件面板、Git Diff 审查、PDF / Notebook 渲染、对话分屏、全文搜索与导航、快捷键自定义等均已默认就绪），同时解锁了 **`Settings -> Developer -> Custom Flags`** 可视化控制面板。

因此，你**不再需要手动逐个勾选基础功能**，只需在此一致基线之上按个人习惯做少量加减微调：
- **手动开启额外实验项**（在面板中显示为 `forced on`）；
- **手动关闭某项原生默认项**（在面板中显示为 `forced off`，直读通道与 `FeatureManagerV2` 均实时双向生效）；
- **持久化与一键重置**：所有手动覆盖自动保存在 `~/.config/Antigravity/app_storage.json` 的 `jetski.developer.customFlagOverrides` 键中，客户端重启或通过 Pacman 升级/重装均自动恢复；随时点击面板右上角 **`Reset overrides`** 即可清空本地覆盖，瞬间回归纯净的 Google 原生基线 + `enable-developer-mode`。

### 1.1 右侧边栏（Auxiliary Pane）两种形态切换

- **形态 A：现代多标签页右侧栏（当前开箱默认，与 Google 原生账号一致）**
  - **`enable-aux-pane-redesign` 默认已开启**：右侧栏采用类似浏览器的 `sidePanelV2` 多标签页布局，右上角提供 `+` 下拉菜单（含 `Open File`、`New Terminal`、`Browser`、`Extensions`）与 `Overview` 总览面板（其 `Files` 行内建工作区目录树），支持 `Ctrl+T` / `Ctrl+Shift+T` / `` Ctrl+Shift+` `` 快捷键。
  - **可选加配**：若偏好类似 VS Code 将终端停靠在窗口底部的布局，可在面板底部向上展开的候选框中搜索添加 **`enable-bottom-terminal-panel`**。
- **形态 B：经典常驻四图标栏（轻量直觉形态）**
  - **切换方式**：在 `Custom Flags` 列表中将 **`enable-aux-pane-redesign` 拨为关闭**（标记 `forced off`），并在底部候选框搜索添加 **`enable-file-explorer-tab`**（标记 `forced on`）。
  - **界面表现**：右侧栏顶部直接常驻显示 `Overview`、`File Explorer`（独立原生文件树标签）、`Review`、`Terminal` 四个固定图标，单击一键切换。

### 1.2 推荐按需增减的微调清单

#### 值得手动添加尝鲜的加分项（Google 原生账号与本工具基线默认均关闭）
- **`enable-context-usage-indicator`**：对话界面原生上下文窗口用量指示器
- **`enable-bottom-terminal-panel`**：允许将内置终端停靠在底部面板（配合形态 A 使用）
- **`enable-file-explorer-tab`**：经典四图标栏下的独立文件树图标（配合关闭 `enable-aux-pane-redesign` 的形态 B 使用）
- **`enable-code-search-palette`**：工作区代码搜索命令面板
- **`enable-file-viewer-keyboard-navigation`**：原生文件查看器键盘快捷导航
- **`enable-conversation-forking`** + **`enable-fork-at-historical-step`**：支持从任意历史步骤分叉（Fork）派生新会话
- **`configure-artifact-width`** / **`markdown-table-v2`**：开放外观设置中的 Artifact 排版宽度调节与新版 Markdown 表格渲染

#### 可按个人喜好手动关闭的原生默认项
- **`remove-conversation-history`**（Google 原生与本工具基线默认开启）：Google 原生账号默认开启该项以隐藏左侧栏扁平历史会话列表（仅按 Project 分组展示会话）。若你更喜欢保留完整的独立历史会话列表入口，直接在 `Custom Flags` 中将其**拨为关闭**（`forced off`）即可永久生效。

#### 明确避坑提醒（切勿开启）
- **切勿开启 `project-4k`、`enable-project-4k`、`cli-hosted-session` 或 `enable-workspace-scoped-jetski-extension`**：这些开关属于裁剪版宿主皮肤或简化模式，开启后会隐藏项目页、详细推理步骤乃至 `Settings -> Developer` 入口本身（若不慎误触导致面板隐藏，可在 `~/.config/Antigravity/app_storage.json` 中删除 `jetski.developer.customFlagOverrides` 字段后重启恢复）。

---

## 2. 直读 `MendelExperimentProvider` 与次级通道开关（23 个字面量键 / 24 组 `reader+key` / 27 处调用点）

除 `FeatureManagerV2` 的 `customFlag` 体系外，前端还通过 `Ii()`、`CKc()`（`Ii` 响应式 Hook）、`Hi()`、`IT()`、`JT()`、`Ji()` 与 `experiments[]` 直接读取 `GetMendelFlags` 返回结果（其中 `max-media-attachments` 同时被 `JT` 与 `experiments[]` 读取，合计 27 处字面量调用点、24 组 `reader+key` 组合、23 个唯一字面量实验键；此外 `enable-aux-pane-redesign` 在启动早期经辅助函数 `gtd()` 动态传入 `Hi()`）。

本工具在网关模式下已将其中 **全部 Google 原生开启项 1:1 注入基线**，且所有布尔读取器（`Ii` / `CKc` / `Hi` / `IT`）均已接入 `__agyOvr()`，支持通过 `Custom Flags` 面板及 `app_storage.json` 实时双向覆盖：

| 读取通道（`2.31` 符号） | 实验开关名（`keyString`） | Google 原生实测快照 | 本工具网关默认基线 | 控制的前端功能与覆盖说明 |
|---|---|---|---|---|
| `Ii`（响应式布尔） | **`enable-ui-sidecars`** | ✅ **开启** | 🟢 **默认开启** | 右上角 `+ -> Extensions` 子菜单及 `sidecar://` 面板总门控 |
| `Ii`（响应式布尔） | **`enable-sidecars`** | ✅ **开启** | 🟢 **默认开启** | 前端 `subscribeToSidecars` 实时状态流订阅开关 |
| `Ii`（响应式布尔） | `jetski-sidecar-declared-permissions` | ✅ **开启** | 🟢 **默认开启** | Sidecar 插件声明式权限展示（`showDeclaredPermissions`） |
| `Ii`（响应式布尔） | `sidecar-iframe-prewarm` | ✅ **开启** | 🟢 **默认开启** | 右侧栏 Sidecar `<iframe>` 后台预热加载 |
| `Ii`（响应式布尔） | `scheduled-tasks-v2` | ✅ **开启** | 🟢 **默认开启** | 左侧栏定时任务升级为新版 Automations 视图 |
| `Ii`（响应式布尔） | `enable-audio-transcription` | ✅ **开启** | 🟢 **默认开启** | 语音输入 Worklet 转写开关 |
| `Ii`（响应式布尔） | `permission-v2` | ✅ **开启** | 🟢 **默认开启** | 项目级 V2 权限模型与状态同步检查 |
| `CKc`（`Ii` 布尔 Hook） | `deprecate-workflows` | ✅ **开启** | 🟢 **默认开启** | 旧版 Workflows 迁移提示与兼容收敛逻辑 |
| `CKc`（`Ii` 布尔 Hook） | `enable-trajectory-debug-in-battle-mode` | ❌ 关闭 | ⚪ 默认关闭 | 对战评测（Battle Mode）下的轨迹调试侧边视图 |
| `Hi`（同步布尔） | `enable-notifications-settings` | ✅ **开启** | 🟢 **默认开启** | 桌面通知设置同步检查（与同名 `customFlag` 联动） |
| `Hi`（同步布尔） | `enable-input-draft-persistence` | ❌ 关闭 | ⚪ 默认关闭 | 输入框草稿同步持久化实验开关 |
| `IT`（次级 RPC 布尔） | `enable-browser-subagent-v2` | ✅ **开启** | 🟢 **默认开启** | 新版浏览器子代理（Browser Subagent v2）前端协同门控 |
| `IT`（次级 RPC 布尔） | `jetski-generative-ui` | ✅ **开启** | 🟢 **默认开启** | 对话内联生成式交互组件（Generative UI）挂载支持 |
| `IT`（次级 RPC 布尔） | `cortex-snapshot-revert` | ❌ 关闭 | ⚪ 默认关闭 | 会话回退（Rewind）时的文件快照回滚实验文案与控制 |
| `IT`（次级 RPC 布尔） | `enable-jetski-chat` | ❌ 关闭 | ⚪ 默认关闭 | `Settings -> Jetski Chat` 内部页（额外受 `userCohort === "google"` 限制） |
| `JT` + `experiments[]` | `max-media-attachments` | ✅ **开启**（`"15"`） | 🟢 **默认注入 `"15"`** | 单条消息允许添加的媒体附件数量上限（未注入时回退默认值较低） |
| `JT`（次级整数参数） | `max-best-of-n` | ✅ **开启**（`"10"`） | 🟢 **默认注入 `"10"`** | Best-of-N 并行采样最大分支数上限（代码硬编码回退值为 `8`） |
| `JT`（次级整数参数） | `best-of-nudge-length-threshold` | ✅ **开启**（`"150"`） | 🟢 **默认注入 `"150"`** | 触发 Best-of-N 提示的输入字符长度阈值 |
| `JT`（次级整数参数） | `battle-mode-max-turns` | ✅ **开启**（`"0"`） | 🟢 **默认注入 `"0"`** | 对战模式最大轮数上限（`"0"` 表示不限制） |
| `Ji`（字符串载荷） | `agy-hub-announcement-message` | ✅ **开启**（`""`） | 🟢 **默认注入 `""`** | 顶部全局公告横幅文案（空字符串表示不展示横幅） |
| `Ji`（字符串载荷） | `best-of-n-default-model-id` | ✅ **开启**（`""`） | 🟢 **默认注入 `""`** | Best-of-N 默认指定模型 ID（空字符串表示跟随当前模型） |
| `Ji`（字符串载荷） | `third-party-tools-disclaimer-text` | ✅ **开启**（JSON） | 🟢 **默认注入原生 JSON** | 第三方插件市场连接时的隐私与免责声明标准文案 |
| `Ji`（字符串载荷） | `project-4k-mode-copy` | 🆕 2.31 新增 | ⚪ 默认不注入 | Project 4K 模式界面自定义说明文案（缺省使用内置默认文案） |

---

## 3. `FeatureManagerV2` 全部 107 项 `customFlag` 实测状态、默认基线与微调建议

以下按功能域完整列出 `antigravity 2.31.0-1` 中的全部 **107** 项 `customFlag`（`17 + 23 + 28 + 39 = 107`；本工具网关基线默认开启其中 `31` 项 Google 原生开启项 + `enable-developer-mode`，共 **`32` 项默认开启**）。

> **图例说明**：
> - **Google 原生实测快照**：`✅ 开启`（`disabled: false`） / `❌ 关闭`（`disabled: true`） / `⚪ 未下发`（不在 384 项快照中，等效关闭） / `🆕 2.31 新增`（`2.31.0-1` 新引入的前端门控）
> - **本工具默认状态**：`🟢 默认开启（解锁项）` / `🟢 默认开启（原生基线）` / `⚪ 默认关闭`

### 3.1 核心工作台、文件、终端与版本控制（17 项）

| `customFlag` 名称 | Google 原生实测 | 本工具默认状态 | 门控特性键 | 微调建议与功能说明 |
|---|---|---|---|---|
| **`enable-developer-mode`** | ❌ 关闭 | 🟢 **默认开启（解锁项）** | `developerMode` | **保持开启**：解锁 `Settings -> Developer -> Custom Flags` 面板（已启用原生防锁死保护） |
| **`enable-jetbox-terminal-v2`** | ✅ **开启** | 🟢 **默认开启（原生基线）** | `terminalFeature` | **保持开启**：启用内置终端（`New Terminal` 与 `` Ctrl+Shift+` ``） |
| **`enable-aux-pane-redesign`** | ✅ **开启** | 🟢 **默认开启（原生基线）** | `auxPaneComponent` 等 | **形态 A 保持开启 / 形态 B 手动关闭**：开启时使用 V2 多标签右侧栏；关闭并配合 `enable-file-explorer-tab` 可切回经典常驻四图标栏 |
| **`enable-bottom-terminal-panel`** | ❌ 关闭 | ⚪ 默认关闭 | *(inline)* | **推荐按需开启**：支持在 V2 右侧栏形态下将内置终端停靠在底部面板 |
| **`enable-file-explorer-tab`** | ❌ 关闭 | ⚪ 默认关闭 | `fileExplorerTab` | **形态 B 推荐开启**：关闭 `enable-aux-pane-redesign` 时，在右侧栏顶部常驻渲染原生文件树图标 |
| **`enable-git-vcs-ui`** | ✅ **开启** | 🟢 **默认开启（原生基线）** | `gitVcsUiStrategy` | **保持开启**：右侧栏 Git 工作区变更 Diff 与分支对比视图 |
| **`enable-pdf-viewer`** | ✅ **开启** | 🟢 **默认开启（原生基线）** | `pdfViewer` | **保持开启**：右侧栏原生 PDF 文档预览器 |
| **`enable-notebook-rendering`** | ✅ **开启** | 🟢 **默认开启（原生基线）** | `notebookRendering` | **保持开启**：右侧栏原生 Jupyter Notebook（`.ipynb`）渲染 |
| `enable-enhanced-file-viewer` | 🆕 2.31 新增 | ⚪ 默认关闭 | `enhancedFileViewer`, `fileTokenization` | **按需尝鲜**：启用增强型文件查看器与语法分词渲染 |
| `enable-file-viewer-keyboard-navigation` | ❌ 关闭 | ⚪ 默认关闭 | `fileViewerKeyboardNavigation` | **推荐按需开启**：原生文件查看器键盘快捷导航支持 |
| `enable-catch-file-viewer` | ⚪ 未下发 | ⚪ 默认关闭 | `fileViewerComponent` | 保持默认关闭：替代版实验性文件查看器组件 |
| `enable-code-search-palette` | ❌ 关闭 | ⚪ 默认关闭 | `codeSearchPalette` | **推荐按需开启**：工作区代码搜索命令面板 |
| `enable-pane-selection-actions` | ❌ 关闭 | ⚪ 默认关闭 | `paneSelectionActions` | **按需尝鲜**：右侧栏选中文本后的快捷引用/操作浮条 |
| `enable-jj-vcs-ui` | ❌ 关闭 | ⚪ 默认关闭 | `jjVcsUiStrategy` | 本地仓库使用 Jujutsu（`jj`）版本控制时可手动开启 |
| `enable-permissioned-github` | ❌ 关闭 | ⚪ 默认关闭 | `githubSettings` | 需细粒度 GitHub 仓库授权管理页时可按需尝试 |
| `enable-github-decorator` | ❌ 关闭 | ⚪ 默认关闭 | `decorators` | 对话内 GitHub 链接富文本内联装饰器 |
| `enable-resource-manager` | ❌ 关闭 | ⚪ 默认关闭 | `runningItems` | 按需尝鲜：解锁 `Settings -> Running` 后台运行项管理页 |

### 3.2 对话交互、搜索、分屏与排版（23 项）

| `customFlag` 名称 | Google 原生实测 | 本工具默认状态 | 门控特性键 | 微调建议与功能说明 |
|---|---|---|---|---|
| **`enable-split-view`** | ✅ **开启** | 🟢 **默认开启（原生基线）** | `splitView` | **保持开启**：支持会话水平 / 垂直分屏并排展示 |
| **`enable-conversation-search-v2`** | ✅ **开启** | 🟢 **默认开启（原生基线）** | `conversationSearchV2` | **保持开启**：会话内全文关键词搜索 v2 |
| **`enable-conversation-navigator`** | ✅ **开启** | 🟢 **默认开启（原生基线）** | *(inline)* | **保持开启**：长对话右侧轮次快速跳转导航条 |
| **`enable-conversation-navigator-chapter-titles`** | ✅ **开启** | 🟢 **默认开启（原生基线）** | *(inline)* | **保持开启**：对话跳转导航条自动展示阶段章节标题 |
| **`enable-conversation-selection-quoting`** | ✅ **开启** | 🟢 **默认开启（原生基线）** | *(inline)* | **保持开启**：选中模型回复片段一键引用追问 |
| **`enable-user-message-bubbles`** | ✅ **开启** | 🟢 **默认开启（原生基线）** | *(inline)* | **保持开启**：用户消息气泡化展示（若偏好纯扁平文档流可手动关闭） |
| `enable-context-menu-system` | ✅ **开启** | 🟢 **默认开启（原生基线）** | `contextMenuSystem` | **保持开启**：应用级统一深色自定义右键菜单 |
| `enable-context-usage-indicator` | ❌ 关闭 | ⚪ 默认关闭 | `contextUsageIndicator` | **推荐手动开启尝鲜**：在对话界面显示原生上下文窗口用量指示器 |
| `enable-conversation-groups` | ❌ 关闭 | ⚪ 默认关闭 | `conversationGroups` | **按需尝鲜**：左侧边栏会话自定义分组整理 |
| `enable-conversation-forking` | ❌ 关闭 | ⚪ 默认关闭 | *(inline)* | **推荐按需开启**：允许将当前会话分支派生（Fork）为新会话 |
| `enable-fork-at-historical-step` | ❌ 关闭 | ⚪ 默认关闭 | *(inline)* | **推荐按需开启**：支持从任意历史步骤节点处分叉新会话（配合上一项） |
| `enable-fork-in-new-worktree` | ❌ 关闭 | ⚪ 默认关闭 | *(inline)* | **按需尝鲜**：分叉会话时支持自动创建独立 Git Worktree |
| `enable-side-question-rework` | ❌ 关闭 | ⚪ 默认关闭 | `sideQuestionRework` | **按需尝鲜**：新版侧边轻量追问（Side Question）交互 |
| `enable-input-autocomplete` | ❌ 关闭 | ⚪ 默认关闭 | *(inline)* | **按需尝鲜**：底部输入框内联自动补全建议 |
| `enable-paste-text-as-snippet` | ❌ 关闭 | ⚪ 默认关闭 | *(inline)* | **按需尝鲜**：粘贴长文本时自动折叠为代码片段附件块 |
| `enable-help-slash-command` | 🆕 2.31 新增 | ⚪ 默认关闭 | *(inline)* | **按需尝鲜**：启用输入框 `/help` 斜杠命令交互支持 |
| `configure-artifact-width` | ❌ 关闭 | ⚪ 默认关闭 | `markdownConfiguration` | **推荐按需开启**：在外观设置中开放 Artifact 视图排版宽度调节 |
| `markdown-table-v2` | ❌ 关闭 | ⚪ 默认关闭 | `markdownConfiguration` | **推荐按需开启**：启用新版 Markdown 宽表格渲染组件 |
| `markdown-virtualize-long-documents` | 🆕 2.31 新增 | ⚪ 默认关闭 | `markdownConfiguration` | **按需尝鲜**：对超长 Markdown 文档启用虚拟滚动优化 |
| `enable-text-transitions` | ❌ 关闭 | ⚪ 默认关闭 | *(inline)* | 按需开启：流式回复文本渐显平滑动画 |
| `enable-resume-conversations-from-restart` | ❌ 关闭 | ⚪ 默认关闭 | `resumeConversationsFromRestart` | 按需开启：客户端重启后提示恢复上次中断的运行态会话 |
| `enable-thought-editing` | ❌ 关闭 | ⚪ 默认关闭 | *(inline)* | 实验项：允许手动编辑模型思考链（Thought）文本 |
| `enable-thought-steering-from-selection` | ❌ 关闭 | ⚪ 默认关闭 | *(inline)* | 实验项：选中思考链片段引导后续推理方向 |

### 3.3 插件、MCP、浏览器、权限与通用设置（28 项）

| `customFlag` 名称 | Google 原生实测 | 本工具默认状态 | 门控特性键 | 微调建议与功能说明 |
|---|---|---|---|---|
| **`enable-plugins`** | ✅ **开启** | 🟢 **默认开启（原生基线）** | `onboarding`, `plugins` | **保持开启**：插件市场与已安装插件管理总开关 |
| **`enable-plugin-auth`** | ✅ **开启** | 🟢 **默认开启（原生基线）** | `pluginAuth` | **保持开启**：插件外部账号连接与鉴权面板支持 |
| **`enable-mcp-plugin-auth`** | ✅ **开启** | 🟢 **默认开启（原生基线）** | `mcpPluginAuth` | **保持开启**：MCP 服务插件 OAuth / 凭据鉴权流程支持 |
| **`enable-hub-builtin-browser`** | ✅ **开启** | 🟢 **默认开启（原生基线）** | `browserAuxPane` | **保持开启**：右侧栏 `+ -> Browser` 内置网页预览标签页 |
| **`enable-auto-permission-preset`** | ✅ **开启** | 🟢 **默认开启（原生基线）** | `additionalPermissionPresets` | **保持开启**：权限预设档位新增智能 `Auto` 模式 |
| **`enable-permissions-selector`** | ✅ **开启** | 🟢 **默认开启（原生基线）** | *(inline)* | **保持开启**：底部输入栏快捷权限档位切换器 |
| **`enable-keybinding-customization`** | ✅ **开启** | 🟢 **默认开启（原生基线）** | `keybindings` | **保持开启**：解锁 `Settings -> Shortcuts` 全局快捷键自定义页 |
| `enable-new-themes` | ✅ **开启** | 🟢 **默认开启（原生基线）** | `theme` | **保持开启**：解锁扩展深色/浅色主题配色方案 |
| `enable-notifications-settings` | ✅ **开启** | 🟢 **默认开启（原生基线）** | `notificationsSettings` | **保持开启**：解锁 `Settings -> Notifications` 桌面通知设置页 |
| `enable-settings-error-card` | ✅ **开启** | 🟢 **默认开启（原生基线）** | `settingsErrorCard` | **保持开启**：设置页配置文件语法/加载异常诊断卡片 |
| `enable-composer-connectors` | 🆕 2.31 新增 | ⚪ 默认关闭 | `composerConnectors` | **按需尝鲜**：在底部输入栏启用外部连接器（Connectors）快捷入口 |
| `enable-marketplace-card-status` | 🆕 2.31 新增 | ⚪ 默认关闭 | `marketplaceCardStatus` | **按需尝鲜**：展示插件市场卡片连接/安装实时状态标记 |
| `enable-mcp-oauth-redirect` | 🆕 2.31 新增 | ⚪ 默认关闭 | `mcpOAuthRedirect` | 按需开启：启用 MCP 插件 OAuth 本地回调跳转支持 |
| `enable-plugin-bundles` | ❌ 关闭 | ⚪ 默认关闭 | `customizations` | **按需尝鲜**：`Customizations` 面板中显示插件组合包管理 |
| `enable-plugin-sidebar-section` | ❌ 关闭 | ⚪ 默认关闭 | `pluginSidebarSection` | **按需尝鲜**：左侧栏显示 `Extensions` 分区（仅安装含 `SIDEBAR` 入口插件时可见） |
| `enable-sidecar-pill-auto-open` | ❌ 关闭 | ⚪ 默认关闭 | `sidecarPillAutoOpen` | **按需尝鲜**：对话输出 `sidecar://` 快捷胶囊时自动展开右侧对应面板 |
| `enable-plugin-card-auto-resume` | ❌ 关闭 | ⚪ 默认关闭 | `pluginCardAutoResume` | 按需开启：从对话内插件推荐卡片安装插件后自动恢复 Agent 执行 |
| `enable-plugin-context-providers` | ❌ 关闭 | ⚪ 默认关闭 | `pluginContextProviders` | 按需开启：允许插件注册自定义 `@` 上下文引用提供器 |
| `enable-plugin-themes` | ❌ 关闭 | ⚪ 默认关闭 | `customizations` | 按需开启：支持插件提供自定义界面主题包 |
| `enable-conversation-scoped-permissions` | ❌ 关闭 | ⚪ 默认关闭 | `conversationScopedPermissions` | 按需开启：单会话级细粒度工具权限控制 |
| `enable-browser-element-picker` | 🆕 2.31 新增 | ⚪ 默认关闭 | `browserElementPicker` | **按需尝鲜**：内置浏览器标签页 DOM 元素点选引用工具 |
| `enable-browser-subagent-url-binding` | 🆕 2.31 新增 | ⚪ 默认关闭 | `browserSubagentUrlBinding` | 实验项：浏览器子代理 URL 绑定联动支持 |
| `enable-browser-subagent-webmcp` | 🆕 2.31 新增 | ⚪ 默认关闭 | `browserSubagentWebviewScript` | 实验项：浏览器子代理内嵌 Webview WebMCP 支持 |
| `enable-browser-subagent-webview` | ❌ 关闭 | ⚪ 默认关闭 | `browserSubagentWebview` | 实验项：浏览器子代理内嵌 Webview 渲染（需与下方两项配套） |
| `enable-browser-subagent-webview-script` | ❌ 关闭 | ⚪ 默认关闭 | `browserSubagentWebviewScript` | 实验项：浏览器子代理内嵌 Webview 脚本注入 |
| `enable-browser-subagent-webview-ux` | ❌ 关闭 | ⚪ 默认关闭 | `browserSubagentWebviewUx` | 实验项：浏览器子代理内嵌 Webview 交互工具栏 |
| `context-window-selector` | ❌ 关闭 | ⚪ 默认关闭 | `contextWindowSelector` | 保持默认关闭：前端上下文档位选择器（网关模型目录或 `context-unlock` 已在后端直接接管上限） |
| `disable-mcp-app-frame-mounter` | ⚪ 未下发 | ⚪ 默认关闭 | `mcpAppFrameMounter` | **保持默认关闭**：反向排障开关（开启反而会禁用 MCP 交互面板挂载） |

### 3.4 历史列表策略、内部专有基建、远程通道与裁剪皮肤（39 项）

本组包含两类开关：
- 前 **9 项**在 Google 原生账号下为 `✅ 开启`，本工具为保持 **1:1 原生基线一致性**同样默认开启（其中 **`remove-conversation-history`** 可按个人喜好手动关闭以找回独立历史列表；其余 8 项受前端 `userCohort: ["google"]`、云端中继或父级开关约束，在网关或外部账号下自动静默无副作用）；
- 后 **30 项**在 Google 原生账号下处于关闭、未下发或为 `2.31` 新增的专用宿主开关，本工具默认保持关闭（其中裁剪皮肤与企业禁用开关标有 **⛔ 切勿开启**）。

| `customFlag` 名称 | Google 原生实测 | 本工具默认状态 | 门控特性键 | 微调建议与行为说明 |
|---|---|---|---|---|
| **`remove-conversation-history`** | ✅ **开启** | 🟢 **默认开启（原生基线）** | `sidebarComponent` | **可按偏好手动关闭**：原生默认隐藏左侧独立历史会话列表（仅按 Project 归档查看）；拨为关闭（`forced off`）即可恢复完整历史会话入口 |
| `enable-fig-vcs-ui` | ✅ **开启** | 🟢 **默认开启（原生基线）** | `figVcsUiStrategy` | 无需改动（静默无害）：额外受 `userCohort: ["google"]` 限制，外部环境不激活 |
| `enable-gob-cog-vcs-ui` | ✅ **开启** | 🟢 **默认开启（原生基线）** | `gobCogVcsUiStrategy` | 无需改动（静默无害）：额外受 `userCohort: ["google"]` 限制，外部环境不激活 |
| `enable-gob-repo-vcs-ui` | ✅ **开启** | 🟢 **默认开启（原生基线）** | `gobRepoVcsUiStrategy` | 无需改动（静默无害）：额外受 `userCohort: ["google"]` 限制，外部环境不激活 |
| `enable-remote-ai` | ✅ **开启** | 🟢 **默认开启（原生基线）** | `customizations` | 无需改动：云端远程触发器入口（网关模式下无云端远程会话后端，不产生副作用） |
| `remote-control-setting-enabled` | ✅ **开启** | 🟢 **默认开启（原生基线）** | `remoteControl` | 无需改动：移动端远程控制配对设置页（需 Google OAuth 云端中继配合） |
| `enable-remote-control-audio-transcription` | ✅ **开启** | 🟢 **默认开启（原生基线）** | `inputComponent` | 无需改动：远程控制通道语音转写支持 |
| `enable-voice-relay` | ✅ **开启** | 🟢 **默认开启（原生基线）** | *(inline)* | 无需改动：原生语音中继通道开关 |
| `enable-battle-mode-custom-agents` | ✅ **开启** | 🟢 **默认开启（原生基线）** | *(inline)* | 无需改动：仅当父开关 `enable-battle-mode` 开启时生效的子选项 |
| `project-4k` | ⚪ 未下发 | ⚪ 默认关闭 | `verboseConversationSteps` | ⛔ **切勿开启**：强制切入简化版 Project 4K 皮肤，隐藏详细推理步骤与开发者面板 |
| `enable-project-4k` | ❌ 关闭 | ⚪ 默认关闭 | `project4kSettings` | ⛔ **切勿开启**：暴露 Project 4K 简化模式切换入口 |
| `cli-hosted-session` | ⚪ 未下发 | ⚪ 默认关闭 | `inputComponent` 等 | ⛔ **切勿开启**：面向 CLI 托管内嵌视图的裁剪模式 |
| `enable-workspace-scoped-jetski-extension` | ⚪ 未下发 | ⚪ 默认关闭 | `settings` | ⛔ **切勿开启**：面向 IDE 插件宿主的单工作区裁剪模式（会隐藏项目导航页） |
| `enterprise-disabled` | 🆕 2.31 新增 | ⚪ 默认关闭 | `loginOptions` | ⛔ **切勿开启**：禁用企业登录选项的内部反向门控标志 |
| `cde` | 🆕 2.31 新增 | ⚪ 默认关闭 | `loginOptions` | 保持默认关闭：云端开发环境（Cloud Dev Environment）专用宿主标志 |
| `enable-aux-pane-redesign-extension` | 🆕 2.31 新增 | ⚪ 默认关闭 | `auxPaneComponent` | 保持默认关闭：仅针对 IDE 扩展宿主（`Extension`）的 V2 辅助栏开关 |
| `enable-abfs-workspace-ui` | ❌ 关闭 | ⚪ 默认关闭 | `abfsWorkspaceUi` | 保持默认关闭：Google 内部 ABFS 虚拟文件系统工作区专用 |
| `enable-fork-in-new-abfs-workspace` | ❌ 关闭 | ⚪ 默认关闭 | *(inline)* | 保持默认关闭：Google 内部 ABFS 分叉工作区专用 |
| `enable-fork-in-new-citc-workspace` | ❌ 关闭 | ⚪ 默认关闭 | *(inline)* | 保持默认关闭：Google 内部 CitC（Clients in the Cloud）工作区专用 |
| `enable-critique-decorator` | ❌ 关闭 | ⚪ 默认关闭 | `decorators` | 保持默认关闭：Google 内部 Critique 代码评审链接装饰器 |
| `enable-critique-preview` | ❌ 关闭 | ⚪ 默认关闭 | `critiquePreview` | 保持默认关闭：Google 内部 Critique 变更预览面板 |
| `enable-chatski-connect-page` | ❌ 关闭 | ⚪ 默认关闭 | `chatskiConnectPage` | 保持默认关闭：内部连接引导页 |
| `google-workspace-mentions` | ❌ 关闭 | ⚪ 默认关闭 | *(inline)* | 保持默认关闭：Google Workspace 文档 `@` 引用（需企业云端目录授权） |
| `enable-upload-html-artifact-to-drive` | ❌ 关闭 | ⚪ 默认关闭 | `uploadHtmlArtifactToDrive` | 保持默认关闭：上传 HTML 产物至 Google Drive（需对应 OAuth 作用域） |
| `enable-remote-conversation-preview` | 🆕 2.31 新增 | ⚪ 默认关闭 | `remoteConversationBrowserPane` | 保持默认关闭：云端远程容器会话浏览器预览面板开关 |
| `enable-remote-conversation-side-question` | 🆕 2.31 新增 | ⚪ 默认关闭 | `remoteConversationCapabilities` | 保持默认关闭：云端远程容器会话侧边追问能力开关 |
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
