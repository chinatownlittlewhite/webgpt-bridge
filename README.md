# WebGPT Bridge

> 将本地项目安全地连接到 ChatGPT / MCP 客户端，让 AI 可以读取代码、修改文件、运行项目任务、管理 Git、执行长进程，并通过 Goal Mode 持续完成复杂开发目标。

WebGPT Bridge 是一个面向本地开发环境的 MCP 应用程序。它把本地项目能力封装为受控工具，并通过 **工作区隔离、精确审批、原生系统沙箱、Goal Mode、审计日志和验收门禁** 限制高风险操作。

---

## 功能概览

- Windows / macOS 原生运行
- MCP HTTP Server
- 23 个受控开发工具
- 项目文件读取、目录浏览、文本搜索
- SHA-256 保护的结构化文件修改
- Git / Git Worktree
- 项目 test / lint / build / typecheck
- 长进程与 PTY
- Goal Mode 持续执行
- Goal Session 持久化与重启恢复
- 多 Agent Worktree 隔离
- 精确请求审批
- 原生 Sandbox 验证
- Hash Chain 审计日志
- ChatGPT MCP App 接入
- 外部 Autonomous Orchestrator 接口

---

# 工作原理

```text
ChatGPT / MCP Client
        │
        │ MCP
        ▼
┌─────────────────────────────┐
│       WebGPT Bridge         │
│                             │
│  MCP Server                 │
│       │                     │
│       ├─ Goal Mode          │
│       ├─ Tool Policy        │
│       ├─ Approval           │
│       ├─ Audit              │
│       └─ Process Manager    │
│              │              │
│        Native Sandbox       │
└──────────────┬──────────────┘
               │
               ▼
        本地代码项目 / Git
```

普通命令不会直接通过模型控制的 Shell 执行。

默认策略：

```text
模型参数
→ Schema 校验
→ Workspace / Goal cwd 校验
→ Command Policy
→ 必要时用户审批
→ Native Sandbox
→ 本地进程
→ 审计记录
```

---

# 支持平台

| 平台 | 状态 | Sandbox |
|---|---|---|
| Windows 10 / 11 | 原生支持候选 | AppContainer + ACL + Job Object |
| macOS | 原生支持候选 | Seatbelt + Parent Guard |
| Linux | 支持 | Bubblewrap |

> 一个平台只有在该平台真实执行 `npm run acceptance` 并返回 `exit 0` 后，才视为最终验收通过。

---

# 下载与安装

前往：

**GitHub Releases**

https://github.com/chinatownlittlewhite/webgpt-bridge/releases

下载与你操作系统对应的安装包。

安装并打开 WebGPT Bridge。

首次启动时建议先使用默认配置完成本机测试，不要一开始就开放到公网。

---

# 第一次启动应该怎么填

应用中的配置项可以分成三类：

```text
必须设置
├─ Workspace / 项目目录
├─ MCP Token
└─ Request State Key

通常保持默认
├─ Host
├─ Port
├─ Verify Sandbox
└─ Audit

只有远程部署才需要
├─ Allowed Hosts
├─ Allowed Origins
└─ Secure MCP Tunnel / HTTPS Endpoint
```

---

# 应用配置字段完整说明

## 一览表

| 配置项 | 推荐值 | 值从哪里来 |
|---|---|---|
| Workspace / 项目目录 | 你的代码项目或项目父目录 | 在 Finder / 文件资源管理器中选择 |
| Host | `127.0.0.1` | 本机部署直接使用默认值 |
| Port | `8787` | 使用默认值；端口冲突时换一个空闲端口 |
| MCP Token | 随机强 Token | 点击应用中的“生成”按钮，或自己生成随机值 |
| Request State Key | 独立随机密钥 | 点击“生成”；不要和 MCP Token 共用 |
| Allowed Hosts | 你的远程域名 | 只有远程部署需要 |
| Allowed Origins | 允许访问的网页域名 | 只有远程部署需要，通常可以留空或按部署要求填写 |
| Verify Sandbox | 开启 | 推荐始终开启 |
| Enable Network Tools | 默认关闭 | 需要依赖下载 / GitHub 工具时再开启 |
| Windows Sandbox Helper | 自动检测 | Windows 普通用户无需填写 |
| Audit | 开启 | 推荐始终开启 |

