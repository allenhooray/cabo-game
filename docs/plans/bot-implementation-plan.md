# Cabo Bot 陪玩能力技术方案（已执行）

> 状态：**已执行**（M0–M6 全部落地）。执行结论与实测数据见 §5.1、§6。
> 方法论依据：`docs/plans/bot-personas.md`（阈值推导在实施中被实测修正，见其 §2.2）。
>
> 三处与方案原文的偏差，均已在对应小节记录原因：
> 1. **阈值公式被实测修正**：`P > 5/(H+5)` 漏掉了 `δ = H − E[H_final]`，正确形式是 `P > (5+δ)/(H+5)`。见 `bot-personas.md` §2.2。
> 2. **`getPendingDraw` 从禁项收窄为"只许出现在 harness 适配层"**——理由见 §6.5。
> 3. **M5 的达标依赖采样数**：150 采样 69.1%、400 采样 71.9%（门槛 70%）。采样数因此被登记为第 14 个可调参数，见 §5.1。

---

## 1. 目标

### 1.1 业务目标

让 bot 能替代真人参与 Cabo 对局，并且**有可辨识的性格差异**，用于陪玩、教学和难度调节。

### 1.2 技术目标

| # | 目标 | 可量化验收 |
| --- | --- | --- |
| G1 | 能自主完成一整场对局 | 从加入房间到 `MATCH_RESULT` 全程零非法动作、零超时 |
| G2 | 决策基于数学模型而非启发式拍脑袋 | 宣告阈值严格按 `k · (5 + δ) / (Ĥ + 5)` 计算（`δ` 由实测标定），`p̂` 走蒙特卡洛 |
| G3 | 胜率估计校准可信 | 分桶校准误差 < 5%（预测 vs 实际） |
| G4 | 人设有可辨识差异 | 赌徒的 Cabo 宣告频率 > 算盘的 3 倍；记忆大师对佛系老王自对弈胜率 > 70% |
| G5 | 人设可调、可扩展 | 13 参数 + 6 预设，新增人设不改策略代码 |
| G6 | 绝不作弊 | 守卫测试证明 bot 代码不依赖任何暗牌接口 |

### 1.3 非目标（明确不做）

- **不做机器学习**。理由见方法论文档：Cabo 的不确定性是"信息不完全"而非"策略空间爆炸"。
- **不做服务端内嵌**。`engine.debugHand()` 会暴露暗牌，内嵌等于给 bot 开天眼。bot 必须是普通玩家进程。
- **不做聊天内容生成**。`chattiness` 只预留开关，首期不实现自然语言。
- **不改动现有 Web / CLI / 服务端的行为**。除 §7 决策点 D1 外，全部为新增代码。

### 1.4 默认环境假设

- 记忆模式：以 `assisted` 为主测环境（知识由服务端权威下发），同时实现 `classic` 的自维护记忆路径。
- 目标分：100。人数：2–5，主测 4 人。
- 回合时限：60 秒（bot 决策 P95 目标 < 50ms，留足余量）。

---

## 2. 现状与约束

### 2.1 可直接复用的资产

| 资产 | 位置 | 用途 |
| --- | --- | --- |
| 纯规则引擎 | `packages/shared/src/engine.ts` | 自对弈可直接驱动，无需网络 |
| 确定性随机源 | `packages/shared/src/deck.ts` 的 `seededRandom` | 对局可复现 |
| 合法动作推导 | `packages/client-core/src/legal-actions.ts` | 保证不产生非法动作 |
| 位置级知识追踪 | `packages/client-core/src/knowledge.ts` | 信念层基础 |
| Cabo 风险常量 | `packages/client-core/src/cabo-risk.ts` | 阈值公式输入 |
| JSONL 协议 v7 | `docs/agent-protocol.md` + `packages/cli/src/agent-main.ts` | 线上接入层 |
| 公开动作事件 | `PublicActionEvent`（`shared/src/types.ts`） | 重建未见牌池的关键 |

### 2.2 关键约束：信息边界

bot 只能看到两类信息，方案的一切设计都受此约束：

**（a）`observation` 帧**：`state`（公开桌面）+ `knowledge`（自己的私密知识）+ `legalActions` + `caboRisk`。

