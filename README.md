# WebGPT Bridge

一个轻量的 macOS / Windows 控制器：在本机启动你的 Agent 运行时，并通过 OpenAI Secure MCP Tunnel 让 ChatGPT 网页版安全调用它。

关闭主窗口后，连接会继续在菜单栏（Windows 为系统托盘）运行；从图标菜单可重新打开、停止或退出。

## 快速部署

1. 安装本项目的发行包，并安装 Node.js 20+（支持通过官方安装器或 NVM 安装）。
2. 准备 Agent 运行时：在其目录运行 `npm install` 和 `npm run build`，确认生成 `dist/server.js`。
3. 打开 WebGPT Bridge，在“高级设置”中选择工作区、Agent 运行时目录和 OpenAI `tunnel-client`，填入本机的 Tunnel ID 与运行时密钥。
4. 点击“启动连接”，然后回到 ChatGPT 网页版使用连接器。关闭窗口不会中断连接。

设置和密钥均按电脑独立保存。更换 Agent 版本后，只需重新构建该运行时；无需重新打包控制器。

## 开发与打包

```bash
npm install
npm start
npm run dist:mac   # macOS：DMG 与 ZIP
npm run dist:win   # Windows：NSIS 与 ZIP（建议在 Windows 构建）
```

构建产物写入 `release/`。

## 安全边界

- MCP 服务固定监听 `127.0.0.1:8787`，不会直接公开到互联网。
- Tunnel 通过客户端主动发起 HTTPS 连接。
- 运行时密钥使用 Electron `safeStorage` 加密保存，配置文件不保存明文密钥。
- 请勿提交运行时密钥、Tunnel ID、`.env`、SSH 密钥或 VPN 凭据。