下面逐项说明。

---

## 1. Workspace / 项目目录

### 这是什么？

Workspace 决定 WebGPT Bridge **最多可以访问哪些本地文件**。

例如你的项目位于：

```text
/Users/alice/Desktop/my-project
```

就可以直接选择：

```text
/Users/alice/Desktop/my-project
```

如果你希望一个 Bridge 管理 Desktop 下多个项目，也可以选择：

```text
/Users/alice/Desktop
```

但 Goal Mode 仍会继续使用单独的项目 `cwd` 作为任务边界。

### 推荐

单项目使用：

```text
直接选择项目根目录
```

多项目使用：

```text
选择这些项目共同的父目录
```

不要为了方便直接选择：

```text
/
C:\
整个用户主目录
```

除非你清楚这样做会扩大 Bridge 的可访问范围。

### macOS 如何获取路径

Finder 中找到项目文件夹：

```text
右键文件夹
→ 按住 Option
→ 拷贝“xxx”作为路径名称
```

或者在终端进入项目后：

```bash
pwd
```

### Windows 如何获取路径

文件资源管理器打开项目：

```text
点击地址栏
→ 复制完整路径
```

或者 PowerShell：

```powershell
(Get-Location).Path
```

例如：

```text
C:\Users\Alice\Desktop\my-project
```

---

## 2. Host

### 本机使用

推荐：

```text
127.0.0.1
```

这表示 MCP Server 只监听当前电脑。

这是最安全、也是推荐的默认配置。

### 不建议普通用户填写

```text
0.0.0.0
```

因为它代表：

```text
监听所有网络接口
```

只有你明确要做局域网 / 远程部署，并已经配置 Token、Host 白名单、防火墙或安全隧道时，才应该使用。

---

## 3. Port

默认：

```text
8787
```

本机 MCP Endpoint 将类似：

```text
http://127.0.0.1:8787/mcp
```

健康检查：

```text
http://127.0.0.1:8787/healthz
```

如果 8787 被其他程序占用，可以换成：

```text
8788
9000
18888
```

只要没有被其他程序占用即可。

---

## 4. MCP Token

### 这是什么？

MCP Token 用于保护你的 MCP Server。

如果你把 WebGPT Bridge 暴露到非本机网络，没有 Token 的人不应该能够调用你的开发工具。

### 从哪里获取？

**它不是从 OpenAI、ChatGPT 或 GitHub 获取的。**

这是你自己为 WebGPT Bridge 生成的随机密钥。

如果应用提供：

```text
生成 Token
```

直接点击即可。

推荐长度：

```text
至少 32 字节随机值
```

### macOS / Linux 手动生成

```bash
openssl rand -hex 32
```

会得到类似：

```text
8c1c8f...64位十六进制...
```

### 使用 Node.js 生成

Windows / macOS / Linux 都可以：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 注意

不要使用：

```text
123456
password
你的 GitHub 密码
你的 ChatGPT 密码
OpenAI API Key
```

MCP Token 应该是单独生成的随机值。

不要上传到 GitHub。

---

## 5. Request State Key

### 这是什么？

Request State Key 用于签名 WebGPT Bridge 的 MCP 审批状态。

它确保：

```text
用户批准的操作 A
```

不能被拿去重放成：

```text
操作 B
```

### 从哪里获取？

它也不是外部服务提供的。

**自己生成一个独立随机密钥即可。**

推荐直接点击应用中的：

```text
生成 Request State Key
```

如果手动生成，可使用和 MCP Token 相同的随机生成方法。

但是：

> Request State Key 和 MCP Token 必须使用两个不同的随机值。

### 为什么建议固定保存？

如果每次启动都重新生成，正在进行中的 MCP 审批状态在应用重启后会失效。

生产环境建议保存一个稳定值。

---

## 6. Allowed Hosts

