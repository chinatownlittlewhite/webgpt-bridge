# WebGPT Bridge 安装、网络代理与故障排除

本指南面向直接从 GitHub Releases 安装 WebGPT Bridge 的 macOS 和 Windows 用户。源码开发说明仍以 [`README.md`](README.md) 和 [`agent-runtime/README.md`](agent-runtime/README.md) 为准。

## 1. 下载正确的安装包

请只从本仓库的 GitHub Releases 下载正式版本，并优先使用当前版本对应的平台安装包：

- macOS Apple Silicon / Intel：`WebGPT-Bridge-<version>-mac-universal.dmg`
- Windows 10 / 11 x64：`WebGPT-Bridge-<version>-win-x64.exe`

正式 Release 同时提供 `SHA256SUMS`。如果浏览器、系统安全软件或安装器给出来源警告，先核对下载来源和 SHA-256，再决定是否继续。

macOS 可在终端核对：

```bash
shasum -a 256 "WebGPT-Bridge-<version>-mac-universal.dmg"
```

Windows PowerShell 可核对：

```powershell
Get-FileHash ".\WebGPT-Bridge-<version>-win-x64.exe" -Algorithm SHA256
```

将结果与同一 GitHub Release 中 `SHA256SUMS` 对应条目比较。

## 2. 网络、VPN 与 HTTPS 代理

WebGPT Bridge 的本地 Agent 只监听本机回环地址，不需要开放公网入站端口；Secure MCP Tunnel 需要从本机向外访问 OpenAI 服务。安装和首次配置阶段还需要能够访问 GitHub Releases、OpenAI Platform 和 ChatGPT 网页。

如果所在网络无法直接访问这些服务，请先启用你自己的合规 VPN/网络代理。**WebGPT Bridge 不提供 VPN 服务，也不要把 VPN 订阅链接、订阅密钥或账号密码填写进应用。**

运行时 `tunnel-client` 主要需要能够访问：

```text
api.openai.com:443
```

### 在 WebGPT Bridge 中填写代理

打开 WebGPT Bridge，在“权限与高级设置”中找到 **HTTPS 代理（可选）**。

常见的本机 HTTP 代理示例：

```text
http://127.0.0.1:7890
```

如果代理程序显示本机 HTTP/HTTPS 代理端口为 `7890`，也可以只填写：

```text
7890
```

应用会将纯端口规范化为：

```text
http://127.0.0.1:7890
```

当前代理字段的约束：

- 仅支持 `http://` 或 `https://` 代理 URL。
- 不支持把 `socks5://...` 直接填入该字段；如果代理软件同时提供 HTTP/HTTPS 代理端口，请使用那个端口。
- URL 中不能包含用户名、密码、路径、query 或 hash。
- 不要填写 VPN 订阅地址、机场订阅链接、配置文件地址或 API Token。
- 只有代理程序确实在对应主机/端口监听时才填写。
- `127.0.0.1`、`localhost` 和 `::1` 会保留为直连，避免本地 Agent 流量被送入代理。

平台差异：

- **macOS**：如果“HTTPS 代理”留空，应用会尝试读取 macOS 当前启用的系统 HTTP/HTTPS 代理设置；如果希望强制使用某个本机代理，也可以显式填写。
- **Windows**：当前不会自动读取系统代理作为 Tunnel 环境；需要代理时请在 WebGPT Bridge 中手工填写 HTTP/HTTPS 代理地址或本机端口。

修改代理后，建议先“停止”当前连接，再重新“启动连接”，让新的 Tunnel 进程使用最新代理环境。

### 代理填写后仍无法连接

依次检查：

1. VPN/代理软件本身已经启动，并确认其 **HTTP/HTTPS 代理端口**，不要误用 SOCKS-only 端口。
2. 代理地址没有包含账号密码、路径或订阅链接。
3. 浏览器在同一网络环境下能打开 OpenAI Platform / ChatGPT。
4. 防火墙或公司网络没有阻止到 `api.openai.com:443` 的 HTTPS 出站连接。
5. Tunnel ID 和运行时密钥属于同一正确的 OpenAI Platform 配置。
6. 运行时密钥至少具有 **Tunnels: Read** 和 **Tunnels: Use** 权限。

如果直连可用，不需要为了“保险”填写代理；错误的本机代理地址反而会导致 Tunnel 无法启动或连接。

## 3. macOS 安装

