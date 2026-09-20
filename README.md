# Cabo CLI

一个服务端权威的在线 Cabo 桌游 MVP。Colyseus 负责房间、状态同步和断线重连，玩家通过终端 REPL 进行游戏。

## 环境与启动

- Node.js 22+
- pnpm 11+

```bash
pnpm install
pnpm build
pnpm dev:server
```

在两个或更多独立终端启动客户端：

```bash
pnpm dev:cli -- --name Alice
pnpm dev:cli -- --name Bob
```

服务端默认为 `http://localhost:2567`。连接其他地址时使用：

```bash
pnpm dev:cli -- --server http://host:2567 --name Alice
```

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

输入 `help` 可随时查看完整命令。私密房间使用 `create private [target]` 创建，客户端会以不回显方式读取六位数字密码。

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
```

项目结构：

- `packages/shared`：共享协议、牌组与纯规则引擎
- `packages/server`：Colyseus 房间、公开房间列表和连接生命周期
- `packages/cli`：命令解析、终端客户端和重连令牌存储

暗牌只存在于服务端规则引擎中；公共 Schema 仅同步牌数和公开桌面状态。私密看牌结果通过点对点消息发送，不会进入其他客户端的状态数据。
