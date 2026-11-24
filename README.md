# antigravity-uipatch

面向 **Antigravity 桌面端（Linux）** 的零依赖前端解锁与增强工具：补齐企业网关模式下被隐藏的原生工作台界面，开放 `Settings -> Developer` 实验开关面板并支持持久化保存，同时在输入框右下角新增**上下文用量与输出速率指示器**。

---

## 核心功能

- **补齐企业网关模式缺失界面**：未登录 Google OAuth（启用 `gateway.enabled: true`）时自动注入 Google 原生账号默认功能集，恢复右上角 `Extensions`、Git Diff 审查、PDF / Notebook 预览、内置浏览器、快捷键自定义、生成式 UI 等受实验表门控的原生界面（在 `2.31`–`2.34` 等旧版中亦一并恢复内置 `Terminal` 与多标签右侧栏）。
- **开放 `Settings -> Developer` 并跨升级持久化**：任意登录模式下均可打开实验特性控制面板，修复原版候选框在 Chromium 下白底且无法滚动的问题；所有开关微调实时生效并保存在 `~/.config/Antigravity/app_storage.json`，重启与升级软件包均不丢失。
- **新增上下文用量与输出速率指示器**：在输入框右下角添加圆环百分比按钮，点击即可查看上下文构成明细，以及最近一轮（`Last Turn`）与整场对话（`Σ Session`）的输入/输出 Token 用量、缓存命中率、吞吐速率、首字延迟与耗时统计（右上角支持通过 `t/s [Off | Turn | Avg]` 切换底栏速率显示）：
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
- **零外部依赖、不改动引擎二进制**：仅需 Node.js `>= 18` 标准库；**完全不修改 `language_server` 二进制**（可与 [`antigravity-context-unlock`](https://github.com/MatrixC7/antigravity-context-unlock) 无冲突共存），仅在 `app.asar` 注入 5 行环境变量判断逻辑来按需加载外置 UI，不传环境变量即按原厂默认界面启动。

---

## 版本要求与兼容性

- **当前 `main` 分支适用范围**：`antigravity >= 2.31.0`（Linux x86-64，已实测覆盖 **`2.31.0-1` 至 `2.35.0-1` / `CL 1028447422`**）。补丁基于容忍折行的语法结构匹配，自动适配 Closure Compiler 标识符重命名与词法边界换行，上游未重构相关前端逻辑的后续版本均可直接使用；若未来版本发生不兼容变动，旧版脚本将归档至仓库 Tags，`main` 则跟进新版。
- **未测中间版本与旧版说明**：由于并未对上游每个小版本逐一实测，当两次实测版本之间出现过前端变动时，无法精确标定变动始于哪个具体版本号。**实际可用性可直接以本机运行 `self-test`（纯只读、零修改）的结果为准**：自检通过即可安全安装；若因客户端版本较旧导致自检不通过，请在仓库 Tags 中切换至接近的历史标签（如 `v2.29`、`v2.31`、`v2.31-ctxui`）后再试。
- **运行环境**：Node.js `>= 18`（仅使用内置标准库，无第三方依赖）

---

## 快速开始

```bash
git clone https://github.com/MatrixC7/antigravity-uipatch.git ~/antigravity-uipatch
cd ~/antigravity-uipatch

# 1. 只读自检（校验本机归档完整性、补丁锚点与语法解析，不修改任何文件）
node antigravity_uipatch.mjs self-test

# 2. 安装补丁（若 /opt/Antigravity 归属当前用户可去掉 sudo 与 --user "$USER"）
sudo node antigravity_uipatch.mjs install --user "$USER"

# 3. 验证安装状态（确认输出 PATCHED、pairs: yes、align: matches）
node antigravity_uipatch.mjs verify
```

> [!IMPORTANT]
> **`install` 不会自动修改你的桌面启动器文件**。安装完成后，启动 Antigravity 时需手动传入环境变量 `AGY_UI_BUNDLE` 才会加载外置修补 UI（不传该变量则直接运行原厂内置 UI）：
> - **终端启动**：
>   ```bash
>   AGY_UI_BUNDLE="$HOME/.local/share/antigravity-externalui" antigravity
>   ```
> - **桌面图标（`.desktop` 文件）启动**：直接编辑 `~/.local/share/applications/antigravity.desktop` 中的 `Exec=` 行（若该文件不存在，可先启动一次 Antigravity 使其自动创建，或在系统应用菜单右键「编辑应用程序」生成；若仍未生成，再从 `/usr/share/applications/antigravity.desktop` 复制过来并注意赋予当前用户读写权限）。注意 `.desktop` 中不展开 `$HOME`，请填写实际绝对路径：
>   ```ini
>   Exec=env AGY_UI_BUNDLE=/home/<你的用户名>/.local/share/antigravity-externalui /usr/bin/antigravity %U
>   ```

---

## 日常升级与卸载还原

系统每次升级 `antigravity` 软件包后，请同步更新外置 UI，避免旧版前端搭配新版后端：

```bash
# 软件包升级后一键同步（保留你在 app_storage.json 中的全部开关与指示器偏好）
sudo node ~/antigravity-uipatch/antigravity_uipatch.mjs sync --user "$USER"
```

<details>
<summary><b>可选：配置 Arch Linux / Pacman 升级自动同步 Hook</b></summary>

将单文件脚本安装至 `root:root` 只读目录并生成 `PostTransaction` Hook，此后 `pacman -Syu` 升级 `antigravity` 时将自动完成同步：

```bash
sudo install -D -o root -g root -m 0755 \
  ~/antigravity-uipatch/antigravity_uipatch.mjs \
  /usr/local/share/antigravity-uipatch/antigravity_uipatch.mjs

sudo node /usr/local/share/antigravity-uipatch/antigravity_uipatch.mjs pacman-hook \
  --user "$USER" \
  --script-path /usr/local/share/antigravity-uipatch/antigravity_uipatch.mjs \
  --write /etc/pacman.d/hooks/99-antigravity-uipatch.hook
```
</details>

```bash
# 卸载还原：校验配对备份后原子还原原版 app.asar（若手动改过 .desktop 可自行删去环境变量）
sudo node ~/antigravity-uipatch/antigravity_uipatch.mjs restore --user "$USER"
```

常用的其余子命令包括 `repair`（不触碰 `app.asar`，仅重新提取并修补外置 UI）与 `extract <dir>`（导出未修补的原厂前端资源）；所有命令均支持 `--dry-run` 零写入预演。完整参数说明见 [《CLI 命令参考、安全机制与支持契约》](docs/cli-and-support-scope.md)。

---

## 文档导航

详细使用指南、遥测指标解释、开关目录与底层逆向报告均收纳于 [`docs/`](docs/) 目录：

| 文档 | 内容概要 |
|---|---|
| **[《原理与使用指南》](docs/overview-and-guide.md)** | 三层架构通俗导读、**上下文与输出速率指示器各指标定义与实机现象问答**（完成态快照、Prefix KV 缓存分母、`TTFT` 与上下文长度、工具调用突发 `Out speed`、双列表懒加载） |
| **[《实验特性开关全景目录》](docs/custom-flags-catalog.md)** | `2.35.0-1` 全部 **106 项 `customFlag`** 与 **23 个直读实验键**的线上基线状态、推荐加分项与避坑提醒 |
| **[《CLI 命令参考、安全机制与支持契约》](docs/cli-and-support-scope.md)** | 全部子命令与全局选项、验证与扫描工具（`verify_live.mjs` / `inspect_flags.mjs` / 离线单测套件）、安全边界与退出码契约 |
| **[《补丁架构与脚本实现详解》](docs/patch-internals.md)** | 尾部追加式无损 ASAR 打包、内嵌 ZIP 解析、`main.js` 五处结构化汇聚点补丁与 `language_server` 遥测逆向细节 |
| **[《Mendel 门控取证报告》](docs/mechanism-mendel-gating.md)** | 前端三轨门控调用链、Google OAuth 384 项线上快照对比、8 条候选注入路径实测与 Electron Fuses 分析 |

---

## 配套项目与致谢

本项目与以下同系列仓库职责正交，可独立或组合使用：

- **[`antigravity-context-unlock`](https://github.com/MatrixC7/antigravity-context-unlock)**：解除 Antigravity 桌面端 `language_server` 在 Google OAuth 原生通道下的 256K 本地上下文自动压缩限制。
- **[`agy-context-unlock`](https://github.com/MatrixC7/agy-context-unlock)**：解除命令行工具 `antigravity-cli`（`/usr/bin/agy`）的 256K 本地上下文压缩限制并恢复 `/model` 与 `settings.json` 持久化闭环。

在机制逆向、全路径实测取证、零依赖脚本实现、多轮评审迭代、自动化测试与中文技术文档撰写中，主要工作由以下大语言模型协作完成：**Gemini 4 Carbon**、**Gemini 4 Neon**、**DeepSeek V4.1 Flash 1017** 与 **GPT 6 Astra**；仓库维护者提供了问题定义、实机网关测试环境与架构取舍决策。谨致谢意。

---

## 许可证

本项目基于 [MIT License](LICENSE) 发布（仅涵盖本仓库内的原创脚本、测试与文档代码；运行期在本机提取的 Antigravity Web UI 资源归属 Google 所有，永不随本仓库分发）。
