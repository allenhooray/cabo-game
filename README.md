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

访问 `http://localhost:5173`。Web 端默认连接 `https://cabo-api.human404.link`，也可以通过 `VITE_CABO_SERVER_URL` 或进入页的 **Server settings** 覆盖；自定义地址会保存在浏览器 `localStorage`，点击 Reset 可恢复构建默认值。

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

希望让支持 Agent Skills 的 coding agent 自主完成整场对局时，可以同时安装仓库内的 Cabo Skill 和 CLI：

```bash
npx skills add allenhooray/cabo-game --skill cabo -g
npm install --global @cabo-game/cli
```

Skill 的完整流程见 [`skills/cabo/SKILL.md`](skills/cabo/SKILL.md)。可直接把下面的 Prompt 交给 agent：

```text
请安装并使用 Cabo Skill；如果本机没有 cabo-agent，也安装 @cabo-game/cli。启动一个名为 Codex-Cabo 的持久 cabo-agent 子进程，为它创建并保留独立的 session 文件。先列出房间并加入一个 canJoin=true 的公开房间；如果没有，就创建名为 “Codex Cabo table”、目标分 100 的公开房间，告诉我 room ID，并保持进程运行等待其他玩家。始终以最新 observation 为准，只从 legalActions 选择动作；没有合法动作时等待新帧，不要猜测或轮询。自主完成每个回合，在 ROUND_RESULT 合法时确认下一回合，持续玩到 MATCH_RESULT。超时或状态不确定时先 observe，断线时按 Skill 的重连流程恢复，绝不要为了重连而 leave 或关闭进程。比赛结束后告诉我赢家和最终比分，发送 shutdown，并等待进程正常退出。
```

已安装的 Agent CLI 可以自行展示用法和机器可读协议：

```bash
cabo-agent --help    # 或 -h
cabo-agent --version # 或 -v
cabo-agent --print-schema
```

客户端会根据当前游戏阶段显示桌面、自己的已知牌和可用操作。常用操作可以直接输入菜单编号；原有完整命令仍然可用。分步选择过程中输入 `cancel` 可返回操作菜单。

同一房间内的真人玩家可以在 Web 端或交互式 `cabo` CLI 中聊天。终端可输入 `chat MESSAGE`、输入 `chat` 进入引导输入，或在空命令行按 `t`；消息只做在线广播，不保存服务端历史，客户端最多保留最近 50 条，重新加入或刷新后不会补发。

客户端默认连接 `https://cabo-api.human404.link`。连接其他地址时使用：

```bash
pnpm dev:cli -- --server http://host:2567 --name Alice
```

安装后可运行 `cabo --help`（或 `cabo -h`）查看完整命令，运行 `cabo --version`（或 `cabo -v`）查看版本。加入大厅后，终端也会提示可以让 Agent 使用 `cabo-agent` 命令参与游戏。

独立 Web Origin 通过服务端环境变量配置，多个来源用逗号分隔：

```bash
WEB_ORIGINS=https://play.example.com,https://staging.example.com pnpm dev:server
```

未设置时默认允许 `http://localhost:5173` 和 `http://127.0.0.1:5173`。反向代理需要同时转发 HTTP matchmaking 请求和 WebSocket upgrade。

## 快速体验

Alice 创建公开房间：

```text
create public 100 --name "Friday night"
```

Bob 查看房间列表（上下选择、左右翻页）并按回车加入；也可以继续按房间 ID 加入：

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
replace 1 3 at 3
discard
draw discard
resolve left right
peek self 3
peek Bob 4
swap Bob 2
skip
cabo
```

房间名允许重名且只用于辨识；加入仍使用区分大小写的房间 ID。未提供或留空时，服务端使用 `[玩家名]'s room`。输入 `help` 可随时查看完整命令。宣告 Cabo 前会要求确认。私密房间使用 `create private [target] --name "room name"` 创建，客户端会以不回显方式读取六位数字密码。

## 规则摘要

- 2–5 人，每人四张暗牌，开局仅揭示自己第1、2张。
- A–Q 各四张；两张 K 各13分；大小王各0分。
- 从牌堆或弃牌堆抽牌后，可用该牌替换 1–4 张牌；选择 2–4 张时这些牌必须同点数，错误配对会公开所选牌，并可能追加暗罚牌。
- 7/8 看自己，9/10 看他人，11/12 与他人交换相同位置；仅从牌堆抽出后直接弃掉时触发。
- 回合开始可以宣告 Cabo，其余存活玩家各完成最后一个回合。
- 宣告者严格最低得0分，否则手牌分加5；达到房间阈值后最低累计分获胜。
- 回合结束时若手牌恰好是两张 Q 和两张 K，触发 Shooting the Moon：本人计0分，其余玩家各计目标分的一半。
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
