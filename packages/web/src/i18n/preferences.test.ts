import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  LOCALE_STORAGE_KEY,
  THEME_STORAGE_KEY,
  applyTheme,
  persistLocale,
  persistTheme,
  readLocalePreference,
  readThemePreference,
} from "./preferences.js";

describe("web preferences", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
    document.cookie = `${LOCALE_STORAGE_KEY}=; Path=/; Max-Age=0`;
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  });

  it("persists a fixed locale in storage and a SameSite cookie", () => {
    persistLocale("zh-CN");
    expect(readLocalePreference()).toBe("zh-CN");
    expect(document.cookie).toContain(`${LOCALE_STORAGE_KEY}=zh-CN`);
  });

  it("keeps the auto preference in storage and removes the fixed cookie", () => {
    persistLocale("pt-BR");
    persistLocale("auto");
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("auto");
    expect(document.cookie).not.toContain(`${LOCALE_STORAGE_KEY}=`);
  });

  it("applies and persists explicit themes, then restores system mode", () => {
    persistTheme("dark");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(readThemePreference()).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");

    applyTheme("auto");
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(document.documentElement.style.colorScheme).toBe("light");
  });
});
