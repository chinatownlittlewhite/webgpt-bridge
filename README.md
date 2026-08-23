# WebGPT Bridge

WebGPT Bridge 是一个桌面控制器：它在本机启动一个独立的 MCP Agent 运行时，并使用 OpenAI Secure MCP Tunnel 让 ChatGPT 网页版能够调用该 Agent。

它不是云端代理，也不把项目文件上传到本仓库。文件读取、修改、Git 操作和项目命令由你本机的 Agent 运行时执行；控制器负责保存配置、启动/停止服务、显示日志，并在关闭窗口后继续通过菜单栏运行。

## 架构

\`\`\`text
ChatGPT 网页版
       |
OpenAI Secure MCP Tunnel
       |
WebGPT Bridge 桌面控制器
       |
本地 MCP Agent 运行时 (dist/server.js)
       |
你选择的工作区目录
\`\`\`

## 重要说明

本仓库和发布安装包只包含 **WebGPT Bridge 控制器**，不包含 MCP Agent 运行时，也不包含 \`tunnel-client\`。

首次部署必须准备以下三项：

1. 一个已构建的 Agent 运行时目录，其中必须存在 \`dist/server.js\`。
2. OpenAI \`tunnel-client\` 可执行文件。
3. OpenAI 平台中已创建的 Tunnel ID 与对应的运行时密钥。

不要将工作区设为整个磁盘或用户主目录。控制器会把所选目录传给 Agent，实际可访问范围仍取决于该 Agent 的策略和沙箱实现。

## 下载

从 [Releases](https://github.com/chinatownlittlewhite/webgpt-bridge/releases) 下载对应平台的文件：

| 平台 | 推荐下载 |
| --- | --- |
| macOS（Apple Silicon 与 Intel） | \`WebGPT.Bridge-0.2.2-universal.dmg\` |
| Windows 10 / 11 x64 | \`WebGPT.Bridge.Setup.0.2.2.exe\` |

同页也提供 ZIP 便携包。仅从本仓库的 Releases 下载，并在下载页核对 SHA-256。

当前 macOS 和 Windows 构建未进行开发者证书签名或公证。macOS Gatekeeper 或 Windows SmartScreen 可能显示提示；请只在确认文件来自本仓库 Release 且 SHA-256 一致后继续安装。

## 安装控制器

### macOS

1. 打开 DMG。
2. 将 \`WebGPT Bridge.app\` 拖到“应用程序”。
3. 首次打开如被 Gatekeeper 拦截：在 Finder 中按住 Control 点击应用，选择“打开”，再确认“打开”。

### Windows

1. 运行 \`WebGPT.Bridge.Setup.0.2.2.exe\`。
2. 按安装向导完成安装，可自行选择安装位置。
3. 若 SmartScreen 显示提示，先确认发布来源和 SHA-256；确认无误后选择“仍要运行”。

## 第一步：构建 MCP Agent 运行时

这一步必须在 **Agent 运行时项目** 中完成，而不是在本仓库中完成。

假设 Agent 运行时位于：

\`\`\`text
macOS: /Users/you/Desktop/chatgpt-web-mcp-project
Windows: C:\Users\you\Desktop\chatgpt-web-mcp-project
\`\`\`

需要 Node.js 20 或更高版本。进入 Agent 项目后执行：

\`\`\`bash
npm ci
npm run build
\`\`\`

如果该项目没有 \`package-lock.json\`，使用：

\`\`\`bash
npm install
npm run build
\`\`\`

构建完成后，必须确认下列文件存在：

\`\`\`text
<Agent 运行时目录>/dist/server.js
\`\`\`

macOS / Linux：

\`\`\`bash
test -f dist/server.js && echo "Agent build OK"
\`\`\`

Windows PowerShell：

\`\`\`powershell
Test-Path .\dist\server.js
\`\`\`

结果应为 \`True\`。若控制器提示“未找到 dist/server.js”，说明选错了目录，或尚未在该 Agent 项目执行构建。

> Agent 的 MCP 工具数量、具体工具名、审批策略、沙箱和测试命令由 Agent 运行时项目决定，不由本控制器仓库决定。请以该项目自己的 README 和 \`package.json\` 为准。

## 第二步：准备 OpenAI Tunnel

在 OpenAI 平台创建或确认 Tunnel，并获取：

- Tunnel ID，格式类似 \`tunnel_...\`
- 运行时密钥（Runtime API key）
- 对应平台的 \`tunnel-client\` 可执行文件

控制器使用的命令等价于：

\`\`\`bash
tunnel-client init --force \
  --profile webgpt-bridge \
  --tunnel-id tunnel_... \
  --mcp-server-url http://127.0.0.1:8787/mcp

tunnel-client run --profile webgpt-bridge
\`\`\`

不要把运行时密钥提交到 Git、截图或聊天记录中。WebGPT Bridge 使用系统安全存储保存它，不会以明文写入设置文件。

如果网络需要本地代理，可在控制器“HTTPS 代理”中填入代理地址，例如：

\`\`\`text
http://127.0.0.1:12001
\`\`\`

只有你的代理确实在该地址运行时才填写。

## 第三步：首次配置 WebGPT Bridge

打开应用，展开“高级设置”，填写：

| 字段 | 填写内容 |
| --- | --- |
| 工作区目录 | 允许 Agent 操作的项目根目录，或多个项目的共同父目录 |
| Agent 运行时目录 | 上一步构建完成、包含 \`dist/server.js\` 的目录 |
| tunnel-client | OpenAI \`tunnel-client\` 可执行文件的完整路径 |
| Node.js（可选） | Node 可执行文件完整路径；留空时应用会自动查找 Node、Homebrew Node 或 NVM Node |
| Tunnel ID | OpenAI 平台创建的 \`tunnel_...\` |
| 配置名称 | 保持 \`webgpt-bridge\` 即可 |
| HTTPS 代理（可选） | 仅在需要代理访问 OpenAI 时填写 |
| 运行时密钥 | OpenAI Tunnel 的运行时密钥；首次填入后点击“保存设置” |

然后点击“启动连接”。

启动成功时界面应显示：

\`\`\`text
本地 Agent：运行中
Secure MCP Tunnel：已连接
控制器：关闭窗口后继续运行
\`\`\`

本地健康检查地址为：

\`\`\`text
http://127.0.0.1:8787/healthz
\`\`\`

本地 MCP 地址为：

\`\`\`text
http://127.0.0.1:8787/mcp
\`\`\`

这些本地地址供本机诊断或本地 MCP 客户端使用，**不能直接填给 ChatGPT 网页版**。

## 第四步：在 ChatGPT 网页版添加连接器

必须先让 WebGPT Bridge 保持“已连接”。

在 ChatGPT 网页版进入设置中的 Apps / Connectors（不同账户和版本的名称可能略有不同），创建或编辑对应的自定义 MCP 连接器：

1. 使用 OpenAI Tunnel 创建的连接器信息或远程 MCP Endpoint。
2. 扫描工具并保存。
3. 回到聊天页面，在可用 Apps / Connectors 中启用 WebGPT Bridge。

\`tunnel-client\` 日志会提示：创建或验证 ChatGPT 连接器时，必须保持 \`tunnel-client run\` 正在运行。不要把 \`http://127.0.0.1:8787/mcp\` 直接作为网页端连接器 URL。

如果 Agent 运行时后来改变了工具 Schema，请在 ChatGPT 设置中重新扫描/刷新工具。

## 日常使用

- 点击“启动连接”后，可以关闭控制器窗口；服务会继续在菜单栏运行。
- 点击菜单栏的 WebGPT Bridge 图标，或 Dock 图标，可重新打开控制器。
- 需要完全停止时，在控制器中点击“停止”，或从菜单栏菜单选择“停止服务”。
- 不要同时启动旧版脚本、另一个 WebGPT Bridge 实例或手动 \`tunnel-client run\`。同一台机器一次只应有一个实例占用端口。

## 故障排除

### 提示“未找到 Node.js”

安装 Node.js 20+ 后重启应用。也可在“Node.js（可选）”中选择 Node 可执行文件：

\`\`\`text
macOS Homebrew: /opt/homebrew/bin/node
macOS Intel Homebrew: /usr/local/bin/node
Windows: C:\Program Files\nodejs\node.exe
\`\`\`

如果使用 NVM，v0.2.2 会自动查找 \`~/.nvm/versions/node/*/bin/node\`；仍失败时手动指定该文件即可。

### 提示“Agent 运行时目录中未找到 dist/server.js”

在正确的 Agent 运行时目录执行：

\`\`\`bash
npm ci
npm run build
\`\`\`

然后确认 \`dist/server.js\` 存在，并在控制器中重新选择该目录。

### 提示 “listen EADDRINUSE” 或端口已被占用

说明已有旧实例占用了端口：

- \`127.0.0.1:8787\`：本地 Agent
- \`127.0.0.1:8080\`：tunnel-client 的本地健康服务

先在旧控制器或终端停止旧实例，再从当前控制器点击“启动连接”。不要通过多开实例解决端口冲突。

macOS 可检查端口占用：

\`\`\`bash
lsof -nP -iTCP:8787 -sTCP:LISTEN
lsof -nP -iTCP:8080 -sTCP:LISTEN
\`\`\`

Windows PowerShell：

\`\`\`powershell
Get-NetTCPConnection -LocalPort 8787,8080 -ErrorAction SilentlyContinue
\`\`\`

### 提示无法解密安全存储中的密钥

在“高级设置”的“运行时密钥”重新粘贴运行时密钥，并点击“保存设置”。旧版本改名后的 macOS 密钥会在 v0.2.2 自动尝试迁移；迁移失败时重新保存即可。

### ChatGPT 能发现工具但调用失败

确认以下事项：

1. 控制器仍显示“本地 Agent：运行中”和“Secure MCP Tunnel：已连接”。
2. ChatGPT 连接器的工具已重新扫描。
3. Agent 运行时的日志没有显示错误。
4. 工作区仍存在且权限正常。
5. 不要在同一个 Tunnel 下同时启动多个 Agent 实例。

## 从源码构建控制器

控制器开发环境只需要 Node.js 20+：

\`\`\`bash
git clone https://github.com/chinatownlittlewhite/webgpt-bridge.git
cd webgpt-bridge
npm ci
\`\`\`

本地启动控制器：

\`\`\`bash
npm start
\`\`\`

构建发布包：

\`\`\`bash
npm run dist:all
\`\`\`

输出位于 \`release/\`：

\`\`\`text
WebGPT Bridge-<version>-universal.dmg
WebGPT Bridge-<version>-universal-mac.zip
WebGPT Bridge Setup <version>.exe
WebGPT Bridge-<version>-win.zip
\`\`\`

本仓库当前没有 \`npm run dev\`、\`npm run build\`、\`npm test\`、\`npm run acceptance\` 或 \`npm run build:native\` 脚本；这些命令不适用于控制器仓库。

## 安全边界

- 选择最小必要的工作区范围。
- 运行时密钥仅保存在系统安全存储中。
- 控制器固定让 Agent 监听 \`127.0.0.1:8787\`，不直接暴露局域网端口。
- ChatGPT 网页版通过受控 Tunnel 连接本机，而非直接访问 localhost。
- 实际文件权限、命令审批和沙箱强度由 Agent 运行时实现；部署前应审查该 Agent 项目的策略。

## License

[MIT](LICENSE)
