# 房间玩家对话实施方案

## Context

为同一 Cabo 房间内的真人玩家增加轻量文字对话，覆盖 Web 玩家端和交互式 `cabo` CLI，不扩展 `cabo-agent` JSONL 协议。聊天是房间内的瞬时能力：服务端只校验并广播，不写入 Colyseus Schema、不保存历史、不改变游戏 revision；每个交互式客户端仅在内存中保留最近 50 条。现有边界已经支持这一做法：`CaboRoom.messages` 接收独立消息类型并使用 `broadcast` 分发（`packages/server/src/CaboRoom.ts:41-44,89`），`CaboClientCore` 集中注册房间消息处理器（`packages/client-core/src/client-core.ts:177-253`），而 Web 和交互式 CLI 分别通过 handlers 更新自己的界面（`packages/web/src/App.tsx:96-151`、`packages/cli/src/main.ts:154-215`）。

## Approach

### 1. 先打通最小纵向链路

1. 在 `packages/shared/src/room-chat.ts` 定义独立于游戏命令和 Agent 协议的聊天契约，并从 `packages/shared/src/index.ts` 导出：
   - 客户端到服务端的 Colyseus 消息类型固定为 `"chat"`，payload 为 `{ text: string }`。
   - 服务端广播 `RoomChatMessage`：`{ sequence, playerId, playerName, text, sentAt }`；`sequence` 是房间进程内单调递增整数，`sentAt` 是服务端生成的 Unix 毫秒时间。
   - 使用仓库已有的 Zod 校验输入，不把 chat 变体加入 `clientCommandSchema`、`agentRequestSchema`、`agentFrameSchema` 或 `AGENT_*` 常量，因此 Agent 协议版本保持 5，`--print-schema` 输出不变。
2. 在 `CaboRoom.messages` 增加 `chat` handler，完成校验、限流和广播；在 `CaboClientCore` 增加可选 `chat?(message)` handler 与 `sendChat(text)`。先用 server/client-core 测试证明两个客户端能收到同一条权威消息，发送端也只通过广播回显看到自己的消息。
3. 纵向链路通过后，再分别接 CLI 和 Web UI；不要先建立通用聊天框架或持久层。

### 2. 服务端规则与安全边界

- 仅接受当前房间中仍有玩家座位的 client；聊天在 `LOBBY`、对局中、回合/比赛结果阶段都可用。
- 先拒绝原始 `text` 中的 C0/C1 控制字符（包含换行、制表、ESC），再去除首尾普通空白；结果必须非空，并按 Unicode code point 计最多 200 个字符。中文和 emoji 保持原样；不解析 Markdown、HTML、命令或 mention。
- `playerId`、`playerName`、`sentAt`、`sequence` 全部由服务端生成；永不信任客户端提供的身份或时间。
- 每个 session 使用容量 3、每秒补充 1 个 token 的内存令牌桶。前三条可连续发送，此后每条至少等待约 1 秒；校验失败不消耗 token。限流状态保留于短暂掉线/重连期间，并在玩家最终离房时清理。
- 校验失败通过现有 `error` 通道只回复发送者，使用稳定错误码 `INVALID_CHAT_MESSAGE`；限流使用 `CHAT_RATE_LIMITED`。成功时向当前房间所有连接（包含发送者）广播一次 `chat`，不调用 `bumpRevision()`，不混入 `event`，不进入 private knowledge 或 room listing。
- 服务端不保存消息数组，也不在加入或重连时补发。房间销毁后，sequence 和限流状态自然释放。

### 3. 交互式 CLI

- 在 `packages/cli/src/parser.ts`/`interaction.ts` 增加本地交互：
  - `chat <message>` 直接发送；只有 `chat` 时进入 `chat-message` flow。
  - 交互式 TTY 在已进房、flow 为 idle 且 readline 当前输入缓冲为空时，按 `t` 进入同一聊天输入 flow；不能截获用户正在输入的命令。
  - `cancel` 可退出聊天输入；未连接、非交互式 `cabo`、空消息和超长消息给出明确提示。非交互式 CLI 不开放聊天，从而严格符合“仅交互式 CLI”。
