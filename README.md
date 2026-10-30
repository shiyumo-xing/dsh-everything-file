# dsh-everything-file

[![CI](https://github.com/shiyumo-xing/dsh-everything-file/actions/workflows/ci.yml/badge.svg)](https://github.com/shiyumo-xing/dsh-everything-file/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dsh-everything-file.svg)](https://www.npmjs.com/package/dsh-everything-file)
[![license](https://img.shields.io/npm/l/dsh-everything-file.svg)](LICENSE)

给 DeepSeek Harness 的 `@文件` 补全做**全盘文件索引搜索**：安装插件即可，不需要任何第三方索引软件，也不要求管理员权限；Windows / macOS / Linux 按平台自动选择索引方式。

系统自带的 `@` 补全（以及 `dsh-at-file` 这类插件）只遍历当前工作区。本插件接管同一个 `ctx.fileReferences` 服务，按平台自动适配：

| 平台 | 自动选择（`backend: auto`） | 说明 |
|---|---|---|
| Windows | ① 自带 MFT 服务（若已安装）→ ② 自带便携遍历索引 | MFT 是加速项；**不装也能用** ②，无需管理员 |
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
dsh plugin --profile <profile> add https://github.com/<owner>/dsh-everything-file/archive/refs/tags/v0.4.3.tar.gz
```

装完即用：Windows 没有 MFT 服务时自动用便携索引，macOS 自动用 Spotlight，Linux 自动用便携索引。只有想追求 Windows 最快全盘索引时，才需要可选地装一次 MFT 服务。

## 便携遍历索引（通用后备）

`lib/local-index-worker.js` 在工作线程里遍历可读目录，把全盘文件名放进内存：

- 纯 Node 实现，无原生二进制、无管理员权限、无外部服务，Windows/macOS/Linux 同一套代码；
- 文件名按块存进 Buffer，查询用原生 `Buffer.indexOf`（SIMD）+ 二分映射，典型查询 0.1–2 ms；
- **边建边查**：遍历过程中查询就能看到已索引的部分，不用等全盘扫完；
- 首次全盘建索引会比 MFT/Spotlight 慢（磁盘规模、文件数而定），默认每 15 分钟后台刷新一次；
- 受权限保护的目录（如系统目录、其他用户目录）会被跳过，这是不使用管理员的代价。

可选加速：

- **Windows MFT 服务**：`scripts\install-service.cmd` 一次性安装（UAC），之后读 MFT + USN journal，毫秒级全盘索引；不装也能用便携索引。
- **macOS Spotlight**：系统自带，无需安装；插件直接调用 `mdfind`（查询串行化与合并见下文）。

## macOS Spotlight 后端

macOS 没有可提权读取的等价 MFT，但系统自带 Spotlight（`mdfind`），插件默认用它做全盘搜索。`mdfind` 是**进程**，而一次通配符查询就是一次元数据扫描：

- **一次只跑一个查询**：`@` 每敲一个字符就发一次请求，若每次都新起 `mdfind`，多个扫描会在 `mds` 里排队，最后一个经常超时（表现为“英文要等好几秒”）。现在查询串行执行，**不同**的新查询会替换还在排队的旧请求并结束已被取代的子进程（先 `SIGTERM`，不理会再 `SIGKILL`），让 `mds` 只处理屏幕上最新的那次输入；
- **同一个词重复请求会合并**：编辑器会随着光标/区间落定反复问同一个词，并且先中止上一代请求；这些重复必须共用同一次扫描，否则每来一次就把唯一能回答它的扫描杀掉，结果就是“没搜过的词永远不出来，只有缓存里的词能出来”。调用方自己的 abort 不再取消扫描，只有**不同的查询**或卸载插件才会；
- **空结果不缓存**：刚建的文件、Spotlight 刚补上的目录，下一次按键就能看到；
- **命中的结果达到上限就停**：像 `*a*` 这种命中半块盘的词不会把整份结果列表拉完；
- **单字符走前缀查询**：`a` 会查 `a*`（索引直接命中，几十毫秒），而不是 `*a*`（扫描，常常超过 5 秒超时）；中文单字（如 `测`）仍然按包含匹配，本身很快；
- **兼容 NFD**：macOS 的索引里重音字符是分解形式，`café` 会同时查 NFC 和 NFD 两种拼写；中文文件名不受影响；
- **空 `@` 页**：用 Spotlight 最近 24 小时变更的文件按修改时间排序，过滤系统与缓存目录后展示（与 Windows 的“最近文件”页对齐）。

仍然存在的限制：Spotlight 不索引隐藏目录（`.git`、`.config` 这类点开头路径）、未开启索引的外置/网络卷，以及被加入“聚焦隐私”的目录；这些目录里的文件只能靠便携遍历索引（`backend: local`）找到。

### 系统索引本身残缺时

Spotlight 的索引会丢条目（系统 bug、索引重建中断、`mds` 异常都会发生）。判断方法：新文件能搜到、老文件搜不到，且

```sh
mdls -name kMDItemFSName "/path/to/文件"
# kMDItemFSName = (null)   ← 这个文件不在系统索引里，插件也搜不到
```

修复（不需要重装插件）：

```sh
mdimport -i ~/Desktop ~/Documents ~/Downloads   # 按目录补建条目，秒级到分钟级，无需 root
sudo mdutil -E /                                # 整盘重建索引（较慢，需要管理员密码）
```

`mdimport -i` 只补你点名的目录，适合“某几个文件夹里的东西搜不到”；整机长期搜不全再用 `mdutil -E`。

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
  - **空查询**：Windows MFT 返回最近修改文件；macOS 用 Spotlight 最近 24 小时变更；便携索引无此页；
  - **含 `/` 或 `\`**：直接列目录，绝对路径可以当全盘文件浏览器，相对路径仍相对工作区；
  - **普通词**：全盘文件名搜索，本地按“文件名完全匹配 > 前缀 > 包含 > 路径包含 > 子序列”重排；
  - 支持 `ext:pdf`、`*.pdf` 扩展名过滤。
- 选中的结果按 `@path` 语法插入，目录追加 `/` 可继续下钻。
- `everything_search` 工具（历史名称，保持兼容）：模型可主动全盘找文件。
- `mft_index_status` 工具：平台、当前后端、MFT/Walk/Spotlight 状态与安装提示。

## 配置

在 profile 的 `cordis.patch.yml` 覆盖 `everything-file-reference` 行：

```yaml
- id: everything-file-reference
  config:
    backend: auto              # auto | mft | spotlight | local
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
| macOS Spotlight 查询构造/过滤/缓存/错误/串行化/同词合并/空查询页 | 单元测试 + macOS 真机通过（`*测试*` 140 ms，连续输入 6 键 0.5 s，同一个词反复请求只扫描一次） |
| macOS / Linux 运行 | macOS 真机通过（Spotlight 后端、中文文件名、最近文件页）；Linux 为同一纯 Node 代码 |

## 代码签名与发布

推送 `v*` tag 后，`Release` workflow 会：

1. 用 `WINDOWS_SIGNING_PFX_BASE64` / `WINDOWS_SIGNING_PFX_PASSWORD`（可选 secret）对 Windows exe 做 Authenticode 签名；未配置时跳过并输出警告；
2. 用 `cosign sign-blob` 对 `SHA256SUMS.txt` 做 keyless 签名（Sigstore，写入透明日志）；
3. 用 `actions/attest-build-provenance` 生成 GitHub 构建来源证明；
4. `npm publish --provenance` 发布 npm 包（需要 `NPM_TOKEN`）；
5. `gh release create` 创建 GitHub Release，附带 npm tgz、Windows 二进制、`SHA256SUMS.txt` 和 cosign bundle。

Authenticode 需要**可信代码签名证书**；自签名证书只适合本地测试，不会消除 SmartScreen 警告。开源项目可考虑 SignPath.io（开源免费）、Azure Trusted Signing，或 Certum / SSL.com 等商业 CA。

本地签名：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\sign-windows.ps1 -Files bin\dsh-mft-indexer.exe `
  -PfxPath .\codesign.pfx -PfxPassword (Read-Host -AsSecureString 'PFX password')
```

验证：

```powershell
Get-AuthenticodeSignature .\bin\dsh-mft-indexer.exe
cosign verify-blob SHA256SUMS.txt --bundle SHA256SUMS.txt.bundle `
  --certificate-identity-regexp "https://github.com/shiyumo-xing/dsh-everything-file/.github/workflows/release.yml@refs/tags/.*" `
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
gh attestation verify <file> --repo shiyumo-xing/dsh-everything-file
```

## 已知限制

- 便携索引首轮全盘遍历较慢、占内存（百万级条目数百 MB），且扫不到权限受限目录；追求速度请装 Windows MFT 服务或使用 macOS Spotlight。
- Windows MFT 服务只索引 NTFS 固定卷。
- 便携索引默认 15 分钟刷新一次，新文件不会立即出现；Windows MFT 走 USN，秒级可见。
- Windows 服务由 `%ProgramData%\dsh-mft-index\` 下的副本运行；升级插件后重跑 `install-service.cmd` 可更新该副本。
- 未配置代码签名证书时，Windows exe 没有 Authenticode 签名，SmartScreen 可能提示；但仍会生成 cosign 签名和构建来源证明。

## License

插件代码 MIT；打包物只含本项目自己的源码与 Windows MFT 索引器，不随附任何第三方库或外部索引客户端（见 `NOTICE`）。
