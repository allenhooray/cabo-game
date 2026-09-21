# Cabo

一个服务端权威的在线 Cabo 桌游。Colyseus 负责房间、状态同步和断线重连，玩家可以使用 Web 牌桌或终端 REPL 进行游戏。

## 环境与启动

- Node.js 22+
- pnpm 11+

```bash
pnpm install
pnpm build
pnpm dev:server
```

在另一个终端启动 Web 玩家端，并显式连接本地服务：

```bash
VITE_CABO_SERVER_URL=http://localhost:2567 pnpm dev:web
```

访问 `http://localhost:5173`。Web 端默认连接 `https://cabo.human404.link`，也可以通过 `VITE_CABO_SERVER_URL` 或进入页的 **Server settings** 覆盖；自定义地址会保存在浏览器 `localStorage`，点击 Reset 可恢复构建默认值。

生产构建：

```bash
VITE_CABO_SERVER_URL=https://game.example.com pnpm build:web
```

静态文件输出到 `packages/web/dist`，应独立部署。HTTPS 页面必须连接 HTTPS/WSS 游戏服务。

### Vercel 部署

仓库根目录的 `vercel.json` 已配置 Vercel Web 构建。将仓库导入 Vercel，保持 **Root Directory** 为仓库根目录，其余构建选项无需手动覆盖。每次推送后 Vercel 会自动运行：

```bash
pnpm run build:vercel
```

该命令依次构建 Web 所需的 workspace 包，并将默认游戏服务地址设为 `https://cabo-api.human404.link`；静态产物从 `packages/web/dist` 发布。

在两个或更多独立终端启动客户端：

```bash
pnpm dev:cli -- --server http://localhost:2567 --name Alice
pnpm dev:cli -- --server http://localhost:2567 --name Bob
```

需要从外部程序驱动对局时，使用独立的 JSONL Agent 入口：

```bash
pnpm dev:agent -- --server http://localhost:2567 --name Bot-A
```

它只在 stdout 输出 JSON，每行一个协议帧；stdin 同样每行接受一个 JSON 请求。完整契约见 [Agent JSONL 协议](docs/agent-protocol.md)。

已安装的 Agent CLI 可以自行展示用法和机器可读协议：

```bash
cabo-agent --help
cabo-agent --version
cabo-agent --print-schema
```

客户端会根据当前游戏阶段显示桌面、自己的已知牌和可用操作。常用操作可以直接输入菜单编号；原有完整命令仍然可用。分步选择过程中输入 `cancel` 可返回操作菜单。

客户端默认连接 `https://cabo.human404.link`。连接其他地址时使用：

```bash
pnpm dev:cli -- --server http://host:2567 --name Alice
```

独立 Web Origin 通过服务端环境变量配置，多个来源用逗号分隔：

```bash
WEB_ORIGINS=https://play.example.com,https://staging.example.com pnpm dev:server
```

未设置时默认允许 `http://localhost:5173` 和 `http://127.0.0.1:5173`。反向代理需要同时转发 HTTP matchmaking 请求和 WebSocket upgrade。

## 快速体验

Alice 创建公开房间：

```text
create public 100
```

Bob 查看房间并加入：

```text
rooms
join ROOM_CODE
```

Alice 开始游戏：

```text
start
```

常用游戏命令：

```text
show
draw deck
replace 1
discard
draw discard 2
peek self 3
peek Bob 4
swap Bob 2
skip
cabo
```

输入 `help` 可随时查看完整命令。宣告 Cabo 前会要求确认。私密房间使用 `create private [target]` 创建，客户端会以不回显方式读取六位数字密码。

## 规则摘要

- 2–4 人，每人四张暗牌，开局仅揭示自己第1、2张。
- A–Q 各四张；两张 K 各13分；大小王各0分。
- 7/8 看自己，9/10 看他人，11/12 与他人交换相同位置；仅从牌堆抽出后直接弃掉时触发。
- 回合开始可以宣告 Cabo，其余存活玩家各完成最后一个回合。
- 宣告者严格最低得0分，否则手牌分加5；达到房间阈值后最低累计分获胜。
- 掉线座位保留60秒；超时记为 DNF，剩余玩家继续。

## 开发验证

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
```

E2E 测试会启动独立的服务端与 Web 预览，并以桌面和手机 Chromium 项目验证多人流程、私密房密码、刷新恢复和基础无障碍规则。

项目结构：

- `packages/shared`：共享协议、牌组与纯规则引擎
- `packages/client-core`：CLI 与 Web 共用的连接、断线恢复、合法动作和私密牌面知识
- `packages/server`：Colyseus 房间、公开房间列表和连接生命周期
- `packages/cli`：命令解析、终端客户端和重连令牌存储
- `packages/web`：React/Vite 玩家牌桌

暗牌只存在于服务端规则引擎中；公共 Schema 仅同步牌数和公开桌面状态。私密看牌结果通过点对点消息发送，不会进入其他客户端的状态数据。