- `packages/cli/src/main.ts` 维护独立 `recentChat` 数组，通过 core 的 `chat` handler 收取服务端回显，最多保留 50 条。自动断线重连保留数组；主动离房、永久离开或加入另一个房间前清空。
- `packages/cli/src/ui.ts` 在 `Recent events` 之后、`Your cards`/`Actions` 之前渲染独立 `Room chat` 边框区；终端只显示最近 8 条以控制高度，格式为 `HH:mm  You: …` 或 `HH:mm  Alice: …`。继续对服务端文本使用终端转义防护，聊天绝不进入 `recentEvents`。
- 接收消息时沿用现有全屏刷新和 readline prompt 恢复机制；发送后不乐观插入，等待服务端广播回显。`CHAT_RATE_LIMITED` 和 `INVALID_CHAT_MESSAGE` 显示在现有 notice 区域。
- 更新 `cabo --help` 和根 README 的交互式 CLI 示例；不要修改 `cabo-agent --help`、Agent README 或 Agent JSONL 文档。

### 4. Web 布局与行为

- `App` 持有 `chatMessages`（最多 50 条）、移动端抽屉开关和未读数，并把 `chat` handler 接到该状态。自动重连保留；显式离房或连接永久结束时清空消息、未读和草稿。刷新页面自然丢失历史。
- 把 Lobby/GameTable 与新的 `RoomChat` 组件放入共同的房间布局容器，使大厅和所有游戏阶段都可聊天：
  - 桌面宽度下使用 `minmax(0, 1fr) 320px` 两栏；牌桌保持主区域，右侧聊天栏位于 sticky topbar 下方、独立滚动，输入框固定在栏底。
  - 窄屏下不压缩现有牌桌，而是在 topbar 增加 `Chat` 按钮；点击打开底部抽屉。按钮显示未读数，抽屉打开时清零；关闭状态收到新消息才累加。
  - 抽屉使用 dialog 语义、可由 Escape 和关闭按钮退出，打开时把焦点移到输入框，关闭后把焦点还给触发按钮；消息列表使用合适的 live-region，避免每次全量重读历史。
- 每条消息显示客户端本地 `HH:mm`、玩家名；当前玩家显示 `You`。使用普通文本节点渲染，不使用 HTML 注入。收到新消息时，仅当用户已接近列表底部才自动滚到底部，避免打断正在阅读旧消息的用户。
- 输入为单行、最多 200 个 Unicode code point，Enter 发送；客户端使用与服务端一致的 code-point 计数与提示，不能只依赖按 UTF-16 code unit 计数的 HTML `maxLength`。发送成功的判定仍是收到服务端广播，不做乐观插入。只有连接 live 且当前标签页持有活跃 seat 时可发送；游戏 action 的 busy 状态不阻断聊天，offline/read-only 会禁用输入并给出状态文案。
- 样式沿用 `packages/web/src/styles.css` 的现有颜色、边框、阴影和响应式断点，不引入 UI 或日期依赖。更新桌面/移动端 E2E 截图基线，确认聊天布局没有遮挡手牌、操作区和结果弹窗。

### 5. 生命周期、兼容与发布

- 客户端内存队列统一采用“追加后截取最后 50 条”；不写 `localStorage`、session 文件或 reconnect token。
- 发布前用旧版 client-core 兼容用例验证“未注册 `chat` handler 的客户端忽略广播且连接/游戏事件保持正常”。验证通过后采用 server → shared/client-core consumers → Web/CLI 的部署顺序；回滚时先回滚 Web/CLI，再回滚 server，避免新 UI 向不认识 `chat` 的旧服务端发送后一直等不到回显。
- 不需要数据库迁移、房间状态迁移或功能开关。若发布后聊天异常，可单独回滚 Web/CLI 入口并保留服务端 handler；聊天与游戏 command/event/state 完全分离，游戏路径应继续工作。