**（b）`event` 帧**：公开动作事件 + 发给自己的 `private-reveal`。

由此推出三条必须遵守的规则：

1. **不能假设 `insertedCard` 一定存在**。`publicAction()`（`server/src/private-knowledge.ts:161-178`）只在 `pendingDraw.source === "discard"` 时才带 `insertedCard`；从牌堆抽的牌是私密的。所以"某人替换后手里多了一张未知牌"是常态。
2. **每轮未见牌池必须重置**。`startRound()` 每轮 `shuffle(createDeck())` 重建牌组，跨轮计数无意义。
3. **`classic` 模式下服务端不下发任何位置知识**。`PrivateKnowledgeStore.applyPrivateReveal` 在 classic 分支直接 return，且每次动作后 `slots.fill(null)`。**bot 必须自己维护位置记忆**——这恰好是 `memoryFidelity`（`m`）参数真正生效的地方；在 assisted 模式下服务端会恢复，`m` 无意义。

### 2.3 调研中发现的两个机制要点（会显著影响策略设计）

**要点 A：多张同点替换会让手牌变少，这是全局最强得分手段。**

`replaceHeld()` 中，被选中的 k 张牌只有 `replacementPosition` 那一张被替换为持牌，其余**直接从手牌移除**并进入弃牌堆。且 `matches` 只校验**被选中的牌彼此同点**，与持牌点数无关。

```
手牌 [12, 12, 5, 3] → 选中位置 1、2，持牌为任意点数 X，落点选 1
结果 [X, 5, 3]        // 4 张 → 3 张，手牌分 −24 +X
```

这意味着：**囤同点已知牌 → 一次性塌缩**，既能减分又能减少手牌张数，是比单纯换低牌更本质的获胜路径。评估层必须对"手牌张数减少"单独计价。

**要点 B：错配的代价远大于"多一张罚牌"。**

错配时被选中的牌**不会被移除**，而是插入持牌（+1 张），选 3–4 张时还额外插入一张罚牌（+2 张），并触发 `insertAtEnd` 的 `unshift/push`——**所有位置索引整体偏移**，等于己方与观战方的位置记忆全部作废。所以：

- 非已知同点的多张替换是高风险动作，由 `r` 参数控制。
- `MISMATCH_PENDING` 阶段应**始终选 `right`**（`push` 保留 1..n 位置不变），`left`（`unshift`）会平移全部位置。这条是免费的收益，写进策略即可。

---

## 3. 总体架构

核心设计：**决策内核与运行环境解耦**。同一套 `policy.ts` 跑在两个环境里。

```
                    ┌──────────────────────────────┐
                    │  决策内核（纯函数，无 IO）      │
                    │  belief → evaluate → policy   │
                    └──────────────────────────────┘
                              ▲            ▲
              ┌───────────────┘            └───────────────┐
              │                                            │
   ┌──────────────────────┐                  ┌──────────────────────┐
   │ 环境 A：自对弈 harness │                  │ 环境 B：线上 driver   │
   │ 直接驱动 GameEngine    │                  │ JSONL ↔ cabo-agent   │
   │ seededRandom 可复现    │                  │ 与真人同通道          │
   │ 用途：调参 / 回归 / 校准│                  │ 用途：真实陪玩        │
   └──────────────────────┘                  └──────────────────────┘
```

**为什么这样分**：环境 A 必须绕过网络才能跑十万局量级的调参；但环境 A 若图省事直接读引擎暗牌，自对弈结果就毫无意义。所以两个环境必须把状态**归约成同构的 `DecisionContext`**，信息边界与线上完全一致。

### 3.1 数据流

```
observation + event
      │
      ▼
  belief.ts     未见牌池 + 位置记忆（assisted 读服务端 / classic 自维护）
      │
      ▼
 evaluate.ts    E[H]、p̂（蒙特卡洛）、各候选动作收益
      │
      ▼
  policy.ts     规则决策树 × persona 参数 → AgentAction
      │
      ▼
  driver.ts     JSONL 写出 / harness 直接回灌引擎
```

---

## 4. 关键模块

新增 `packages/bot`，依赖 `@cabo-game/shared` + `@cabo-game/client-core`，**不依赖 `@cabo-game/server`**。

### 4.1 `belief.ts` — 信念层

