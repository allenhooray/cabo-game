import { isLocalePreference, LOCALE_PREFERENCE_KEY, resolveLocale, type LocalePreference, type SupportedLocale } from "@cabo-game/i18n";

export const LOCALE_STORAGE_KEY = LOCALE_PREFERENCE_KEY;
export const THEME_STORAGE_KEY = "cabo.theme.v1";
export type ThemePreference = "auto" | "light" | "dark";

export function readLocalePreference(): LocalePreference {
  const value = safeStorageGet(LOCALE_STORAGE_KEY);
  return isLocalePreference(value) ? value : "auto";
}

export function readThemePreference(): ThemePreference {
  const value = safeStorageGet(THEME_STORAGE_KEY);
  return value === "light" || value === "dark" || value === "auto" ? value : "auto";
}

export function systemLocale(): SupportedLocale {
  return resolveLocale(typeof navigator === "undefined" ? [] : navigator.languages?.length ? navigator.languages : [navigator.language]);
}

export function activeLocale(preference: LocalePreference): SupportedLocale {
  return preference === "auto" ? systemLocale() : preference;
}

export function persistLocale(preference: LocalePreference): void {
  safeStorageSet(LOCALE_STORAGE_KEY, preference);
  if (typeof document === "undefined") return;
  if (preference === "auto") {
    document.cookie = `${LOCALE_STORAGE_KEY}=; Path=/; Max-Age=0; SameSite=Lax`;
    return;
  }
  const secure = typeof location !== "undefined" && location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${LOCALE_STORAGE_KEY}=${encodeURIComponent(preference)}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
}

export function persistTheme(preference: ThemePreference): void {
  safeStorageSet(THEME_STORAGE_KEY, preference);
  applyTheme(preference);
}

export function applyTheme(preference: ThemePreference): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (preference === "auto") delete root.dataset.theme;
  else root.dataset.theme = preference;
  const dark = preference === "dark" || (preference === "auto" && globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches);
  root.style.colorScheme = dark ? "dark" : "light";
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) meta.remove();
  const meta = document.createElement("meta");
  meta.name = "theme-color";
  meta.content = dark ? "#0b0b0c" : "#ecebea";
  document.head.append(meta);
}

export function applyInitialPreferences(): void {
  applyTheme(readThemePreference());
  if (typeof document !== "undefined") document.documentElement.lang = activeLocale(readLocalePreference());
}

function safeStorageGet(key: string): string | null {
  try { return typeof localStorage === "undefined" ? null : localStorage.getItem(key); } catch { return null; }
}

function safeStorageSet(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* Preferences remain session-only when storage is unavailable. */ }
}