## Key decisions

- **不补历史：** 服务端只在线广播，客户端各自保留最近 50 条；新加入或刷新页面的玩家从空记录开始。
- **服务端回显即确认：** 发送端与其他玩家走同一条广播路径，避免本地假成功和重复消息。
- **聊天与游戏/Agent 分离：** 单独的 `chat` Colyseus 消息和 `RoomChatMessage` 类型，不复用 `ClientCommand` 或通用 `event`；`packages/cli/src/agent-main.ts`、Agent schema、observation 和 protocol version 不变。
- **在现有 core 增加最小 hook：** CLI 与 Web 已共享房间连接生命周期，复用 `CaboClientCore` 可避免两端分别直接操作 Colyseus；不创建通用聊天 service/store。
- **轻量服务端限流：** 房间最多 5 人且聊天不持久化，房间内 Map 足以满足当前需求；不引入 Redis、数据库或第三方限流依赖。
- **断线只保留本地已有记录：** 自动重连不清空，但服务端不补掉线期间的消息；这是“在线广播、不补历史”的直接结果。

## Files to modify

### 共享契约与服务端

- `packages/shared/src/room-chat.ts`（新增）：chat schema、常量与消息类型。
- `packages/shared/src/index.ts`：导出 chat 契约。
- `packages/shared/src/room-chat.test.ts`（新增）：Unicode 长度、trim、控制字符和边界测试。
- `packages/server/src/CaboRoom.ts`：chat handler、权威元数据、广播、令牌桶与清理。
- `packages/server/src/CaboRoom.test.ts`：跨客户端广播、各阶段可用、无 revision/state 变化、拒绝与限流测试。

### 共享客户端与交互式 CLI

- `packages/client-core/src/client-core.ts`：可选 chat handler 和 `sendChat`。
- `packages/client-core/src/client-core.test.ts`：发送通道和接收回调测试。
- `packages/cli/src/parser.ts`、`parser.test.ts`：`chat` 命令；非聊天命令保持原解析行为。
- `packages/cli/src/interaction.ts`、`interaction.test.ts`：聊天输入 flow/cancel。
- `packages/cli/src/main.ts`：TTY 限制、`t` 快捷键、50 条内存队列、生命周期和错误提示。
- `packages/cli/src/ui.ts`、`ui.test.ts`：独立聊天区、8 条显示上限、位置和安全文本输出。
- `packages/cli/src/cli-discovery.ts` 及对应测试：只更新人类交互 CLI help。

### Web 与文档

- `packages/web/src/App.tsx`：chat state/handler、共同房间布局、`RoomChat`、移动端未读和可访问性行为。
- `packages/web/src/styles.css`：桌面右栏与移动端底部抽屉。
- `packages/web/src/App.test.tsx`：接收/发送、50 条上限、非乐观回显、离房清理、未读和键盘行为。
- `packages/web/e2e/game.spec.ts` 与桌面/移动端截图：两玩家实时聊天和响应式布局。
- `packages/cli/src/agent-protocol.test.ts`：回归断言 chat 不是 Agent request/action/frame，协议版本仍为 5。
- `packages/cli/src/agent-main.integration.test.ts`：同房真人发送 chat 时，Agent stdout 不产生 chat frame/content。
- `README.md`：补充真人玩家聊天用法和瞬时历史说明；`packages/cli/README.md` 与 `docs/agent-protocol.md` 是 Agent 文档，保持无 chat。

## Failure modes and mitigations

