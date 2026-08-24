# WebGPT Bridge

WebGPT Bridge 是一个 macOS / Windows 桌面控制器。它启动仓库内置的 MCP Agent，并通过 OpenAI Secure MCP Tunnel 让 ChatGPT 网页版调用本机工作区。

关闭主窗口后，服务会继续在菜单栏（Windows 为系统托盘）运行；可通过图标菜单重新打开、停止或退出。

## 架构

```text
ChatGPT 网页版
       |
OpenAI Secure MCP Tunnel
       |
WebGPT Bridge 桌面控制器
       |
内置 MCP Agent (agent-runtime/dist/server.js)
       |
你选择的工作区目录
```

## 重要说明

从 v0.3.0 起，本仓库和发行安装包都包含安全优先的 MCP Agent 源码及构建后的运行时。普通使用者不需要再单独下载、构建或选择 Agent 项目目录。

从 v0.3.3 起，正式安装包还会内置对应操作系统/架构的 OpenAI `tunnel-client v0.0.11` 与其配套 `cloudflared`。构建时从 OpenAI 官方 Release 下载固定资产并核对仓库中固定的 SHA-256 后才会进入安装包；上游 `LICENSE` 与来源信息也随包保留。OpenAI `tunnel-client` 项目采用 Apache-2.0 许可证。

仍需自行准备：

1. OpenAI 平台中已创建的 Tunnel ID 与对应运行时密钥。
2. 一个范围尽可能小的本地工作区目录。

Tunnel ID、运行时密钥和工作区文件不会包含在仓库或安装包中，也不得提交到 Git。

## 安装应用