1. 下载 `WebGPT-Bridge-<version>-mac-universal.dmg`。
2. 打开 DMG。
3. 将 `WebGPT Bridge.app` 拖到“应用程序”。
4. 从“应用程序”启动 WebGPT Bridge。

### macOS 提示无法验证开发者或阻止打开

当前公开 Release 采用未强制 Developer ID 签名/notarization 的直接分发模式，所以 Gatekeeper 可能提示来源或公证警告。

先确认安装包来自本仓库正式 Release，并核对 SHA-256。确认无误后，在 Finder 的“应用程序”中按住 Control 点击 `WebGPT Bridge.app`，选择“打开”，再在系统提示中确认“打开”。

不要为了安装本应用永久关闭 Gatekeeper，也不建议关闭系统整体安全保护。

### macOS 提示“未找到 Node.js”

macOS 当前需要可用的 Node.js 20+。安装 Node.js 后完全退出并重新打开 WebGPT Bridge；仍然无法识别时，可在“Node.js（可选）”中手工选择 `node` 可执行文件。

常见路径：

```text
Apple Silicon Homebrew: /opt/homebrew/bin/node
Intel Homebrew:         /usr/local/bin/node
```

如果使用 NVM，应用会查找：

```text
~/.nvm/versions/node/*/bin/node
```

### macOS 已设置系统代理但 Tunnel 仍不通

确认系统设置中启用的是 HTTP/HTTPS 代理而不只是 SOCKS 代理。也可以在 WebGPT Bridge 的“HTTPS 代理”中显式填写代理软件提供的 HTTP/HTTPS 本机端口，例如 `7890`，然后重启连接。

## 4. Windows 安装

1. 下载 `WebGPT-Bridge-<version>-win-x64.exe`。
2. 核对 SHA-256。
3. 运行安装器并按向导完成安装。

Windows 正式发行当前是 **per-machine NSIS** 安装器，需要管理员权限完成受保护目录和 WebGPT Bridge 自身 AppContainer host preparation 的安装。

### Windows SmartScreen 显示“Windows 已保护你的电脑”

当前公开 Release 不要求外部代码签名凭据，因此 SmartScreen 可能显示信誉警告。

先确认文件来自本仓库正式 GitHub Release，并核对 `SHA256SUMS`。确认无误后再使用系统提供的“更多信息”/“仍要运行”流程。不要从第三方网盘或重打包站点下载安装器。

### Windows 安装器提示权限不足或安装失败

- 确认当前账户可以执行管理员授权。
- 关闭旧版 WebGPT Bridge 后再重试安装。
- 如果企业设备由组织策略管理，安装 Program Files、创建系统任务或 AppContainer 相关配置可能被管理员策略限制，此时需要联系设备管理员。
- 如果安全软件拦截文件，不要直接永久关闭安全软件；先核对官方 Release 和 SHA-256，并查看安全软件给出的具体拦截原因。

### Windows 是否需要自己安装 Node.js

不需要。Windows 正式安装包已经内置并优先使用 Node 22。只有开发或手工替换运行时时才通常需要单独配置 Node。

### Windows 使用 VPN/代理后仍无法连接

Windows 当前需要在 WebGPT Bridge 的“HTTPS 代理（可选）”中手工填写代理软件提供的 **HTTP/HTTPS** 本机地址/端口；仅在系统里开启代理或只提供 SOCKS 代理并不等同于应用已获得正确的 Tunnel 代理配置。

例如本机代理程序提供 HTTP 端口 `7890`，填写：

```text
http://127.0.0.1:7890
```

或直接填写：

```text
7890
```

## 5. 首次连接前需要准备什么

每台电脑都应单独准备：

1. 一个 OpenAI Platform Tunnel ID，格式类似 `tunnel_...`。
2. 该设备独立的 Tunnel 运行时密钥。
3. 一个范围尽可能小的本地工作区目录。

不要让两台电脑共用同一个 Tunnel ID 或运行时密钥。运行时密钥应使用 Restricted 权限，并只授予 Tunnel 所需的权限；不要把密钥放进聊天、Issue、截图、README、Git 或工作区文件。

正式安装包已经内置对应平台的 OpenAI `tunnel-client v0.0.13`，普通用户不需要另外下载 tunnel-client，也不要随意填写“自定义 tunnel-client”。

## 6. 常见启动与连接问题

### “Secure MCP Tunnel”无法连接

检查：