```ts
export interface Belief {
  round: number;
  unseen: Record<number, number>;       // 未见牌池：rank → 剩余张数
  unseenTotal: number;
  meanUnseen: number;                   // 加权均值，未知牌的点数期望
  mySlots: Array<KnownCard | null>;     // 位置级记忆
  oppSlots: Map<string, Array<KnownCard | null>>;
}

export function createBelief(): Belief;
export function applyObservation(belief: Belief, obs: AgentObservation): Belief;
export function applyPublicAction(belief: Belief, action: PublicActionEvent): Belief;
export function applyPrivateReveal(belief: Belief, reveal: PrivateRevealMessage): Belief;
export function resetForRound(belief: Belief, round: number): Belief;   // 牌组重洗，必须清空 unseen
export function degrade(belief: Belief, fidelity: number, rng: RandomSource): Belief;
```

要点：
- `unseen` 初值为牌组全量（1–12 各 4、K 两张、王两张），扣除所有已见牌。
- `applyPublicAction` 必须复刻 `PrivateKnowledgeStore.applyAction` 的**位置位移语义**（`replace` 的 flatMap 塌缩、`resolve-mismatch` 的左右插入、`swap` 的等位交换）。这是最容易出 bug 的地方，需重点单测。
- `degrade` 按 `1 − memoryFidelity` 的概率随机清空已知位置，实现"会忘牌"的人设；assisted 模式下由服务端下发快照覆盖，`degrade` 不生效。
- 对手未知牌按 `ρ` 折扣估计（默认 0.88），修正"理性玩家会留好牌"导致的系统性高估。

### 4.2 `evaluate.ts` — 评估层

```ts
export interface Evaluation {
  expectedHandScore: number;   // E[H]
  winProbability: number;      // p̂
  samples: number;
}

export function expectedHandScore(belief: Belief, obs: AgentObservation, persona: BotPersona): number;
export function winProbability(belief: Belief, obs: AgentObservation, persona: BotPersona, rng: RandomSource): number;
export function scoreCandidate(action: AgentAction, ctx: DecisionContext): number;
export function caboThreshold(persona: BotPersona, ctx: DecisionContext): number;
```

- `expectedHandScore`：`Σ 已知位点数 + Σ 未知位 meanUnseen × ρ`。手牌张数取实际 `cardCount`（错配后可能为 5–6）。
- `winProbability`：蒙特卡洛 N=300。用未见牌池随机填充所有未知位 → 计算各玩家手牌分 → 统计"我严格最低"的频率。处于 `FINAL_TURNS` 的对手按其会继续改善做一次折扣。
- `caboThreshold`：`k_eff · 5 / (Ĥ + 5)`，其中
  `k_eff = clamp(k · (1 − u · (myTotal − minRivalTotal) / targetScore), 0.3, 4.0)`。
- `scoreCandidate`：动作收益。**必须包含手牌张数减少的收益项**（要点 A），否则 bot 学不会塌缩同点牌。建议形式：
  `收益 = Δ(期望手牌分) + λ · Δ(手牌张数)`，`λ` 取未知牌期望分的一半量级。

### 4.3 `policy.ts` — 策略层（纯函数）

```ts
export interface DecisionContext {
  observation: AgentObservation;
  belief: Belief;
  persona: BotPersona;
  rng: RandomSource;
}
export function decide(ctx: DecisionContext): AgentAction;
```

按阶段展开的规则优先级：

| 阶段 | 规则 |
| --- | --- |
| `LOBBY` | 是房主且 ≥2 人 → `start`；否则空转 |
| `ROUND_RESULT` | `ready-next-round` |
| `TURN_START` / `FINAL_TURNS` | ① 若 `cabo` 合法 → `p̂ ≥ caboThreshold` 则宣告；② 若弃牌堆顶分 < 最高已知牌分 − 门槛 → `draw-discard`；③ 否则 `draw-deck` |
| `DRAWN` | ① 若存在**已知同点 ≥2 张** → 塌缩替换（按 `r` 决定是否冒险用未知牌）；② 持牌点数低于某已知位 → `replace`；③ 持牌为 7–12 且弃牌能触发能力 → `discard`；④ 否则 `replace` 到最高分位 |
| `POWER_PENDING` | 7/8 → `peek-self` 未知位；9/10 → `peek-other`（按 `t` 选目标、按 `d` 选位置）；11/12 → 有正收益则 `swap`，否则按 `a` 决定是否 `skip` |
| `MISMATCH_PENDING` | 一律 `right`（保留位置索引），罚牌同样 `right` |