只有你把 Bridge 暴露到远程网络时才需要。

例如 MCP 服务地址是：

```text
https://bridge.example.com
```

则填写：

```text
bridge.example.com
```

多个 Host 可以按应用支持的格式填写，例如：

```text
bridge.example.com,mcp.example.com
```

### 不要填写

```text
https://bridge.example.com
```

这里需要的是：

```text
hostname
```

不是完整 URL。

本机：

```text
127.0.0.1
```

模式通常无需手动设置该字段。

---

## 7. Allowed Origins

这是浏览器请求的 Origin 白名单。

远程部署时，如果你的入口来自：

```text
https://example.com
```

一般填写：

```text
example.com
```

如果你不知道这个配置是什么：

```text
本机部署保持默认即可
```

不要为了“防止报错”填写：

```text
*
```

---

## 8. Verify Sandbox

推荐：

```text
开启
```

WebGPT Bridge 不会仅因为系统存在 Sandbox 程序就认为它安全。

启动时会验证：

```text
项目目录可以写入
项目外读取被阻止
项目外写入被阻止
普通命令网络被阻止
```

只有真实验证通过的 Sandbox 才会被提升为：

```text
autoRunSafe = true
```

如果验证失败：

```text
不会假装已经隔离
```

需要审批的命令仍会要求用户确认。

---

## 9. Enable Network Tools

默认推荐：

```text
关闭
```

普通：

```text
run_command
```

默认不应该访问互联网。

只有以下结构化工具可能需要联网：

```text
dependency_sync
github
```

例如：

```text
npm install
pnpm install
GitHub PR / CI / Issue
```

需要这些功能时再开启：

```text
Enable Network Tools
```

联网 Sandbox 也需要单独通过文件系统隔离验证。

---

## 10. Windows Sandbox Helper

Windows 用户正常安装应用后：

```text
保持自动检测
```

即可。

应用会查找打包的 Windows Native Helper。

只有开发者自己编译 native helper 时才需要指定路径。

开发版默认目标类似：

```text
native/windows-sandbox/bin/release/lpc-windows-sandbox.exe
```

普通用户不要手工修改。

---

## 11. Audit / 审计日志

推荐：

```text
开启
```

默认审计文件位于 Workspace：

```text
.local-project-coding/audit.jsonl
```

日志包含 Hash Chain：

```text
event 1
  ↓ hash
event 2
  ↓ hash
event 3
```

WebGPT Bridge 会对常见：

```text
token
password
secret
authorization
api_key
```

字段以及命令参数中的常见凭据进行脱敏。

---

# 推荐的首次配置

本机使用时，可以直接按照下面配置：

```text
Workspace:
选择你的项目目录

Host:
127.0.0.1

Port:
8787

MCP Token:
点击“生成”

Request State Key:
点击“生成”

Allowed Hosts:
留空

Allowed Origins:
留空

Verify Sandbox:
开启

Enable Network Tools:
关闭

Windows Sandbox Helper:
自动

Audit:
开启
```

然后点击：

```text
启动 MCP Server
```

---

# 如何确认启动成功

打开：

```text
http://127.0.0.1:8787/healthz
```

正常情况下应看到：

```text
ok
version
platform
toolCount
sandbox
```

当前 v0.9 Tool Count 应为：

```text
23
```

MCP 地址：

```text
http://127.0.0.1:8787/mcp
```

---

# 23 个 MCP 工具

## 运行与项目检查

```text
run_command
run_project_task
```

## Git / 网络

```text
git
dependency_sync
github
```

## 长进程

```text
process_start
process_poll
process_input
process_kill
process_list
```

## 文件读取

```text
read_file
list_dir
search_text
search_files
```

## 文件修改

```text
apply_patch
delete_file
move_file
```

## Goal Mode

```text
goal_mode
goal_step
goal_finish
goal_status
goal_cancel
```

## 系统能力

```text
get_capabilities
```

---

# Goal Mode

Goal Mode 用于一次提交一个开发目标，然后让 Agent 持续执行。

例如：

