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

仍需自行准备：

1. 对应平台的 OpenAI `tunnel-client` 可执行文件。
2. OpenAI 平台中已创建的 Tunnel ID 与对应运行时密钥。
3. 一个范围尽可能小的本地工作区目录。

`tunnel-client`、Tunnel ID、运行时密钥和工作区文件均不包含在仓库或安装包中，也不得提交到 Git。

## 安装应用

在 [Releases](https://github.com/chinatownlittlewhite/webgpt-bridge/releases) 下载对应系统的最新发行包。当前发布包未签名或公证，请只从本仓库 Releases 下载，并在下载页核对 SHA-256。

当前 `v0.3.1` 提供 macOS Apple Silicon 与 Windows x64 安装包。macOS Intel 和通用包需要在相应目标平台构建、验证后才会发布，请不要下载旧版安装包替代新版。

| 平台 | 推荐下载 |
| --- | --- |
| macOS Apple Silicon | `WebGPT.Bridge-0.3.1-arm64.dmg`，也可下载 ZIP |
| macOS Intel | 当前未提供 v0.3.1 安装包 |
| Windows 10 / 11 x64 | `WebGPT.Bridge.Setup.0.3.1.exe`，也可下载 ZIP |

### macOS

1. 打开 DMG。
2. 将 `WebGPT Bridge.app` 拖到“应用程序”。
3. 首次打开如被 Gatekeeper 拦截：在 Finder 中按住 Control 点击应用，选择“打开”，再确认“打开”。

### Windows

1. 运行 `WebGPT.Bridge.Setup.0.3.1.exe`。
2. 按安装向导完成安装，可自行选择安装位置。
3. 若 SmartScreen 显示提示，先确认发布来源和 SHA-256；确认无误后选择“仍要运行”。

## 首次连接 ChatGPT

### 1. 准备 OpenAI Tunnel

在 OpenAI 平台创建或确认 Tunnel，并获取 Tunnel ID、运行时密钥及对应系统的 `tunnel-client` 可执行文件。

如果网络需要本机 HTTPS 代理，可在控制器“HTTPS 代理”中填写代理地址，例如：

```text
http://127.0.0.1:12001
```

只在代理确实运行在该地址时填写。运行时密钥仅通过 Electron 系统安全存储加密保存，不会明文写入设置文件。

### 2. 在控制器保存设置

打开 WebGPT Bridge，在主界面的“连接设置”中填写工作区目录、`tunnel-client`、Tunnel ID 和运行时密钥。运行时路径、Node、配置名称和 HTTPS 代理位于运行日志下方的“可选设置”。

| 字段 | 填写内容 |
| --- | --- |
| 工作区目录 | 允许 Agent 操作的项目根目录，或多个项目的共同父目录 |
| tunnel-client | OpenAI `tunnel-client` 可执行文件的完整路径 |
| Tunnel ID | OpenAI 平台创建的 `tunnel_...` |
| 运行时密钥 | OpenAI Tunnel 的运行时密钥；首次填入后点击“保存设置” |

“可选设置”包含：

| 字段 | 填写内容 |
| --- | --- |
| Agent 运行时目录 | 默认使用随应用附带的 `agent-runtime`；仅开发或替换 Agent 时修改 |
| Node.js（可选） | Node 可执行文件完整路径；留空时应用自动查找 Node 20+ |
| 配置名称 | 保持 `webgpt-bridge` 即可 |
| HTTPS 代理（可选） | 仅在需要代理访问 OpenAI 时填写 |

点击“启动连接”。启动成功时界面应显示“本地 Agent：运行中”和“Secure MCP Tunnel：已连接”。本机诊断地址为 `http://127.0.0.1:8787/healthz`；这些本机地址不能直接填写到 ChatGPT 网页版连接器中。

### 3. 在 ChatGPT 网页版启用连接器

保持控制器运行，并在 ChatGPT 网页版打开 Apps / Connectors，创建或打开对应的 Secure MCP Tunnel 连接器，扫描工具并保存。创建、验证或扫描时，`tunnel-client run` 必须持续运行。Agent 更新了工具 Schema 后，请在 ChatGPT 设置中重新扫描或刷新工具。

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
npm run prepare:agent
npm start
```

`npm run prepare:agent` 会在 `agent-runtime/` 安装锁定依赖并生成 `dist/server.js`。仅在修改或替换 Agent 时才需要运行它；发行版用户不需要执行此步骤。

内置 Agent 的工具、审批策略、沙箱、测试和验收说明以 [`agent-runtime/README.md`](agent-runtime/README.md) 为准。该目录是普通源码子目录，不是 Git submodule。

构建发布包：

```bash
npm run dist:mac   # macOS：DMG 与 ZIP
npm run dist:win   # Windows：NSIS 与 ZIP
```

产物写入 `release/`。macOS 可在 Mac 上构建；Windows 包建议在 Windows 上构建，以便 `node-pty` 等原生可选依赖适配目标平台。

Windows 端如需启用 Agent 的 AppContainer 原生沙箱，进入 `agent-runtime/` 后执行 `npm run build:native`，并在 Windows 真机完成 `npm run acceptance`。当前 Release 已打包 Windows x64 控制器及 MCP 运行时；该原生沙箱助手必须在 Windows 上单独构建和验收。

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
- 本地 Agent 固定监听 `127.0.0.1:8787`，不会直接暴露局域网端口。
- ChatGPT 网页版经受控 Tunnel 连接本机，而非直接访问 localhost。
- 实际文件权限、命令审批与沙箱强度由 `agent-runtime/` 实现；部署前应审查该目录的策略说明。
- 不提交运行时密钥、Tunnel ID、`.env`、SSH 密钥、VPN 凭据或任何工作区敏感文件。