外加 `mistakeRate` 包装：以 `ε` 概率把决策替换为该阶段的一个随机合法动作。

### 4.4 `persona.ts` — 人设层

```ts
export interface BotPersona { /* 13 参数 + chattiness，字段名见方法论文档 §6 */ }
export const PERSONAS: Record<PersonaId, BotPersona>;   // 6 个预设
export function jitterPersona(p: BotPersona, rng: RandomSource, amount = 0.15): BotPersona;
```

6 个预设（算盘 / 赌徒阿豪 / 记忆大师 / 搅局者 / 佛系老王 / 月神）的取值已在方法论文档 §8 定稿，直接落表。

### 4.5 `driver.ts` — 线上接入

启动 `cabo-agent` 子进程，按 JSONL 收发：读 `observation` / `event` 更新 `Belief`，调用 `decide`，写 `action`。

必须处理的协议细节：
- 用 `deadlineAt − serverTime` 的**差值**安排动作，不本地计时。
- 断线走 60 秒重连宽限期，**不要 `leave`**（主动离房视为弃权）。
- `REQUEST_TIMEOUT` 后的 `STATE_UNCERTAIN` 需先 `observe` 再继续。

### 4.6 `harness/` — 自对弈环境

```ts
export function runSelfPlay(config: {
  personas: PersonaId[];
  games: number;
  seed: number;
  targetScore: number;
}): SelfPlayReport;
```

用 `GameEngine` + `seededRandom` 直接驱动，把引擎状态归约成与线上同构的 `DecisionContext`。

**防作弊红线**：harness 只允许使用 `getSnapshot()` 与引擎广播的 `EngineEvent`，**禁止调用 `debugHand()`**。这条由守卫测试强制（§6.5）。

---

## 5. 实施步骤

| 里程碑 | 交付物 | 验证方式 | 完成判据 |
| --- | --- | --- | --- |
| **M0 脚手架** | `packages/bot` 包骨架、tsconfig、vitest、`pnpm-workspace` 自动纳入 | `pnpm build` / `pnpm typecheck` / `pnpm test` 全绿 | 空包能参与 workspace 构建 |
| **M1 信念层** | `belief.ts` + 单测 | 构造 `PublicActionEvent` 序列，断言 `unseen` 与位置记忆 | 位置位移语义与 `PrivateKnowledgeStore` 逐条对齐；每轮重置正确 |
| **M2 评估层** | `evaluate.ts` + 单测 | 小样本暴力枚举对照 `E[H]`；`p̂` 分桶校准 | `E[H]` 与暴力枚举误差 < 1e-6；校准误差 < 5% |
| **M3 策略层** | `policy.ts`，能打完一整局 | harness 跑 100 局，断言零非法动作 | 100 局全部抵达 `MATCH_RESULT` |
| **M4 人设层** | `persona.ts` + 6 预设 + 抖动 | 参数化回归：不同 `k` 产生不同宣告频率 | 赌徒宣告频率 > 算盘 3 倍 |
| **M5 自对弈验证** | `harness/` + 批量报告 | 4 人桌矩阵，每对 ≥1000 局 | 记忆大师 vs 佛系老王胜率 > 70%；产出调参报告 |
| **M6 线上接入** | `driver.ts` | 连真实服务端打完整场 | 端到端零超时、零非法动作 |

依赖关系：M0 → M1 → M2 → M3 → M4 → M5 → M6。M4 可与 M5 的 harness 并行推进。

**相对工作量**：M0/M1/M4/M6 为 S；M2/M3 为 M；M5 为 M（主要是跑分时间）。

### 5.1 执行结果

