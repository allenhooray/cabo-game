import { describe, expect, it } from "vitest";
import { createTranslator, loadMessages, messageKeys, resolveLocale, SUPPORTED_LOCALES } from "./index.js";

describe("locale resolution", () => {
  it.each([
    ["en-UK", "en-GB"], ["en-IE", "en-GB"], ["en-NZ", "en-AU"], ["en-CA", "en-US"],
    ["zh-Hant", "zh-TW"], ["zh-MO", "zh-HK"], ["zh-Hans-SG", "zh-CN"],
    ["pt-PT", "pt-PT"], ["pt-MZ", "pt-AO"], ["pt-BR", "pt-BR"], ["fr-FR", "en-US"],
  ])("maps %s to %s", (input, expected) => expect(resolveLocale(input)).toBe(expected));

  it("honours Accept-Language quality order", () => {
    expect(resolveLocale("fr-FR;q=0.9, pt-PT;q=1, en-US;q=0.5")).toBe("pt-PT");
  });

  it("resolves browser and request preference sources in priority order", () => {
    expect(resolveLocale({ cookie: "x=1; cabo.locale.v1=zh-HK", storedPreference: "pt-PT", navigatorLanguages: ["en-AU"] })).toBe("zh-HK");
    expect(resolveLocale({ storedPreference: "auto", navigatorLanguages: ["fr-FR", "en-UK"], acceptLanguage: "pt-PT" })).toBe("en-GB");
    expect(resolveLocale({ acceptLanguage: "pt-MZ, en-US;q=0.5" })).toBe("pt-AO");
  });
});

describe("catalogs", () => {
  it("exposes the complete key set for every locale", async () => {
    const expected = [...messageKeys()].sort();
    for (const locale of SUPPORTED_LOCALES) expect(Object.keys(await loadMessages(locale)).sort()).toEqual(expected);
  });

  it("creates a framework-neutral translator", async () => {
    const translator = await createTranslator("zh-CN");
    expect(translator.t("settings.trigger")).toBe("设置");
    expect(translator.t("common.points", { count: 3 })).toBe("3 分");
  });
});