- **恶意控制字符破坏终端：** 服务端拒绝 C0/C1，CLI 渲染仍执行防御性 escape；Web 仅以文本节点渲染。
- **重复或伪造身份：** UI 不乐观插入；发送者信息和 sequence 由服务端生成。当前 WebSocket 连接不做历史重放，因此无需跨重连去重。
- **刷屏影响房间：** 每 session 令牌桶限制聊天；保留现有房间级 `maxMessagesPerSecond = 20` 作为更外层保护。
- **聊天 UI 挤压牌桌：** 桌面固定 320px 侧栏，低于断点改用覆盖式底部抽屉；通过现有桌面/手机截图用例检查回归。
- **聊天错误影响游戏：** 不改 Schema、revision、GameEngine 或 ClientCommand；异常只走发送者 error 通道。
- **新客户端连旧服务端没有回显：** 先用兼容测试证明旧客户端忽略新广播，再按 server-first 顺序发布；发送端不乐观显示，因此不会展示未送达消息。

## Assumptions

- **已验证：** Colyseus room 已通过 `messages` map 接收多种消息，并通过 `broadcast`/`client.send` 分发（`packages/server/src/CaboRoom.ts:41-44,89,258-265`）。
- **已验证：** CLI 与 Web 都由 `CaboClientCore` 提供连接生命周期和消息 handler（`packages/client-core/src/client-core.ts:177-267`）。
- **已验证：** Agent 接口只从 `agentRequestSchema`/`agentFrameSchema` 和独立 `agent-main` 生成 JSONL；只要 chat 不进入这些 union，就不需要升级协议（`packages/shared/src/protocol.ts:226-247`、`docs/agent-protocol.md`）。
- **已确认：** 产品接受无服务端历史、客户端 50 条、掉线不补消息、200 字符、3 条 burst/每秒恢复 1 条以及首版功能裁剪。
- **待实现时验证：** 当前依赖未安装在工作树中，无法直接检查 SDK 对未注册消息 handler 的实现；兼容测试必须证明旧客户端忽略 `chat` 且连接保持正常。若不成立，触发 STOP condition。
- **解释边界：** “不覆盖 Agent”指 Agent CLI 不提供发送入口、也不把 chat 输出为 JSONL frame；底层同一房间的网络连接可能收到服务端广播后被无 handler 地忽略。如果要求 Agent 连接在网络层完全不接收 chat，需要新增客户端能力标识和定向广播，超出本方案。

## Out of scope

- 私聊、@提醒、表情反应、编辑、撤回、屏蔽、举报和富文本：当前没有对应需求，也会引入额外身份/审核状态。
- 服务端历史、持久化、搜索、导出和跨设备同步：与已确认的在线广播模型冲突。
- 系统游戏事件混入聊天：继续保留 `Recent events` 与 `Room chat` 两套信息层级。
- Agent 发送或接收聊天、Agent schema/文档/协议版本变更：明确排除，以避免决策噪音。
- 通用通知框架、聊天 service、Redis 或新 UI 依赖：现有 Colyseus/core/React/CLI 结构已经覆盖首版。

## Verification

1. `pnpm typecheck`：所有 workspace 类型检查通过；chat 类型未扩展 `ClientCommand`/Agent unions。
2. `pnpm test`：现有测试及新增 shared/server/client-core/CLI/Web 测试全部通过，重点覆盖：
   - 0、1、200、201 code point；中文/emoji；首尾空白；换行、ESC 和其他控制字符。
   - 广播包含服务端身份/时间/sequence，发送端与其他在线玩家各收到一次；新加入者不收到旧消息；revision 不变。
   - 3 条 burst 成功，第 4 条限流；时间推进后恢复；不同玩家互不占用额度；最终离房清理 limiter。
   - CLI 非 TTY 拒绝 chat，TTY `chat`/`t`/`cancel` 正常，聊天与 events 分区，保留 50/展示 8。
   - Web 不乐观插入、收到回显后出现、移动端未读正确、离房清空、自动重连保留、offline/read-only 禁止发送。
   - Agent 协议仍拒绝 chat request/action/frame，`AGENT_PROTOCOL_VERSION === 5`；Agent 集成进程同房收到真人 chat 时 stdout 不含消息内容。
   - 未注册 chat handler 的旧客户端收到广播后不报错、不掉线，并继续接收 state/event。