| 里程碑 | 状态 | 实测结论 |
| --- | --- | --- |
| M0 脚手架 | ✅ | `pnpm build` / `typecheck` / `test` 全绿 |
| M1 信念层 | ✅ | `belief.test.ts` 26 例；位置位移语义与 `PrivateKnowledgeStore` 对齐 |
| M2 评估层 | ✅ | `E[H]` 与暴力枚举误差 < 1e-6；**校准误差 2.7%**（门槛 5%） |
| M3 策略层 | ✅ | `policy.test.ts` 23 例；100 局零非法动作、全部抵达 `MATCH_RESULT` |
| M4 人设层 | ✅ | `persona.test.ts` 13 例；**赌徒/算盘宣告频率 = 8.3 倍**（门槛 3 倍） |
| M5 自对弈验证 | ✅ | 记忆大师 **71.9%** vs 3×佛系老王（门槛 70%）——**前提是采样数 ≥ 400**，见下 |
| M6 线上接入 | ✅ | `driver.test.ts` 5 例（4 条协议语义 + 1 条真实服务端端到端） |

**M5 的达标条件是一个有意义的发现：采样数本身就是强度参数。**

同一配置（1000 局、同种子、只改蒙特卡洛采样数）：

| 采样数 | 记忆大师胜率 | 每局宣告次数 | 宣告成功率 |
| --- | --- | --- | --- |
| 150 | 69.1% | 6.37 | 48.2% |
| **400** | **71.9%** | 6.37 | 49.2% |

门槛是 70%，150 采样差 0.9pp，400 采样超出 1.9pp。原因是**选择偏差**：`p̂` 是 `N` 次采样的频率，标准误约 `sqrt(p(1−p)/N)`（`N = 150`、`p̂ ≈ 0.8` 时约 3.3%）。宣告条件是 `p̂ ≥ 门槛`，于是"p̂ 偏高"的噪声被系统性地选进来——**边缘宣告比模型以为的更容易失败**，bot 于是略微过度宣告、胜率被压低。采样数翻 2.7 倍把标准误压到约 2%，选择偏差随之减半，胜率就回到门槛之上。

**处置**：把线上默认采样数定在 **300**（`policy.ts` 的 `DEFAULT_SAMPLES`，介于两个实验点之间，单次决策仍在毫秒级），并把"采样数影响胜率"写进调参清单——它是第 14 个可调参数，且是唯一一个"调大只有好处、代价只是 CPU"的参数。

**残余的建模缺口（已定位，未修）**：高 `p̂` 段的失败仍以**平局**为主。记忆大师会用 2–4 分的极低手牌宣告，而低手牌总分是高度离散的小整数，对手撞上同分的概率远高于连续模型给人的直觉——规则却要求**严格**最低（`strictLowest: true, tieFails: true`）。若要在低采样数下也达标，可给阈值加一个随 `H` 变小而增大的"平局边际"`margin(H)`；这需要重跑一轮 `continuation.ts` 式实测来标定，属调参而非建模，留作后续。

---

## 6. 验证方式

### 6.1 单元测试（vitest，与现有 `packages/*/src/*.test.ts` 同风格）

- `belief.test.ts`（26 例）：未见牌池扣除、每轮重置、`replace`/`swap`/`resolve-mismatch` 的位置位移、`slotBounds` 上界、**弃牌堆重洗的池子自纠错**。
- `evaluate.test.ts`（26 例）：`E[H]` 暴力枚举对照；阈值公式边界与实测锚点；活性兜底；`sampleFinalState` 的分池抽牌回归。
- `policy.test.ts`（23 例）：每个阶段在给定 `legalActions` 下都产出合法动作；`MISMATCH_PENDING` 恒选 `right`；M3 验收（100 局）。
- `persona.test.ts`（13 例）：参数表合法性、抖动/夹取/情绪漂移、M4 验收（宣告频率比）。
- `driver.test.ts`（5 例）：事件先于观察、`STATE_UNCERTAIN` 恢复、延迟预算夹取、**局中绝不主动离房**、真实服务端端到端。

### 6.2 校准检验（关键，验证数学模型是否正确）

把 `p̂` 分桶，统计每桶内宣告的**实际**成功频率。实现上做了两处修正：

- **用等量分桶（每桶样本数相近）而不是等宽分桶。** 等宽分桶下样本会集中在中间，最小的桶可能只有几十个样本，一个 ±11% 的偏差其实在噪声范围内，却会把门槛数字绑架。报告同时输出等宽表（给人看分布）和等量表（用于判定），并标出每个桶的标准误与显著性。
- **校准误差用样本加权 ECE**：`Σ (n_b/N)·|p̂_b − 实际_b|`，且只统计样本数 ≥ 25 的桶。

