# 补丁架构与脚本实现详解（`antigravity_uipatch.mjs`）

> 本文档面向开发者、系统管理员与逆向工程研究人员，详细解析 `antigravity_uipatch.mjs` 的无依赖内部实现：包括尾部追加式 Electron ASAR 读写算法、`language_server` 双内嵌 ZIP 归档识别与纯 `node:zlib` CRC32 解压器、`main.js` 四处前端汇聚点补丁（含双通道共享实验解析器、`window.nativeStorage` 跨随机端口磁盘持久化桥接与严格结构扫描器）、统一桌面启动器解析器 `analyseDesktopExec()`、原子目录切换与备份配对状态机，以及 Pacman Hook 的 Root 权限边界设计。

---

## 1. 设计目标与工程约束

Antigravity 桌面端的界面控制逻辑位于 `language_server` 二进制内嵌的 `agy_hub_web_bundle` ZIP 归档（核心为约 11.2 MB 的压缩编译产物 `main.js`），而子进程启动参数则位于 `/opt/Antigravity/resources/app.asar` 的 `dist/languageServer.js` 中。为兼顾安全性、可维护性与多工具共存，`antigravity_uipatch.mjs` 遵循四项核心工程约束：

1. **零外部依赖（纯 Node.js 标准库）**：完全基于 `node:fs`、`node:zlib`、`node:crypto`、`node:vm` 等内置模块实现 ASAR 归档打包、ZIP 中央目录解析、DEFLATE 解压、IEEE 802.3 CRC32 校验与 JavaScript 语法树预检，不依赖任何第三方 npm 包，也不依赖外部 `/usr/bin/unzip` 或 `@electron/asar` CLI。
2. **字节级无损往返（Byte-Identical Round-Trip）**：对 `app.asar` 采用**原数据区零移动、仅尾部追加修改项**的打包算法。当替换映射为空时，`repack()` 直接返回原缓冲区（任意合法输入逐字节 100% 一致）；修改单一条目（`dist/languageServer.js`）时，原厂其余 `1,091` 个文件条目及任何前序第三方归档补丁的偏移量与字节流均分毫不差地原样保留。
3. **严格故障闭合（Fail-Closed）与 V8 语法预检**：每处前端主锚点与子锚点均要求唯一精确匹配（`occurrences === 1`）；合成后的完整 `main.js` 必须通过 `new vm.Script(output)` 的 V8 引擎语法解析校验，才会进入 `app.asar` 改写与正式目录原子切换阶段。
4. **绝不触碰 `language_server` 二进制**：仅以只读方式扫描内存缓冲区提取内嵌 Web UI，确保与修改 Go 二进制机器码的 [`antigravity-context-unlock`](https://github.com/MatrixC7/antigravity-context-unlock) 正交共存。

---

## 2. 尾部追加式 ASAR 解析与重打包器

### 2.1 ASAR 二进制布局与 Chromium Pickle 头部

Electron 的 `app.asar` 采用 Chromium Pickle 封装的定长前导头 + JSON 目录树 + 连续无填充文件数据区结构（以 Pacman `mtree` 校验通过的 `antigravity 2.29.1-1` 原厂归档为例：共 `4,797,365` 字节，注入本工具钩子后为 `4,817,088` 字节；包含 `1,092` 个文件条目，其中 `745` 个为归档内打包条目、`347` 个标记为 `unpacked: true`）：

```text
偏移区间               类型 / 内容说明
──────────────────────────────────────────────────────────────────────────
[0 .. 3]              uint32LE = 4（外层大小字段自身长度）
[4 .. 7]              uint32LE = dataOffset - 8
[8 .. 11]             uint32LE = dataOffset - 12
[12 .. 15]            uint32LE = jsonLen（UTF-8 JSON 字符串精确字节长度）
[16 .. dataOffset-1]  JSON 目录树，末尾以 0x00 补齐至 4 字节对齐边界 dataOffset
[dataOffset .. EOF]   按 offset 紧密排列的文件字节流
```

`readAsar(buf)` 在解析目录树前同时校验外层定长标记（`= 4`）、JSON 边界以及两个内层 Pickle 长度字段（`buf.readUInt32LE(4) + 8` 与 `buf.readUInt32LE(8) + 12` 必须同时等于 `dataOffset`），防止畸形头部越界读取。

### 2.2 为什么采用“尾部追加”而非“全量重排”

在 Electron `app.asar` 中：
1. `347` 个位于 `app.asar.unpacked/` 的条目在 JSON 节点中**不包含 `offset` 字段**（仅含 `size`、`unpacked: true` 与 `integrity`）；`link` 符号链接节点（`isLinkNode()`）则仅携带 `link` 字符串目标而无数据负载；
2. 原厂包内包含 `15` 组内容完全相同的重复文件，且其他第三方工具可能已在归档中写入或共享特定 `offset`。

若采用常规“解压全部文件再重新顺序打包”的做法，不仅会改变数百个无关条目的 `offset`，一旦误给 `unpacked` 条目写入 `offset: "0"` 还会使头部额外膨胀约 4.5 KB。

`repack(asar, replacements)` 采用最小扰动策略：

1. 若 `replacements.size === 0`，直接原样返回 `asar.buf`（确保包含 `link` 节点或尾部未引用填充字节的任意合法归档均逐字节直通）；
2. 遍历克隆后的 JSON 树，跳过 `unpacked: true` 与 `isLinkNode()` 节点，经 `assertSafeEntryRange()` 校验每个普通打包节点的 `offset` 与 `size` 均为非负安全整数，计算原始数据区的最大结束位置 $\text{dataEnd} = \max(\text{offset} + \text{size})$；
3. 未出现在 `replacements` 中的条目：**完全保留其原始 `offset`、`size` 与 `integrity` 不动**；
4. 出现在 `replacements` 中的条目（仅普通条目 `dist/languageServer.js`）：将其新字节流追加至 `dataEnd` 之后，更新该节点的 `offset`、`size`，并按 `4 MiB` 分块重新计算 `SHA256` `integrity`（`hash` 与 `blocks` 数组）；
5. 将原始数据区 `[dataOffset, dataOffset + dataEnd)` 原封不动拷贝至新头部之后，并在末尾拼接追加块。

> **Electron Fuses 实测确认**：扫描 `/opt/Antigravity/antigravity` 主程序中的 Fuse 哨兵 `dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX`（位于偏移 `37,014,720`）可见：`EnableEmbeddedAsarIntegrityValidation = DISABLED (0)`、`OnlyLoadAppFromAsar = DISABLED (0)`。Linux 发行版未启用宿主内置 ASAR 签名锁死，但同步更新节点内的 `integrity` 哈希可确保元数据始终自洽。

### 2.3 `dist/languageServer.js` 惰性环境变量钩子

在 `dist/languageServer.js` 的 `startLanguageServer()` 函数内，定位全文件唯一锚点并注入 5 行惰性转发逻辑：

```javascript
             '--cloud_code_endpoint',
             'https://daily-cloudcode-pa.googleapis.com',
             '--enable_sidecars',
         ];
+        // [antigravity-uipatch] Only when AGY_UI_BUNDLE is set, so an
+        // unpatched launch behaves exactly like stock.
+        if (process.env.AGY_UI_BUNDLE) {
+            args.push(`--web_bundle_path=${process.env.AGY_UI_BUNDLE}`);
+        }
```

即 **2 行注释 + 3 行代码 = 5 行新增**（`if` 条件、`args.push` 与闭合花括号）。

### 2.4 桌面启动器 `Exec=` 的双层编码与统一语义解析（`analyseDesktopExec`）

`~/.local/share/applications/antigravity.desktop` 的 `Exec=` 行**不是** shell 脚本，且同时受两套独立语法规范约束：
1. **内层（Desktop Entry `Exec` argv 层）**：含空白或保留字符的参数须加双引号，引号内仅对 `"`、`` ` ``、`$`、`\` 做反斜杠转义，字面 `%` 必须写为 `%%`（防止被当作 `%U` 等字段码）；且引号可以出现在参数中间（如 `OTHER="hello world"` 是一个完整参数）。
2. **外层（GLib `GKeyFile` 字符串层）**：整条 `Exec=` 右值作为键值字符串存储时，反斜杠必须双写（`\\`），换行/回车/制表符须转义，行首空格须写为 `\s`。

**写入与读取的层次顺序必须严格对称**：
- **写入序列化（`patchDesktopText` / `unpatchDesktopText`）**：先对需要改动的参数执行 **Exec argv 层编码**（`desktopExecEscapeArg()`），与其余原始参数拼接为完整命令行后，再整体执行 **GKeyFile 字符串层编码**（`keyFileEscapeValue()`）落盘；
- **读取反序列化（`analyseDesktopExec`）**：先执行 **GKeyFile 字符串层解码**（`keyFileUnescapeValue()`），再交由 `tokenizeDesktopExec()`（支持参数内部引号区间）与 `unquoteDesktopExecToken()` 还原 `argv` 数组。若缺少外层解码或颠倒顺序，含 `"`、`$`、反引号的路径要么被 GLib/Gio（`Gio.DesktopAppInfo.new_from_filename()`）直接拒绝，要么在第二次 `install`/`sync` 时发生重复转义破坏命令行。

为彻底消除读写分歧，`patchDesktopText()`、`unpatchDesktopText()` 与 `cmdVerify()` **三方共用单一解析器 `analyseDesktopExec()`**：
- **保留原始引号实现幂等重写**：解析器同时返回 `rawTokens`（未剥引号的原始 token）与解码后的 `tokens`。改写时仅替换或插入 `AGY_UI_BUNDLE=<ui-dir>` 对应的单个元素，其余参数直接复用 `rawTokens`，确保既有带引号变量（如 `OTHER="hello world"`）原样保留且重复运行 `install`/`sync` 完全幂等。
- **完整建模受支持 `env` 前缀语法**：识别 `env` 与 `*/env` 前缀下的无参选项（`-i`/`--ignore-environment`、`-0`/`--null`、`-v`/`--debug`）、带参选项（`-u`/`--unset`、`-C`/`--chdir`）及选项终止符 `--`；注入位置**恒在所有 `env` 选项之后、程序名之前**（避免把 `-i`/`-u` 挤到赋值后面被当作程序执行）；保留全部其他 `NAME=value` 赋值（同名多次赋值按 `env(1)` 后胜出语义取值），而程序名之后的同形参数一律按普通程序参数保留（既不读取也不删除）。`unpatchDesktopText()` 仅在移除本变量后既无剩余环境变量也无 `env` 选项（`!hadOptions`）时才移除前导 `env`。
- **未知包装器显式拒绝**：遇到 `env -S` / `--split-string` 或未知 `-*` 选项时，`analyseDesktopExec()` 返回 `ok: false` 并标注 `unsupported`，写入命令以退出码 `3` 明确拒绝改写，`verify` 将其判为 `INVALID`，绝不静默猜测为 `OFF`。

> **实证**：使用系统真实 `Gio.DesktopAppInfo` 对含空格、`%`、`"`、`$`、反引号、反斜线、既有带引号环境变量及 `env -i` 等 8 类场景执行“首次注入 → 重复注入 → `disable` 卸载”全生命周期启动捕获，全部精确传递原始路径参数。

---

## 3. 双内嵌 ZIP 归档识别与纯内存 CRC32 解压器

`language_server`（`196,043,152` 字节）内部通过 Go `embed.FS` 嵌入了**两个**独立的 ZIP 归档（以 `CL 1015941558` 实测为例）：

| 归档序号 | 二进制起始偏移 | 条目数 | 压缩体积 | 内容示例 | 真实用途 |
|---:|---:|---:|---:|---|---|
| **ZIP #1** | `80,852,037` (`0x4d1b445`) | `598` | `408,467 B` | `Africa/Abidjan`, `Asia/Shanghai` | Go 运行时内嵌时区库（`tzdata`） |
| **ZIP #2** | `164,809,256` (`0x9d2ca28`) | `548` | `5,628,057 B` | `index.html`, `main.js`, `compiled_tailwind.css` | **桌面端 Web UI（`agy_hub_web_bundle`）** |

`findWebBundleZip(binBuf)` 从二进制末尾向前枚举全部 EOCD 候选（`PK\x05\x06`，`0x06054b50`；容器二进制启用 `allowTrailing: true`，不套用独立归档“EOCD 必须落在文件末 64 KiB 内”的假设），对每个候选由 `cdSize` 与 `cdOffset` 反推归档起点 $\text{start} = \text{eocd} - \text{cdSize} - \text{cdOffset}$，验证起点处的本地文件头签名（`PK\x03\x04`，`0x04034b50`），随后**完整校验**中央目录结构并精确选取同时包含 `index.html` 与 `main.js` 的归档。单个候选校验失败会继续向前扫描，因此注释中伪造的诱饵 EOCD 无法遮蔽真实归档；该算法不依赖硬编码偏移量，跨版本编译后依然稳健。

中央目录校验（`listZipEntries()`）强制要求：EOCD 的盘号字段全为 `0`（拒绝分卷/多盘）；显式拒绝 ZIP64 与加密标记；`cdOffset + cdSize` 必须**恰好**结束于 EOCD 记录；条目数必须被精确消费完；条目名不得含空段或 `.` 段；按**规范化路径**去重，并检测 `a` 与 `a/` 这类文件/目录冲突（否则解压时会静默互相覆盖）。

解压每个条目时，`readZipEntry()` 同时强制执行以下安全检查：
1. **路径穿越拦截**：拒绝含 `\0`、前导 `/`、`\` 或 `..` 路径段的条目名；
2. **本地头一致性核对**：本地文件头声明的名称、压缩方法与尺寸必须与中央目录一致（带 data-descriptor 标志 `0x0008` 的流式写出除外），防止改写本地头将解压导向别处；
3. **解压上限**：单条目声明解压尺寸上限为 `128 MiB`，`zlib.inflateRawSync` 额外传入 `maxOutputLength`，避免畸形压缩包造成内存耗尽；
4. **解压长度核对**：支持 `STORE (0)` 与 `DEFLATE (8)`，核对解压字节数严格等于中央目录声明的 `uncompSize`；
5. **IEEE 802.3 CRC32 校验**：优先调用 Node 原生 `zlib.crc32`（低版本自动回退内置 `0xEDB88320` 查表实现），任何单比特损坏立即抛出 `PatchError` 中止。

写入磁盘时（`extractZipToDir()`）另有三重边界保护：目标目录必须**不存在或为空**（对非空目录直接拒绝，绝不递归清空）；整包解压总量受 `512 MiB` 字节预算约束；路径策略区分“授权根”与“根以下”——先用 `resolveWriteRoot()` 把目标根**一次**规范化到 `realpath`（若祖先链中出现指向普通文件的非目录组件，将 `ENOTDIR` 统一转换为清晰的 `PatchError`；用户自己的 `$HOME`、`/tmp` 或 `--ui-dir` 本身是目录符号链接时仍可正常工作），此后 `assertNoSymlinkBelowRoot()` 拒绝根**以下**任何符号链接。`atomicWriteFile()` 复用完全相同的根策略。

---

## 4. `main.js` 四处前端汇聚点补丁详解

在提取出的 `548` 个归档条目（`540` 个文件 + `8` 个目录）中，除 `main.js` 外的其余 `539` 个文件保持原厂字节不变，仅对核心包 `main.js`（原版 `11,188,738` 字节 → 修补后 `11,199,216` 字节）施加以下 **4 处唯一锚点补丁**：

### 4.1 补丁 1：`mendel-native-baseline`（`fka()` 持久化预热 + Google 原生基线回退）

`MendelExperimentProvider` 的唯一拉取入口 `fka(a)` 负责请求 `a.getMendelFlags($b(sha, {}))` 并构造实验键值字典。该补丁在 `fka(a)` 上方注入辅助运行时并改造拉取流程：

1. **启动期异步预热 `__agyHydrateDevStorage()`**：
   - 在 `fka(a)` 返回实验表之前首先 `await __agyHydrateDevStorage()`；
   - 通过 Electron 预加载桥接 `window.nativeStorage.getItems()` 读取 `~/.config/Antigravity/app_storage.json` 中的 `jetski.developer.customFlagOverrides` 与 `jetski.developer.featureEnvironmentOverride`，回填至当前随机端口的 `window.localStorage` 并派发 `StorageEvent` 唤醒 `mk()` 状态钩子（若首次升级时当前端口 `localStorage` 已有未删旧数据而磁盘尚无记录，则自动反向入队 `updateItems` 迁移落盘）。
   - **可重试与有界超时语义**：只有 `pending`（进行中）与 `done`（已完成）两种状态会被保持；IPC 抛错或读取超时（`__AGY_HYDRATE_TIMEOUT = 2000ms`）会在 `catch` 中将状态复位为 `idle`，使下一次调用真正重试。当 `window` 存在但 `window.nativeStorage.getItems` 尚未出现时，自首次缺失时刻 `__agyFirstMiss` 起在 `__AGY_BRIDGE_GRACE`（`8000ms`）宽限期内保持 `idle` 以便晚挂载的桥接重试；超过宽限期仍无桥接（或无 `window` 对象）则置为 `done`。
   - **旧快照不覆盖新编辑**：hydrate 完成前发生的本地写入登记在 `__agyDirty` 中，磁盘快照返回后这些键以当前本地值为准并反向入队落盘，避免延迟返回的旧快照覆盖用户刚做的修改。
2. **基线归一化 `__agyNormalizeMendel(list)`**：
   - 通过 `@bufbuild/protobuf` 消息构造器 `$b(D.ExperimentWithVariantSchema, ...)` 构造合法 Protobuf 实例，满足前端每 5 分钟轮询的 `Tja(D.ExperimentWithVariantSchema, ...)` 结构相等性校验；
   - **当输入列表为空 `[]`**：自动回退构造 Google 原生账号线上实测开启的全部 **41 项前端布尔开关**（`NATIVE_MENDEL_BOOL_FLAGS`）+ **7 项字符串载荷配置**（`NATIVE_MENDEL_STRING_FLAGS`，如 `max-media-attachments = "15"`、`max-best-of-n = "10"` 等）+ **`enable-developer-mode`**；
   - **当输入列表非空**：原样保留云端下发的完整实验列表，仅确保 `enable-developer-mode` 处于 `disabled: false`。
3. **双通道共享解析策略 `__agyResolveExperiments(raw)`**：
   - **成功且返回非空数组** → 更新 `__agyLastGood` 并原样返回；
   - **成功但返回空数组 `[]`**（在网关模式下，服务端返回 `{"experimentConfig":{}}`，经 Protobuf 解码后 `experiments` 默认补全为空数组 `[]`）→ 视为服务端撤回实验表（如切换账号或切入网关模式），**清空 `__agyLastGood = null` 并返回 `[]`**，继而由 `__agyNormalizeMendel([])` 启用静态原生基线；
   - **请求失败（`ok === false` 传入 `undefined`，或顶层缺少整个 `experimentConfig` 子消息）** → 返回 `__agyLastGood || []`，使偶发网络抖动保留已加载的实时表，待网络恢复后自动衔接线上状态。

由于该归一化位于 `ika(gj())` 上游，`baselineRuntimeEnvironment.customFlags`（`enabledByDefault`）天然与 Google 原生账号保持一致：在 `Settings -> Developer -> Custom Flags` 面板中，所有默认开启项初始均呈现为 `0 overrides`，且自动激活了原生的 `sub()` 防锁死保护（`getBaseline("developerMode").enabled === true`）。

### 4.2 补丁 2：`mendel-service-wrapper`（`lB().getMendelFlags` 次级通道统一接入）

前端除 `MendelExperimentProvider` 外，还存在一套供 `FS(flag)` 与 `GS(flag, defaultInt)` 钩子（如内联生成式 UI 开关 `jetski-generative-ui`、浏览器子代理 `enable-browser-subagent-v2`、附件上限 `max-media-attachments` 等）使用的 `lB().getMendelFlags` 包装器。

`PATCH_MENDEL_SERVICE` 为该包装器补齐了内部 `try/catch` 异常捕获（记录布尔标志 `ok`），并将返回值统一改写为 `__agyNormalizeMendel(__agyResolveExperiments(ok ? x : void 0))`。因此，**主通道 `fka()` 与次级通道 `lB().getMendelFlags` 完全共用同一份 `__agyLastGood` 缓存、同一套“成功空表清缓存 / 失败保留上次可用表”策略以及同一份静态基线**。

### 4.3 补丁 3：`mendel-local-overrides`（全通道双向覆盖响应 + `window.nativeStorage` 实时落盘）

原版前端在持久化与覆盖传递上存在两处结构性缺陷：
1. **随机端口导致 `localStorage` 每次重启清空**：桌面端每次启动均以 `--https_server_port 0` 在随机端口（`https://127.0.0.1:<port>`）提供 UI，而 Chromium 按 `协议 + 主机 + 端口` 隔离 `window.localStorage`。原版 `mk("jetski.developer.customFlagOverrides")` 仅写入 `localStorage`，导致每次重启或重装客户端后手动修改全部丢失。
2. **直读 Mendel 开关不走 `ela()`**：`kj()`、`IX()`、`jj()` 与 `FS()` 原本依赖后端 `SetMendelFlagOverrides` RPC 更新 `stateProvider`，在非 `dev_mode` 下被 `permission_denied` 阻断。

`PATCH_MENDEL_OVERRIDES` 精确校验并改写 **5 个唯一子锚点**，彻底打通闭环：

| 子锚点标识 | 原版代码位置 | 补丁改写逻辑与作用 |
|---|---|---|
| `jj`（主锚点） | `function jj(a,b){return(a=a.experiments[b])?!a.disabled:!1}` | 外包 `__agyOvr(b, ...)`，使同步布尔读取优先采纳本地覆盖值 |
| `kj` | `Oi(a.stateProvider,d=>(d=d[b])?!d.disabled:!1)` | 外包 `__agyOvr(b, ...)`，使全部 `kj()` / `IX()` 响应式布尔流实时响应覆盖（不篡改 `stateProvider` 基线字典） |
| `flagOverrideSync` | `this.lsClient.setMendelFlagOverrides(...)` | 在 `jka` 构造时通过 `__agyRegisterNotifier(...)` 注册刷新回调并将返回的注销函数保存在 `this.__agyDisposeNotifier` 上；同时在 `flagOverrideSync` 发起 best-effort RPC 前后各刷新一次 `stateProvider`（内层 `try/catch` 吞掉预期的 `permission_denied`）。由于每次本地写入都会由 `__agyAfterLocalWrite()` 直接触发 `__agyNotify()`，即使 `dka` 队列中前一次 RPC 尚未返回，后续连续拨动或 `Reset overrides` 也能立即更新界面 |
| `FS` | `var FS=a=>(a=ayb(a))?!a.disabled:!1,` | 外包 `__agyOvr(a, ...)`，使次级通道布尔读取同样响应本地覆盖 |
| `mkStorageWrite` | `t===null?window.localStorage.removeItem(a):window.localStorage.setItem(a,t);` | 当键名以 `"jetski.developer."` 开头时调用 `__agyAfterLocalWrite(a, t)`：标记 `__agyDirty` → 更新删除墓碑 → 入队 `__agyPersist()` → 立即 `__agyNotify()` 通知全体订阅者 |

**落盘路径的三项工程保证**（针对异步 IPC 与宿主的 read-modify-write 语义）：

1. **串行 + 合并写入队列与线性有界重试**：`__agyPersist()` 将并发写入合并至单个 `__agyPending` 批次，由 `__agyPump()` 串行发送，前一次 `updateItems` 落定后才发下一批，规避宿主 `StorageManager` 全表 read-modify-write 在并发调用时互相覆盖丢更新的问题。所有 Promise 均挂接 `then/catch`（无 `unhandledRejection`）；若写入报错，未确认批次会保留并垫在更新写入之下，记录 `__agyPersistErr` 后执行最多 **3 次自动重试**（线性退避 `150 * __agyRetry`，即 `150 / 300 / 450 ms`），重试成功且无积压批次时清除错误状态。对于底层永不返回的挂起调用，为保证写入顺序不执行并发超时重发。
2. **删除墓碑（Tombstone）机制**：`mk()` 传入 `null` 删除键时，除将 `null` 写入磁盘外，还将墓碑集合持久化到 `jetski.developer.__agyMeta`，使“用户主动删除”与“从未迁移”可明确区分，防止旧端口残留值在 hydrate 时回灌。若删除发生在磁盘元数据读回之前，先标记 `__agyTombDirty`，待读回磁盘墓碑后做并集再回写（注：若在预热完成前对同一键先删后恢复，并集合并可能保留一条历史墓碑记录，但因 hydrate 时有效字符串值优先于墓碑分支，不影响正常读取结果）。
3. **`__agyDirty` 防旧快照覆盖**：hydrate 进行中发生的本地写入记入 `__agyDirty`；磁盘快照返回后，dirty 键以本地当前值为准并反向同步落盘。

### 4.4 补丁 4：`flag-picker-scrollable`（`Developer` 面板向上可滚动开关选择器）

原版 `Settings -> Developer` 底部用于开启新开关的组件 `mtb({ suggestedFlags: a, onAdd: b })` 使用了浏览器原生 `<input list="custom-flag-suggestions">` + `<datalist>`。在 Linux Electron / Chromium 下，原生 `<datalist>` 弹窗存在两处严重缺陷：
1. 强制渲染为纯白背景黑字，完全脱离宿主深色主题；
2. **不支持滚轮滚动**，候选开关超出屏幕高度后被直接截断，用户无法浏览完整列表。

`PATCH_FLAG_PICKER` 通过带引号转义跳过的**两阶段括号扫描器**精确定位 `mtb` 函数体起止位置（第 1 阶段 `findMatchingParen` 配对圆括号 `(...)` 安全跳过解构形参 `{suggestedFlags:a,onAdd:b}`，第 2 阶段 `findMatchingBrace` 配对花括号 `{...}` 定位函数体边界），将其整体替换为基于宿主已编译 Tailwind 工具类的受控 Combobox 组件：

- **向上锚定不裁切**：输入框位于设置页底部，下拉框采用 `absolute left-0 right-0 bottom-full mb-1 z-50`，底边紧贴输入框上沿向上展开；
- **固定上限平滑滚动**：采用 `max-h-64 overflow-y-auto`（最大高度 `16rem / 256px`），支持鼠标滚轮浏览全部候选开关；键盘高亮项通过 `scrollIntoView({ block: 'nearest' })` **自动滚动入视区**；
- **原生主题与键盘交互**：复用宿主 CSS 变量类 `bg-card border border-border text-foreground bg-secondary`，支持大小写不敏感子串实时过滤、`ArrowUp` / `ArrowDown` 高亮移动、`Enter` 选中提交（下拉收起时按输入框文本提交，不会误取布尔状态）、`Escape` / `Tab` / 焦点移出组件自动收起；
- **ARIA 无障碍语义**：输入框带 `role="combobox"`、`aria-expanded`、`aria-controls` 与 `aria-activedescendant`，下拉容器 `role="listbox"`，每项 `role="option"` 且带稳定 `id`。

**扫描器的保守拒绝策略与已知边界**：零依赖脚本不内置完整 JS 词法器，改用 `assertSupportedConstruct()` + 越界检查保护：
1. 扫描区间内出现注释（`//`、`/*`）一律抛出 `PatchError` 拒绝；
2. 遇到 `/` 时回看前一个非空白字符，凡不能保守归入除法上下文的 `/` 一律按潜在正则字面量拒绝；
3. 截取函数体后检查内部是否包含额外的 `function <name>(` 声明，若命中则判定边界异常并中止。
该设计面向当前已验证的编译组件结构（非通用 JS 词法解析器），若未来上游组件结构发生较大变化，升级时以显式退出码 `3` 提示适配新锚点。

---

## 5. 原子替换、配对备份、CLI 契约与 Pacman Hook 权限模型

### 5.1 原子文件写入与暂存目录切换状态机

- **`atomicWriteFile()`**：拒绝覆盖符号链接或非常规文件；经 `resolveWriteRoot()` 一次规范化目标父目录并由 `assertNoSymlinkBelowRoot()` 校验无根下链接后，在同目录创建 `.tmp-<name>-<pid>-<rand>` 独占临时文件（`wx`），写入后执行 `fsync`、继承原文件权限位与属主，再通过 `fs.renameSync` 原子替换并对目录执行 `fsync`。
- **`preparePatchedUi()` + `commitPatchedUi()` 四阶段提交状态机**：
  1. `preparePatchedUi()` 先在 `fs.mkdtempSync()` 独占创建的 `.uipatch-staging-*` 目录中完成全部 `548` 个条目的解压、CRC32 校验、4 处前端补丁替换与 V8 `vm.Script` 语法验证，并写入 `uipatch.json` 元数据（`schemaVersion: 2`，记录引擎 `CL`、`nativeBaselineCounts`、`mainJsBytes` 与 `mainJsSha256`）。`install` / `sync` 在改写 `app.asar` **之前**先完成此步骤（且在写回 `app.asar` 前复核磁盘 `ino` 与 `mtimeMs` 未并发变化），确保前端锚点失配绝不会留下“ASAR 已改、UI 未变”的半完成状态。
  2. `commitPatchedUi()` 按 `prepared` → `old-moved` → `committed` / `rolled-back` / `rollback-failed` 推进：仅当**本进程自身成功**将 staging 提升为正式目录（`committed`）或将 `.uipatch-old-*` 移回原位（`rolled-back`；若回滚前目标路径已被外部重新创建，仅允许移回空目录，非空目录拒绝覆盖）时，`finally` 才会清理 `.uipatch-old-*`。一旦提升与回滚同时失败（`rollback-failed`），旧目录被完整保留并在抛出的 `PatchError` 中打印绝对恢复路径与 `mv` 命令。

### 5.2 内容级备份配对校验与坏备份隔离重建

备份文件位于 `~/.local/share/antigravity-uipatch-backup/app.asar.orig`。`pairsWith(backupBuf, currentBuf)` 在内存中检验：
1. `backupBuf` 自身必须可解析为合法 ASAR，且 `dist/languageServer.js` 不含 `AGY_UI_BUNDLE` 钩子；
2. `backupBuf` 与 `currentBuf` 摘要相等，或对 `backupBuf` 重新执行一次 `patchAsarBuffer(backupBuf)` 后得到的 SHA256 与当前 `/opt/Antigravity/resources/app.asar` 完全相等。

`ensurePairedBackup(paths, currentAsarBuf, isHooked)` 在任何写入前严格区分已安装归档的两种状态：
- **已挂钩状态（`isHooked === true`）**：此时备份是唯一可还原的原版依据。若备份缺失、无法解析、自身已含钩子或 `pairsWith()` 失配，立即抛出 `PatchError`（退出码 `3`）中止操作并保留现场文件，提示重装软件包后重新 `install`；
- **洁净未挂钩状态（`isHooked === false`）**：若当前 `app.asar` 已确认是未挂钩的可解析原版（例如刚通过包管理器重装或升级），而历史备份损坏或误含钩子，脚本调用 `quarantineBackup()` 将旧坏备份隔离改名为 `app.asar.orig.unusable-<timestamp>`（保留证据绝不删除），随后直接从当前洁净归档记录全新配对备份，避免要求用户做一次多余的重装。

在 `restore` 时，若 `pairsWith()` 不满足且未显式传入 `--force`，同样以退出码 `3` 拒绝写回，杜绝拿旧版本备份降级覆盖新版本安装。

### 5.3 Pacman Hook 的 Root 信任边界与用户归属回收

Pacman `PostTransaction` Hook 由 `libalpm` 以 `root` 身份、`HOME=/root` 环境直接通过 `execv(3)` 调用，脚本为此实施三项强制约束：

1. **按解析后的 UID 校验非 Root 目标账号**：当 `uid === 0` 且 `HOME === '/root'` 而未指定 `--user <username>`（或 `AGY_TARGET_USER`）时立即退出（退出码 `2`）；`resolveUserAccount()` 通过 `getent passwd` 解析真实 `uid`/`gid`/`home`，凡 `uid === 0`（无论传入 `root`、`0` 还是别名）一律拒绝，并使用解析出的规范用户名生成 `Exec = /usr/bin/node <scriptPath> sync --user <canonicalUser>`（不附加 `--quiet`，使升级同步摘要直接呈现在 Pacman 事务输出中）。同步完成后，`reclaimUserOwnership()` 将外置 UI 目录、备份目录与 `.desktop` 文件统一 `chown` 归还该桌面用户，并通过 `runuser -u <username>` 刷新其 KDE `ksycoca6` 缓存。
2. **脚本路径链强制 Root 审计（`auditRootOwnedChain`）**：`pacman-hook --write` 在写入 Hook 前，先对 `--script-path` 词法路径的每一级组件执行 `lstat`，**任一级为符号链接即拒绝**（防止审计与 Hook 执行之间重指目标）；随后对 `fs.realpathSync()` 解析出的**物理祖先链**逐级 `stat`，要求每一级均满足 `uid === 0` 且 `mode & 0o022 === 0`（组与其他用户均不可写）。
3. **写入前可无损预演**：`pacman-hook --write --dry-run` 完整执行账号校验与路径权限链审计，仅输出目标路径而不创建文件。

### 5.4 `--dry-run` 前置预检与 `verify` 四态健康契约

- **`--dry-run` 全局零写入与按命令预检**：所有子命令在 `--dry-run` 模式下保证零文件/目录变动，并执行各自对应的只读预检——`install` / `sync` 调用共享 `preflightAll()`（运行完整 `cmdSelfTest` 并模拟 `ensurePairedBackup` 的全部分支，包括“已挂钩但缺失备份”与“已挂钩但备份损坏/失配”均与真实运行一样返回退出码 `3`）；`repair` 在内存中读取二进制、提取 `main.js` 并运行完整 4 处补丁与 V8 语法检查；`restore`、`disable`、`extract`、`pacman-hook --write` 分别校验各自前置条件。
- **`extract` 目录保护**：`assertSafeTargetDir()` 显式拒绝 `/`、`$HOME`、安装根目录及其直接父目录（退出码 `2`），并对任何已存在的非空目录或非普通目录以退出码 `3` 拒绝写入。
- **`verify` 四态启动器模型与结构化健康判定**：
  1. 启动器由 `analyseDesktopExec()` 严格归类为四态之一：`ON`（合法 `env` 前缀中含有 `AGY_UI_BUNDLE`）、`OFF`（合法 `Exec=` 行且不含该变量）、`INVALID`（启动器文件缺失、无 `Exec=`、空 `Exec=` 或含不支持的 `env -S` / 未知选项）以及初始兜底态 `UNKNOWN`；
  2. 对 `uipatch.json` 执行严格对象校验（显式拒绝 JSON `null`、数组、原始类型、缺失 `lsVersion.cl` 或缺失 `mainJsSha256`），核对记录哈希与磁盘 `main.js` 真实 SHA256 一致、校验 `main.js` V8 语法与补丁标记，并验证 `index.html` 存在；
  3. 当启动器处于主动停用的 `OFF` 状态时，未被其引用的默认外置 UI 目录若不存在，仅输出信息提示而不计入故障；若全部受检项无异常，打印明确说明（`launcher is OFF: the stock built-in UI is active by design`）并以退出码 `0` 结束；任一受检项存在故障则汇总打印 `unhealthy` 清单并以退出码 `1` 结束。