- Tunnel ID 是否复制完整、没有多余空格。
- 运行时密钥是否仍有效，并具有 `Tunnels: Read` / `Tunnels: Use`。
- 是否误让两台机器同时运行同一个 Tunnel。
- VPN/代理是否可用；需要代理时是否填写了 HTTP/HTTPS 代理端口。
- 是否存在公司防火墙、HTTPS 检查或安全策略阻止 OpenAI HTTPS 出站连接。

### 提示“HTTPS 代理 URL 格式无效”

使用以下形式之一：

```text
7890
http://127.0.0.1:7890
https://proxy.example.com:8443
```

不要使用：

```text
socks5://127.0.0.1:7891
http://user:password@127.0.0.1:7890
http://127.0.0.1:7890/path
```

### 提示 `listen EADDRINUSE` 或端口已被占用

常用本机端口：

- `127.0.0.1:8787`：本地 Agent。
- `127.0.0.1:8080`：`tunnel-client` 本地健康服务。

先退出旧的 WebGPT Bridge 实例、停止旧脚本或手工启动的 `tunnel-client run`，再重新启动。关闭主窗口不等于退出应用；WebGPT Bridge 默认会继续在 macOS 菜单栏或 Windows 系统托盘运行。

### 提示“Agent 运行时目录中未找到 dist/server.js”

正式发行版默认内置 Agent。若此前手工修改过“Agent 运行时目录”，请清空该字段恢复内置运行时。

源码开发者使用自定义 Agent 目录时，需要在对应目录完成依赖安装和构建，并确认存在：

```text
dist/server.js
```

### 提示无法解密安全存储中的运行时密钥

系统钥匙串、Windows 用户配置、系统迁移或应用安装状态发生变化后，旧加密数据可能无法继续解密。请在应用中清除旧运行时密钥、保存设置，再重新填写该设备对应的密钥。

### 本地 Agent 显示正常，但 ChatGPT 看不到工具

1. 保持 WebGPT Bridge 的 Secure MCP Tunnel 处于已连接状态。
2. 在 ChatGPT 中确认创建的是当前设备对应的 Tunnel/隧道连接。
3. 身份验证选择“无”；不要把 Tunnel 运行时密钥填写到 ChatGPT 插件表单。
4. Agent 或工具 Schema 更新后，在 ChatGPT 插件/Apps/Connectors 设置中重新扫描或刷新工具。
5. 不要把 `http://127.0.0.1:8787` 直接填写到 ChatGPT 网页连接器；该地址仅用于本机诊断。

### 如何判断本地 Agent 是否启动

在本机浏览器访问：

```text
http://127.0.0.1:8787/healthz
```

该地址只应从本机访问。如果它不可用，先处理本地 Agent/Node/端口问题；如果本地健康检查正常但 Tunnel 不通，再排查 Tunnel ID、密钥和 VPN/代理。

## 7. 更新和旧版本问题

WebGPT Bridge 会检查 GitHub Releases 中的新版本，但当前未签名发行模式不会静默下载、自动安装或自动重启。发现新版本后，请从本仓库 Release 手工下载并安装。

升级前建议：

- 停止当前连接并完全退出旧实例。
- 从正式 Release 下载与平台匹配的新安装包。
- 核对 `SHA256SUMS`。
- 不要同时保留并运行多个版本的 WebGPT Bridge 或多个手工 Tunnel 进程。

如果更新检查失败但当前版本能够正常连接，可以继续使用当前版本；更新检查失败本身不代表本地 Agent 已停止。

## 8. 安全提示

- 工作区选择最小必要目录，不要选择整个磁盘或整个用户主目录。
- 不要在文档、Issue、聊天、截图或 Git 中公开 Tunnel 运行时密钥。
- 不要把 VPN/代理账号、订阅链接、SSH 密钥、`.env`、云凭据或包管理器认证信息交给 Agent。
- 不要为了处理一次安装警告永久关闭 Gatekeeper、SmartScreen、防火墙或安全软件。
- 代理字段只用于为 WebGPT Bridge/Tunnel 提供 HTTP/HTTPS 出站代理，不是 VPN 客户端，也不会替你管理 VPN 配置。

如果问题仍无法解决，提交 Issue 时请提供：操作系统版本、WebGPT Bridge 版本、报错文本、连接状态，以及是否使用 VPN/代理；请先删除 Tunnel ID、运行时密钥、代理凭据、用户名和本机敏感路径等信息。