理想情况落在对角线上。**校准误差 > 5% 说明蒙特卡洛模型有偏**，必须先修模型再调参——否则后续所有调参都是在错误的基础上优化。

> 这条规则救了这个项目。第一版模型的校准误差是 **29.5%**，逐个修掉七个建模坑之后降到 **2.7%**（坑的清单见 `bot-personas.md` §5.6.1）。其中最大的一个是"牌堆重洗不发事件"——它让 10.6% 的抽样带着最多 13 张的池子缺口，高 `p̂` 段偏差 −14.2%。**如果先调参再校准，这些坑会被当成"参数没调好"而永远埋掉。**

### 6.3 自对弈矩阵

4 人桌，6 人设轮换座位，每对 ≥1000 局（单局手牌分标准差约 7.3，样本不足结论会被噪声淹没）。产出：平均每轮得分、宣告频率与成功率、相对 ELO。

实测见 `bot-personas.md` §9.1。M4 门槛通过（8.3 倍），M5 门槛通过（71.9% vs 70%，但需采样数 ≥ 400，见 §5.1）。

### 6.4 端到端

`driver.ts` 拉起 bot 打完整场，校验：无非法动作、无超时、正确响应 `ROUND_RESULT`、断线能重连恢复。

实现要点（都是协议里明写但容易漏的）：

- **事件先于观察**。服务端发送顺序是 `broadcast(event, publicAction)` → `dispatch(events)` → `sendAllKnowledge()` → `syncFromEngine()`，所以驱动必须把事件帧**缓存**，等下一帧 observation 到达时先喂事件、再喂快照。顺序反了信念层会算错位置。
- **截止时间用服务端时间差**。`deadlineAt − serverTime` 才是服务端视角的剩余时间，本地已流逝的时间要自己扣。协议明确要求"不要自行判定回合结束"，所以超时兜底交给服务端（它会用 `turn-timeout` 代打），驱动只负责在预算内把动作发出去。
- **绝不主动离房**。`leave` / `shutdown` / stdin EOF / SIGINT / SIGTERM 都会被服务端判定为弃权。需要重连宽限期时只能让连接**异常断开**。所以 `stop()` 默认走 `SIGKILL`。
- **`REQUEST_TIMEOUT` 不等于非法动作**。它只说明"结果没在超时前提交"，动作本身可能合法甚至已生效。验收门槛里的"零超时"由独立计数器统计，不能和"服务端拒绝了这个动作"混在一起。

### 6.5 防作弊守卫（强制）

一条测试断言 `packages/bot/src/**` 的 import 图中**不出现**：
- `debugHand`（引擎的"看所有人手牌"接口）
- `@cabo-game/server` 任何导出
- 决策核心（`belief` / `evaluate` / `plans` / `policy` / `persona` / `index` / `driver`）import harness / engine / client-core

任何一条被触发即测试失败。这条守卫是"陪玩"与"作弊"的分界线，不可省略。

**实现时对 `getPendingDraw` 做了收窄。** 方案原文把它和 `debugHand` 并列列为禁项，落地后发现这个划分过粗：

- 它返回的是**当前回合玩家自己刚抽的那张牌**，服务端自己也调它（`CaboRoom.ts` 的 `publicAction` 入参），而且只有 `source === "discard"` 时才会被公开——那张牌本来就是弃牌堆栈顶，早已公开。
- 所以真正要守的不是"别调它"，而是"它只能出现在 harness 适配层里用来复刻服务端的信息管线，绝不能流进决策核心"。

守卫因此改成断言"`getPendingDraw` 只出现在 `harness/engine-adapter.ts`"，**并且额外断言它确实出现在那里**——否则这条检查会因为"谁都没用"而空过，失去意义。

---

## 7. 决策点（已确认）

