# dsh-everything-file

[![CI](https://github.com/shiyumo-xing/dsh-everything-file/actions/workflows/ci.yml/badge.svg)](https://github.com/shiyumo-xing/dsh-everything-file/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dsh-everything-file.svg)](https://www.npmjs.com/package/dsh-everything-file)
[![license](https://img.shields.io/npm/l/dsh-everything-file.svg)](LICENSE)

给 DeepSeek Harness 的 `@文件` 补全做**全盘文件索引搜索**：安装插件即可，不需要 Everything，也不要求管理员权限；Windows / macOS / Linux 按平台自动选择索引方式。

系统自带的 `@` 补全（以及 `dsh-at-file` 这类插件）只遍历当前工作区。本插件接管同一个 `ctx.fileReferences` 服务，按平台自动适配：

| 平台 | 自动选择（`backend: auto`） | 说明 |
|---|---|---|
| Windows | ① 自带 MFT 服务（若已安装）→ ② 正在运行的 Everything → ③ 自带便携遍历索引 | 前两者是加速项；**没有任何一项也能用** ③，无需管理员 |
| macOS | ① 系统 Spotlight（`mdfind`）→ ② 便携遍历索引 | Spotlight 是 macOS 自带全盘索引；关闭 Spotlight 时自动降级 |
| Linux | 便携遍历索引（纯 Node） | 不需要 locate/tracker，装完即用 |
| 其它 | 便携遍历索引 | |

## 安装

发布到 npm 后，用户只需安装插件（无需其他步骤）：

```sh
dsh plugin --profile <profile> add dsh-everything-file
```

或在 Web 的 **设置 → 插件** 里按包名安装；也可以从 GitHub Release 的 `.tar.gz` 安装：

```sh
dsh plugin --profile <profile> add https://github.com/<owner>/dsh-everything-file/archive/refs/tags/v0.4.0.tar.gz
```

装完即用：Windows 没有 MFT 服务/Everything 时自动用便携索引，macOS 自动用 Spotlight，Linux 自动用便携索引。只有想追求 Windows 最快全盘索引时，才需要可选地装一次 MFT 服务。

## 便携遍历索引（通用后备）

`lib/local-index-worker.js` 在工作线程里遍历可读目录，把全盘文件名放进内存：

- 纯 Node 实现，无原生二进制、无管理员权限、无外部服务，Windows/macOS/Linux 同一套代码；
- 文件名按块存进 Buffer，查询用原生 `Buffer.indexOf`（SIMD）+ 二分映射，典型查询 0.1–2 ms；
- **边建边查**：遍历过程中查询就能看到已索引的部分，不用等全盘扫完；
- 首次全盘建索引会比 MFT/Spotlight 慢（磁盘规模、文件数而定），默认每 15 分钟后台刷新一次；
- 受权限保护的目录（如系统目录、其他用户目录）会被跳过，这是不使用管理员的代价。

可选加速：

- **Windows MFT 服务**：`scripts\install-service.cmd` 一次性安装（UAC），之后读 MFT + USN journal，毫秒级全盘索引；不装也能用便携索引。
- **macOS Spotlight**：系统自带，无需安装；插件直接调用 `mdfind`。

## Windows MFT 服务（可选，最快）

读取 NTFS MFT 必须打开卷设备，Windows 只允许提权进程这么做，因此这一步需要一次性 UAC：

1. 右键 `scripts\install-service.cmd` → 以管理员身份运行。
2. UAC 点“是”。服务注册为 `dsh-mft-index`，LocalSystem 常驻、开机自启。
3. 服务先做一次 MFT 全盘扫描，然后进入 USN 增量模式。

服务日志：`%ProgramData%\dsh-mft-index\indexer.log`；卸载：管理员运行 `scripts\uninstall-service.ps1`。

## USN 增量与重建优化（Windows MFT 服务）

```text
Harness 插件（普通用户）──命名管道 \\.\pipe\dsh-mft-index──▶ dsh-mft-index 服务（LocalSystem）
                                                            ├─ FSCTL_ENUM_USN_DATA：首次/重建读 MFT
                                                            ├─ FSCTL_QUERY/READ_USN_JOURNAL：每 ~0.4 s 增量
                                                            ├─ 内存索引 + 小型 overlay
                                                            └─ 低频整盘重建（6h / 回绕 / overlay 过大）
```

- 创建、改名、删除、硬链接变化直接进 overlay，普通改动约 0.4–1 s 可见；不再每 10 分钟整盘重建。
- 整盘重建只在 journal 回绕/重建、journal id 变化、overlay > 15 万条或每 6 小时发生；重建线程 `BelowNormal` 优先级、每 6.4 万条记录 `Sleep(1)`，重建期间查询继续用旧快照。

## 行为

- 输入 `@`：
  - **空查询**：Windows MFT / Everything 后端返回最近修改文件；便携索引与 Spotlight 无此页；
  - **含 `/` 或 `\`**：直接列目录，绝对路径可以当全盘文件浏览器，相对路径仍相对工作区；
  - **普通词**：全盘文件名搜索，本地按“文件名完全匹配 > 前缀 > 包含 > 路径包含 > 子序列”重排；
  - 支持 `ext:pdf`、`*.pdf` 扩展名过滤。
- 选中的结果按 `@path` 语法插入，目录追加 `/` 可继续下钻。
- `everything_search` 工具（名称保持兼容）：模型可主动全盘找文件。
- `mft_index_status` 工具：平台、当前后端、MFT/Walk/Spotlight 状态与安装提示。

## 配置

在 profile 的 `cordis.patch.yml` 覆盖 `everything-file-reference` 行：

```yaml
- id: everything-file-reference
  config:
    backend: auto              # auto | mft | spotlight | local | everything
    maxResults: 20
    scanLimit: 300
    recentOnEmpty: true
    # 便携遍历索引（所有平台可用）
    localRoots: []             # 空=平台默认（Windows 所有固定盘；macOS/Linux 的 /）
    localExcludeRoots: []      # 额外跳过的绝对前缀
    localMaxEntries: 12000000
    localRefreshMinutes: 15
```

## 验证状态

| 能力 | 状态 |
|---|---|
| 便携遍历索引（建索引/查询/路径/扩展名/大小写/重建） | Windows 上单元测试+真实临时目录通过（查询 0.1–0.7 ms） |
| `@` provider 经 Cordis 服务代理调用 | 已验证（MFT 后端）；便携索引使用同一 `searchCandidates` 契约并单独验证 |
| Windows MFT 读取 / USN journal | 代码完成；需安装服务提权后验证 |
| USN overlay 逻辑（建/改名/删） | 用 FileSystemWatcher 驱动同一 overlay 验证通过 |
| macOS Spotlight 查询构造/过滤/缓存/错误 | 单元测试通过（注入 runner）；真机未测 |
| macOS / Linux 运行 | 同一纯 Node 代码，未在真机运行 |

## 已知限制

- 便携索引首轮全盘遍历较慢、占内存（百万级条目数百 MB），且扫不到权限受限目录；追求速度请装 Windows MFT 服务或使用 macOS Spotlight。
- Windows MFT 服务只索引 NTFS 固定卷。
- 便携索引默认 15 分钟刷新一次，新文件不会立即出现；Windows MFT 走 USN，秒级可见。
- 服务从插件目录运行：移动/删除插件目录后需重跑安装脚本。

## License

插件代码 MIT。可选 Everything 后端随附 `Everything64.dll`（MIT，见 `NOTICE`）。