3. `pnpm build`：全部 package 构建成功，无新增运行时依赖。
4. `pnpm test:e2e`：两个 Web 玩家在 lobby 和对局中互发消息；桌面右栏和移动端底部抽屉可用，更新后的截图无牌桌遮挡。
5. 手工 CLI/Web 互通：启动本地 server、一个交互式 `cabo` 与一个 Web 玩家，验证双向消息、`You` 标签、本地时间、限流错误、短暂断线不补消息但保留已有列表。
6. Agent 噪音回归：同房间 Web/CLI 发送 chat 时，`cabo-agent` stdout 只出现现有 ready/result/observation/event/fatal 帧，不出现 chat 内容；`--print-schema` 不含 chat。

## Acceptable finish

- 两名在线真人玩家可在 lobby 和整局期间通过 Web/交互式 CLI 双向聊天；两端布局符合桌面和窄屏约定。
- 消息只在服务端确认广播后出现，客户端最多保留 50 条，加入/刷新/离房行为符合已确认生命周期。
- 输入验证、终端安全和每玩家限流均有自动化边界测试。
- 所有既有游戏、重连和 Agent 测试保持通过；Agent stdout、Schema、协议版本和文档不新增 chat。
- 实现者在 `docs/plans/room-chat-implementation-notes.md` 记录所有偏差，并以实际验证证据写明最终结果。

## STOP conditions

- 如果产品实际要求 Agent 在网络层也完全收不到 chat（而不只是“不输出、不参与”），停止实现并确认是否允许在 join options 中加入 client capability；不要自行扩展 Agent/房间身份协议。
- 如果需要加入/重连补历史、跨刷新恢复或审核留存，停止并另行设计存储、隐私和清理策略。
- 如果 Colyseus 对未知消息的兼容行为导致 server-first 发布仍不安全，停止并提供兼容性复现，不要把 chat 塞进游戏 `command` 作为绕过。
- 如果实现需要修改 GameEngine、CaboState Schema 或 Agent protocol union，说明当前边界判断失效，停止并回报原因。

## Simplicity check

保留的最小闭环只有：一个独立 wire message、一个共享契约、服务端校验/限流/广播、core 的两个 hook、两端本地 50 条队列和对应 UI。已明确裁掉持久化、历史补发、私聊、mention、富交互、通用框架和 Agent 支持；不能再删除服务端校验、限流、终端控制字符防护、错误回显或响应式布局，否则会损害当前正确性或已确认需求。

## Review notes

复核日期：2026-09-21

| 维度 | 初稿 | 终稿 | 处理结果 |
| --- | ---: | ---: | --- |
| 完整性 | 5/5 | 5/5 | 发送、接收、错误、生命周期、回滚和完成标准均已覆盖。 |
| 可行性 | 4/5 | 5/5 | 增加旧 client-core 忽略未知 chat 广播的兼容测试与失败停止条件。 |
| 范围 | 5/5 | 5/5 | 保留单一在线广播闭环，明确排除历史、持久化、富交互和 Agent 支持。 |
| 可测试性 | 5/5 | 5/5 | 每层都有具体边界用例、命令、E2E 和 Agent stdout 回归。 |
| 风险 | 4/5 | 5/5 | 修正发布兼容性假设，并将 server-first 发布建立在兼容测试通过之上。 |
| 假设 | 4/5 | 5/5 | 已验证与待验证假设分列；网络层完全排除 Agent 被标为产品边界/STOP condition。 |

Must address before implementation：无。

Should address soon：无。

Noted for awareness：Agent 的底层 Colyseus 连接可能收到并忽略 chat 数据包，但不会暴露发送入口、JSONL frame 或 stdout 内容；若产品要求网络层完全不投递，必须触发本方案的 STOP condition。