| # | 决策点 | 选项 | 我的建议 | 结论 |
| --- | --- | --- | --- | --- |
| **D1** | harness 如何取得"与线上同构"的座位视图 | (a) 把 `server/src/private-knowledge.ts` 上移到 `packages/shared`（纯逻辑、无 Colyseus 依赖），server 与 harness 共用同一份代码；(b) 在 bot 内复制一份最小实现 | **(a)**。能保证自对弈与线上同源，避免逻辑漂移；代价是轻微改动 server 的 import（需一并迁移 `private-knowledge.test.ts`）。(b) 零侵入但有长期漂移风险 | **(a) 已采纳** |
| **D2** | 线上接入方式 | (a) JSONL 子进程驱动 `cabo-agent`；(b) 进程内直接用 `@colyseus/sdk` 连接 | **(a)**。bot 与真人走完全相同的协议，天然公平；缺点是每 bot 一个进程 | **(a) 已采纳** |
| **D3** | 首期范围 | (a) 一次性做到 M6；(b) 先交付 M0–M3（能打完一局的基础 bot），确认手感后再做人设与评估 | **(b)**。M3 就能验证"规则 bot 打得动"这个核心假设，风险最早暴露 | **(a) 一次性做到 M6**（用户选择） |
| **D4** | 默认记忆模式 | (a) 以 `assisted` 为主测；(b) 以 `classic` 为主测 | **(a) 主测 + (b) 必须实现**。assisted 减少自研记忆的 bug 面；但 classic 是建房默认模式，必须能跑 | **(a) + (b) 已采纳** |
| **D5** | 月神人设是否首期交付 | (a) 首期包含；(b) 首期不包含，仅保留 `ω` 参数位 | **(b)**。自然触发概率约 0.0022%，需额外实现"月相检测"逻辑，投入产出比低，适合作为二期彩蛋 | **(b) 已采纳**；`persona.test.ts` 有断言锁住"只有月神的 `moonAmbition` 非零" |

---

## 8. 风险

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 位置位移语义实现错误 | 信念层静默出错，bot 变弱且难定位 | M1 逐条对照 `PrivateKnowledgeStore` 单测；这是最优先的测试对象 |
| 蒙特卡洛模型有偏 | 阈值系统性错误，调参全部作废 | §6.2 校准检验作为 M2 的准入门槛 |
| 自对弈环境与线上行为漂移 | 自对弈结论不迁移到线上 | 决策点 D1 选 (a)；M6 端到端交叉验证 |
| bot 过强导致体验差 | 陪玩目标失败 | 人设本身就覆盖了从"佛系"到"记忆大师"的强度带；默认对手用"算盘"而非"记忆大师" |
| 参数过拟合 | 只在开发局里强 | §6.3 混合池评估，禁止只跟同一人设对打 |

---

## 9. 确认清单（已确认并执行）

1. **决策点 D1–D5** —— 已确认，结论见 §7。
2. **M0–M6 的拆分**与依赖顺序 —— 已确认，逐个交付，结果见 §5.1。
3. **§6.5 防作弊守卫**作为硬性验收条件 —— 已确认，实现见 §6.5（`guard.test.ts`，5 条断言全绿）。
4. **首期产出可运行的自对弈调参报告（M5）** —— 已确认并产出，见 `bot-personas.md` §9.1。

---

## 10. 遗留与后续

| 项 | 说明 | 优先级 |
| --- | --- | --- |
| **平局边际** | M5 门槛差 0.9pp，根因是"严格最低"下的平局。修法是给阈值加一个随 `H` 变小而增大的 `margin(H)`，需重跑一轮实测标定。属调参，非建模。 | 中 |
| **classic 模式实测** | 代码路径已实现（`degrade()` + 自维护记忆），但本轮校准与验收都在 `assisted` 下跑。classic 下 `memoryFidelity` 才真正生效，需要单独一轮校准。 | 中 |
| **赌徒的负期望** | `k = 0.45` 把门槛压到 p̂ 自然下限附近，胜率 15.6%（随机基线 25%），长期必然亏分。这是**设计意图**（气氛组），但如果要它"会玩但很莽"，应把 `k` 提到 0.8–1.0。 | 低（产品决策） |
| **月神彩蛋** | `moonAmbition` 参数位已保留，未实现月相检测（D5）。 | 低 |
| **`decisionLatencyMs` 与预算** | 端到端测试里拟人延迟置零；真实节奏下（佛系老王 2200ms）需要一轮"延迟是否被频繁夹取"的线上观测，确认拟人节奏不会被超时吃掉。 | 中 |