```text
使用 Goal Mode 检查并修复当前项目，
直到 test、lint、build 全部通过。
过程中不要让我重复输入“继续”。
```

预期流程：

```text
goal_mode
    ↓
goal_step
    ↓
goal_step
    ↓
goal_finish
    ↓
如果验证失败
    ↓
继续 goal_step
    ↓
goal_finish
    ↓
completed
```

当工具返回：

```text
mustContinue = true
```

或：

```text
status = continue_required
```

Agent 应继续在当前 assistant turn 中执行，而不是要求用户再次发送：

```text
继续
```

真正的用户审批、缺少用户信息或平台限制除外。

---

# ChatGPT Web 安装

> ChatGPT **不能直接连接 localhost MCP Server**。

如果 WebGPT Bridge 运行在：

```text
127.0.0.1
localhost
私有网络
开发机
```

需要通过 **Secure MCP Tunnel** 或受保护的远程 HTTPS MCP Endpoint 连接到 ChatGPT。

OpenAI 官方说明：

https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt-beta

---

## ChatGPT Developer Mode

完整 MCP 写入/修改能力目前主要面向：

```text
ChatGPT Business
ChatGPT Enterprise
ChatGPT Edu
```

在 ChatGPT Web 中：

```text
Workspace Settings / Settings
→ Apps
→ Developer Mode
```

启用开发者模式。

然后：

```text
Apps
→ Create
```

填写你的远程 MCP Endpoint。

例如通过安全隧道后得到：

```text
https://xxxxxxxx.example/mcp
```

而不是：

```text
http://127.0.0.1:8787/mcp
```

---

## 添加 WebGPT Bridge 到 ChatGPT

进入：

```text
Settings / Workspace Settings
→ Apps
→ Create
```

填写：

### Name

```text
WebGPT Bridge
```

### MCP Endpoint

填写 Secure MCP Tunnel 或 HTTPS 服务给你的：

```text
https://你的地址/mcp
```

### Authentication

如果远程入口配置 Bearer Token：

```text
使用应用中生成的 MCP Token
```

然后：

```text
Scan Tools
```

扫描完成后应看到：

```text
23 个工具
```

最后：

```text
Create
```

即可进行测试。

如果更新了 WebGPT Bridge 工具 Schema：

```text
需要重新 Refresh / Scan Tools
```

ChatGPT 不会保证自动加载服务端的新 Tool Schema。

---

# 关于 ChatGPT 权限确认

WebGPT Bridge 自身有一层：

```text
精确请求审批
```

ChatGPT 平台也可能基于 App 权限和操作风险要求确认。

因此有些写操作出现：

```text
确认 / Approve
```

属于正常安全行为。

Goal Mode 不应该为了“自动化”绕过真正的审批。

---

# Codex / 其他 MCP Client

任何支持现代 HTTP MCP 的客户端都可以连接：

```text
http://127.0.0.1:8787/mcp
```

本机客户端通常可以直接连接 localhost。

如果客户端支持 Bearer Token：

```text
Authorization: Bearer <你的 MCP Token>
```

具体 MCP 配置格式以对应客户端为准。

---

# 项目规则自动加载

WebGPT Bridge 会读取项目中的：

```text
AGENTS.md
CLAUDE.md
```

Goal Mode 启动时会把适用的项目规则加入上下文。

嵌套目录中的规则会先被索引，在进入对应项目范围后再使用，避免一次把整个仓库的规则全部塞进模型上下文。

---

# 文件修改安全

已有文件的：

```text
update
delete
move
```

需要当前文件：

```text
SHA-256
```

作为并发保护。

结构化 Patch 还会尽量保留：

```text
UTF-8 BOM
CRLF / LF
文件 mode
```

并采用：

```text
同目录临时文件
→ fsync
→ baseline 二次校验
→ atomic replace
```

降低半写入和并发覆盖风险。

---

# Windows 说明

Windows Native Sandbox 使用：

```text
AppContainer
+ ACL
+ Job Object
+ Parent PID Monitor
```

不会因为 Windows 的：

```text
npm.cmd
```

就把所有命令切换成：

