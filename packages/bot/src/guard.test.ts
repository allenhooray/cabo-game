/**
 * 防作弊守卫（方案 §6.5，强制项）。
 *
 * 这条测试是"陪玩"和"作弊"的分界线，不可省略。它断言的是**信息边界**，
 * 不是"别写某几个函数名"：
 *
 *  1. 决策核心（belief / evaluate / plans / policy / persona / driver）只能看到
 *     `AgentObservation` + 事件帧 + 自己维护的记忆。它不允许 import 引擎、harness
 *     或服务端——只要能 import，迟早会有人顺手读一下暗牌。
 *  2. 全包范围内不允许出现 `debugHand`（引擎的"看所有人手牌"接口）。
 *  3. 全包范围内不允许 import `@cabo-game/server`。
 *
 * 关于 `getPendingDraw`：方案原文把它和 `debugHand` 并列列为禁项，实现之后
 * 发现这个划分过粗，这里按实际信息语义收紧：
 *  - 它返回的是**当前回合玩家自己刚抽的那张牌**，服务端自己也调它
 *    （`CaboRoom.ts` 里 `publicAction` 的入参），而且只有 `source === "discard"`
 *    时才会被公开（那张牌本来就是弃牌堆栈顶，早已公开）。
 *  - 所以真正要守的不是"别调它"，而是"它只能出现在 harness 适配层里，用来
 *    复刻服务端的信息管线，绝不能流进决策核心"。
 *  下面第 4 条断言就是这个约束。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(here, ".");

/** 决策核心：这些文件只允许依赖 `@cabo-game/shared` 的类型和自己的兄弟模块。 */
const DECISION_CORE = ["belief.ts", "evaluate.ts", "plans.ts", "policy.ts", "persona.ts", "index.ts", "driver.ts"];

/** 允许调用 `getPendingDraw` 的唯一位置（复刻服务端管线）。 */
const ENGINE_ADAPTER = "harness/engine-adapter.ts";

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
      continue;
    }
    if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

/** 去掉注释再检查：守卫拦的是代码，不是文档。适配层的注释里正好写了这个函数名。 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const files = walk(sourceRoot).map((path) => ({
  path,
  rel: relative(sourceRoot, path),
  text: readFileSync(path, "utf8"),
  code: stripComments(readFileSync(path, "utf8")),
}));

describe("防作弊守卫", () => {
  it("全包内不出现 debugHand", () => {
    const offenders = files.filter((file) => /\bdebugHand\b/.test(file.code)).map((file) => file.rel);
    expect(offenders).toEqual([]);
  });

  it("全包内不 import @cabo-game/server", () => {
    const offenders = files
      .filter((file) => /from\s+["']@cabo-game\/server/.test(file.code) || /require\(\s*["']@cabo-game\/server/.test(file.code))
      .map((file) => file.rel);
    expect(offenders).toEqual([]);
  });

  it("决策核心不依赖引擎 / harness / 服务端", () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (!DECISION_CORE.includes(file.rel)) continue;
      const imports = [...file.code.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1] as string);
      for (const specifier of imports) {
        const bad = specifier.includes("harness")
          || specifier.includes("@cabo-game/server")
          || /(^|\/)engine(\.js)?$/.test(specifier)
          || specifier.includes("client-core");
        if (bad) offenders.push(`${file.rel} → ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("getPendingDraw 只出现在 harness 适配层", () => {
    const offenders = files
      .filter((file) => /\bgetPendingDraw\b/.test(file.code) && file.rel !== ENGINE_ADAPTER)
      .map((file) => file.rel);
    expect(offenders).toEqual([]);
    // 适配层确实用了它——否则这条断言会因为"谁都没用"而空过，失去意义。
    expect(files.some((file) => file.rel === ENGINE_ADAPTER && /\bgetPendingDraw\b/.test(file.code))).toBe(true);
  });

  it("决策核心不读对手手牌的具体点数（只能通过 observation / 事件获得）", () => {
    // 结构化的第二道防线：决策核心里不允许出现"引擎内部字段"的访问痕迹。
    const forbidden = /\b(player\.hand|engine\.players|this\.deck\b|debugHand)\b/;
    const offenders = files
      .filter((file) => DECISION_CORE.includes(file.rel) && forbidden.test(file.code))
      .map((file) => file.rel);
    expect(offenders).toEqual([]);
  });
});