在 [Releases](https://github.com/chinatownlittlewhite/webgpt-bridge/releases) 下载对应系统的最新发行包。当前发布包未签名或公证，请只从本仓库 Releases 下载，并在下载页核对 SHA-256。

当前 `v0.3.3` 提供 macOS Apple Silicon 与 Windows x64 安装包。两个平台都在对应 GitHub Actions 原生 runner 上完成 Agent acceptance 后才会发布；Linux 和 macOS Intel 暂不提供本版本安装包。

| 平台 | 推荐下载 |
| --- | --- |
| macOS Apple Silicon | `WebGPT Bridge-0.3.3-mac-arm64.dmg`，也可下载 ZIP |
| Windows 10 / 11 x64 | `WebGPT Bridge-0.3.3-win-x64.exe`，也可下载 ZIP |

每个 Release 同时包含 GitHub 自动生成的源码 ZIP / TAR.GZ 与 `SHA256SUMS.txt`。

### macOS

1. 打开 DMG。
2. 将 `WebGPT Bridge.app` 拖到“应用程序”。
3. 首次打开如被 Gatekeeper 拦截：在 Finder 中按住 Control 点击应用，选择“打开”，再确认“打开”。

### Windows

1. 运行 `WebGPT Bridge-0.3.3-win-x64.exe`。
2. 按安装向导完成安装，可自行选择安装位置。
3. 若 SmartScreen 显示提示，先确认发布来源和 SHA-256；确认无误后选择“仍要运行”。

## 首次连接 ChatGPT

### 1. 准备 OpenAI Tunnel

以下配置需要在每一台要运行本地 Agent 的电脑上分别完成。不要让两台电脑共用同一个 Tunnel ID 或运行时密钥，否则 ChatGPT 的请求可能被转发到错误主机。

1. 打开 [OpenAI Platform Tunnels](https://platform.openai.com/settings/organization/tunnels)，点击 **Create tunnel**。
2. 为 Tunnel 填写能识别设备的名称，例如 Mac mini 使用 `macmini`，Windows 台式机使用 `desktop`；说明可写 `Private local MCP server`。
3. 选择拥有该配置的 Platform Organization，并关联实际使用 ChatGPT 的 workspace。
4. 创建后记录 `tunnel_...` 格式的 Tunnel ID。它需要填入控制器，但不应提交到仓库或公开文档。

接着创建仅供该设备运行 `tunnel-client` 使用的密钥：

1. 打开 [OpenAI Platform API keys](https://platform.openai.com/settings/organization/api-keys)，点击 **Create new secret key**。
2. 选择与设备对应的项目，例如 `macmini` 或 `desktop`。
3. 选择 **Restricted**，只勾选 **Tunnels: Read** 和 **Tunnels: Use**。不要为 Tunnel 运行时密钥授予模型、文件或其他 API 权限。
4. 使用明确的名称，例如 `webgpt-bridge-macmini-tunnel` 或 `webgpt-bridge-desktop-tunnel`，创建后立刻保存一次性显示的密钥。

运行时密钥是凭据：不要发送到聊天、邮件、截图、Issue、README 或 Git；不要把它同步给另一台电脑。各设备应创建独立密钥，并只在对应设备的 WebGPT Bridge 中保存。

正式安装包已经包含与平台匹配的 OpenAI `tunnel-client v0.0.11`，普通用户无需再从 Tunnel 设置页单独下载或选择可执行文件。只有在开发、测试或临时替换版本时，才需要在“权限与高级设置”中填写“自定义 tunnel-client（可选）”。留空时应用始终优先使用安装包内置版本。

`tunnel-client` 只需要从本机出站访问 `api.openai.com:443`，不需要对公网或局域网开放入站端口。

如果网络需要本机 HTTPS 代理，可在控制器“HTTPS 代理”中填写代理地址，例如：

```text
http://127.0.0.1:7890
```

只在代理确实运行在该地址时填写。运行时密钥仅通过 Electron 系统安全存储加密保存，不会明文写入设置文件。

### 2. 在控制器保存设置

打开 WebGPT Bridge，在主界面的“连接设置”中填写工作区目录、Tunnel ID 和运行时密钥。内置 `tunnel-client` 无需配置；运行时路径、Node、自定义 tunnel-client、配置名称和 HTTPS 代理位于“权限与高级设置”。

| 字段 | 填写内容 |
| --- | --- |
| 工作区目录 | 允许 Agent 操作的项目根目录，或多个项目的共同父目录 |
| Tunnel ID | OpenAI 平台创建的 `tunnel_...` |
| 运行时密钥 | OpenAI Tunnel 的运行时密钥；首次填入后点击“保存设置” |

“可选设置”包含：

| 字段 | 填写内容 |
| --- | --- |
| Agent 运行时目录 | 默认使用随应用附带的 `agent-runtime`；仅开发或替换 Agent 时修改 |
| 自定义 tunnel-client（可选） | 留空使用安装包内置 v0.0.11；仅开发、测试或临时替换版本时选择其他可执行文件 |
| Node.js（可选） | Node 可执行文件完整路径；留空时应用自动查找 Node 20+ |
| 配置名称 | 保持 `webgpt-bridge` 即可 |
| HTTPS 代理（可选） | 仅在需要代理访问 OpenAI 时填写 |

### 可选：启用受控本机开发代理

默认的项目 Agent 仍只操作“工作区目录”。如果你希望 ChatGPT 在网页端协助浏览其他本机开发文件、准备跨项目的改动或运行受控开发命令，可在“可选设置”中的“本机操作授权”选择模式，然后重启连接使工具列表刷新：

| 模式 | 行为 |
| --- | --- |
| 谨慎 | 读取、搜索和检查自动；写入与变更操作保持较严格确认。 |
| 工作区自动（推荐） | 已验证沙箱内的普通编辑、test/lint/build、Node/Python 项目命令和本地 Git 变更尽量自动执行；高风险操作仍确认。 |
| 高自治 | 在工作区自动基础上进一步减少工作区内删除、移动、覆盖等确认，但不会放开敏感路径、提权、shell/SSH 或任意网络外发。 |

在“工作区自动”和“高自治”模式中，可对部分可记忆权限勾选“本次连接记住此类权限”；停止连接、重启应用或切换权限模式后自动清空。敏感路径、任意网络外发、远端 Git 写入、sandbox 权限扩张、shell/SSH 和提权操作不会通过会话记忆静默绕过。每个文件批次最多 20 项，并在实际写入前重新核对 SHA-256；任一文件发生变化，整个批次不会执行。

本机代理默认排除 SSH 密钥、钥匙串/凭据、浏览器资料、云凭据目录、`.env` 与包管理器认证文件、WebGPT Bridge 自身密钥存储及系统目录。敏感位置只能发起一次性读取/列目录请求，并需要你在原生确认窗中批准；无法被永久加入白名单。终端只接受参数数组，不接受 shell 文本、`sudo`、提权程序或可执行文件路径。

这项功能不要求也不会主动请求 macOS 的“完全磁盘访问权限”。macOS 和 Windows 仍会按各自的隐私与 ACL 规则限制文件访问；应用无法绕过这些系统保护。

点击“启动连接”。启动成功时界面应显示“本地 Agent：运行中”和“Secure MCP Tunnel：已连接”。本机诊断地址为 `http://127.0.0.1:8787/healthz`；这些本机地址不能直接填写到 ChatGPT 网页版连接器中。

### 3. 在 ChatGPT 网页版创建插件

保持控制器运行。在 ChatGPT 网页版中，菜单名称会随账户界面更新显示为 **插件**、**Apps** 或 **Connectors**；当前个人开发者模式入口可从 [ChatGPT 插件](https://chatgpt.com/plugins) 打开。

1. 在 ChatGPT **设置 -> 安全与登录**启用开发人员模式。
2. 打开“插件”，点击 **创建应用**。
3. 名称填写当前设备名称，例如 Mac mini 填 `macmini`，Windows 台式机填 `desktop`。
4. 连接方式选择 **Tunnel / 隧道**，选择同名 Tunnel；也可粘贴该设备的 `tunnel_...` ID。
5. 身份验证选择 **无**。Tunnel 运行时密钥已经在本地 `tunnel-client` 中完成传输层认证，不应填入 ChatGPT 插件表单。
6. 创建应用并点击 **连接**，待工具扫描完成后保存。

每台设备建立一个独立插件：`macmini` 插件只连接 `macmini` Tunnel，`desktop` 插件只连接 `desktop` Tunnel。不要把已有插件改指向另一台设备，也不要同时在两台电脑运行同一个 Tunnel。

创建、验证或扫描工具时，控制器中的 `tunnel-client run` 必须持续运行。Agent 更新工具 Schema 后，请在 ChatGPT 插件设置中重新扫描或刷新工具。

## 使用方式

- 点击“启动连接”后可关闭控制器窗口；服务继续在菜单栏或系统托盘运行。
- 点击菜单栏、系统托盘或 Dock 的 WebGPT Bridge 图标可重新打开窗口。
- 需要完全停止时，在窗口点击“停止”，或从图标菜单选择“停止服务”。
- 不要同时启动旧脚本、另一个 WebGPT Bridge 实例或手动 `tunnel-client run`；同一台电脑一次只能有一个实例占用端口。

## 源码开发与替换 Agent

```bash
git clone https://github.com/chinatownlittlewhite/webgpt-bridge.git
cd webgpt-bridge
npm ci
npm run prepare:tunnel-client:mac   # macOS Apple Silicon
# Windows x64 改用：npm run prepare:tunnel-client:win
npm run prepare:agent
npm start
```

`prepare:tunnel-client:*` 会从 OpenAI 官方 `v0.0.11` Release 下载对应平台归档，按 `scripts/tunnel-client-release.json` 中固定的 SHA-256 校验后解压到被 Git 忽略的 `build/tunnel-client/`。`npm run prepare:agent` 会在 `agent-runtime/` 安装锁定依赖并生成 `dist/server.js`。这些步骤仅供源码开发/构建使用；发行版用户不需要执行。

内置 Agent 的工具、审批策略、沙箱、测试和验收说明以 [`agent-runtime/README.md`](agent-runtime/README.md) 为准。该目录是普通源码子目录，不是 Git submodule。

构建发布包：

```bash
npm run dist:mac   # macOS Apple Silicon：DMG 与 ZIP
npm run dist:win   # Windows x64：NSIS 与 ZIP
```

产物写入 `release/`。正式 tag 发布由 `.github/workflows/build-desktop.yml` 在 macOS arm64 与 Windows x64 原生 runner 上分别下载并校验对应的 OpenAI `tunnel-client v0.0.11`、执行桌面测试、Agent native acceptance 和打包，再汇总到同一个 GitHub Release。`npm run prepare:agent` 会在 Windows 自动构建 AppContainer native helper，在其他系统上安全跳过该步骤。

## 故障排除

### 提示“未找到 Node.js”

安装 Node.js 20+ 后重启应用。也可在“Node.js（可选）”中选择可执行文件：

```text
macOS Apple Silicon Homebrew: /opt/homebrew/bin/node
macOS Intel Homebrew: /usr/local/bin/node
Windows: C:\Program Files\nodejs\node.exe
```

使用 NVM 时，应用会查找 `~/.nvm/versions/node/*/bin/node`；仍失败可手动指定。

### 提示“Agent 运行时目录中未找到 dist/server.js”

发行版默认内置此文件。若手动修改了“Agent 运行时目录”，请清空该字段恢复内置运行时，或在所选自定义目录执行：

```bash
npm ci
npm run build
```

确认 `dist/server.js` 存在后重新选择该目录。

### 提示“listen EADDRINUSE”或端口已被占用

已有旧实例占用了以下端口：`127.0.0.1:8787`（本地 Agent）或 `127.0.0.1:8080`（`tunnel-client` 本地健康服务）。先停止旧控制器或终端中的旧实例，再重新启动。

### 提示无法解密安全存储中的密钥

系统钥匙串、Windows 用户配置或应用安装状态变化后，旧加密数据可能不可再解密。请在应用中清除运行时密钥、保存设置后重新填写密钥；密钥不会从设置文件自动恢复。

## 安全边界

- 选择最小必要的工作区范围，不要选择整个磁盘或用户主目录。
- 即使启用受控本机开发代理，Agent 进程本身也不会获得整机文件系统、密钥或 shell 权限；只有桌面应用主进程通过本机 IPC 处理允许的结构化请求。
- 本机代理对非敏感路径采用“读取允许、写入可控、破坏性操作逐次确认”的策略；敏感路径和系统路径默认拒绝。
- 本地 Agent 固定监听 `127.0.0.1:8787`，不会直接暴露局域网端口。
- ChatGPT 网页版经受控 Tunnel 连接本机，而非直接访问 localhost。
- 实际文件权限、命令审批与沙箱强度由 `agent-runtime/` 实现；部署前应审查该目录的策略说明。
- 不提交运行时密钥、Tunnel ID、`.env`、SSH 密钥、VPN 凭据或任何工作区敏感文件。