```text
shell: true
```

可信包管理器会经过专用 executable resolver。

未知：

```text
.cmd
.bat
```

默认不会作为任意模型命令执行。

---

# macOS 说明

macOS 使用：

```text
Seatbelt
+ Parent Guard
```

运行前仍必须完成真实 Sandbox Probe。

系统存在：

```text
sandbox-exec
```

并不等于：

```text
Sandbox 已验证安全
```

只有 Probe 通过后才允许无人值守执行安全命令。

---

# 安全建议

推荐：

```text
✓ Workspace 只选择真正需要的项目范围
✓ Host 保持 127.0.0.1
✓ MCP Token 使用随机强 Token
✓ Request State Key 使用另一组独立随机值
✓ Verify Sandbox 保持开启
✓ Audit 保持开启
✓ Network Tools 按需开启
✓ 远程使用 Secure MCP Tunnel / HTTPS
```

不要：

```text
✗ 上传 Token 到 GitHub
✗ 使用 shell:true 运行模型命令
✗ 为了省确认关闭所有审批
✗ 把 Workspace 直接设置成整个系统盘
✗ 不验证 Sandbox 就打开无人值守执行
✗ 把 MCP Server 无认证公开到公网
```

---

# 常见问题

## 1. 8787 端口被占用

换一个端口，例如：

```text
8788
```

同时修改客户端 MCP Endpoint。

---

## 2. ChatGPT 无法连接 localhost

这是正常情况。

ChatGPT Web 连接的是远程 MCP Server。

本机服务请使用：

```text
Secure MCP Tunnel
```

或受保护 HTTPS Endpoint。

---

## 3. ChatGPT 扫不到最新工具

重新：

```text
Apps
→ WebGPT Bridge
→ Refresh / Scan Tools
```

如果旧 App 无法刷新新的 Tool Schema，可以重新创建 App。

---

## 4. Sandbox 验证失败

不要强行关闭验证然后继续无人值守执行。

优先检查：

```text
Windows native helper
macOS Sandbox backend
Bubblewrap
文件权限
Node / Git / npm 可执行路径
```

---

## 5. 命令一直要求审批

说明该操作：

```text
策略本身要求审批
```

或：

```text
Native Sandbox 没有通过 autoRunSafe 验证
```

不要通过全局放宽 policy 解决。

---

## 6. Goal Mode 一直没有结束

可以调用：

```text
goal_status
```

查看：

```text
step budget
tool-call budget
verification feedback
approval blocker
repeat detection
```

必要时：

```text
goal_cancel
```

---

# 开发者安装

需要：

```text
Node.js >= 20
Git
```

克隆：

```bash
git clone https://github.com/chinatownlittlewhite/webgpt-bridge.git
cd webgpt-bridge
npm install
```

开发运行：

```bash
npm run dev
```

构建：

```bash
npm run build
```

正式启动：

```bash
npm start
```

Windows native helper：

```bash
npm run build:native
```

---

# 开发质量门禁

```bash
npm test
npm run lint
npm run contract
npm run build
npm run doctor
```

最终验收：

```bash
npm run acceptance
```

快速开发验证：

```bash
npm run acceptance:quick
```

> `acceptance:quick` 不可以替代真实平台 Native Acceptance。

---

# 最终验收标准

Windows：

```text
npm run acceptance
→ exit 0
```

macOS：

```text
npm run acceptance
→ exit 0
```

通过之后才建议把：

```text
v0.9.0 Final Acceptance Candidate
```

升级为：

```text
v1.0.0 Stable
```

---

# Release 状态

当前：

```text
v0.9.0
Final Acceptance Candidate
```

当前核心功能已经冻结。

后续在 v1.0 前优先处理：

```text
真实 Windows Native Acceptance
真实 macOS Native Acceptance
部署反馈
Bug Fix
安全问题
兼容性问题
```

而不是继续扩大默认 MCP Tool Surface。

---

# License

请参阅仓库中的 `LICENSE` 文件。

---

# 项目地址

https://github.com/chinatownlittlewhite/webgpt-bridge
