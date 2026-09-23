import { describe, expect, it } from "vitest";
import { parseLocalizedDocsPath, rewriteLocalizedDocsUrl } from "./docs-route.js";

describe("localized documentation routes", () => {
  it("parses supported locale and page combinations", () => {
    expect(parseLocalizedDocsPath("/zh-CN/docs/rules/")).toEqual({ locale: "zh-CN", page: "rules" });
    expect(parseLocalizedDocsPath("/en-GB/docs/agent")).toEqual({ locale: "en-GB", page: "agent" });
  });

  it("rejects unsupported locales and documentation pages", () => {
    expect(parseLocalizedDocsPath("/fr-FR/docs/rules/")).toBeUndefined();
    expect(parseLocalizedDocsPath("/en-US/docs/unknown/")).toBeUndefined();
    expect(parseLocalizedDocsPath("/docs/rules/")).toBeUndefined();
  });

  it("rewrites localized development URLs to their HTML entry while preserving the query", () => {
    expect(rewriteLocalizedDocsUrl("/pt-BR/docs/cli/?source=nav")).toBe("/docs/cli/?source=nav");
    expect(rewriteLocalizedDocsUrl("/docs/cli/?source=nav")).toBeUndefined();
  });
});
