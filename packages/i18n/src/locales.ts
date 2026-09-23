export const SUPPORTED_LOCALES = [
  "en-US", "en-GB", "en-AU",
  "zh-CN", "zh-TW", "zh-HK",
  "pt-BR", "pt-PT", "pt-AO",
] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];
export type LocalePreference = "auto" | SupportedLocale;
export const DEFAULT_LOCALE: SupportedLocale = "en-US";
export const LOCALE_PREFERENCE_KEY = "cabo.locale.v1";

export interface LocaleResolutionSources {
  cookie?: string | null;
  storedPreference?: string | null;
  navigatorLanguages?: readonly string[] | null;
  acceptLanguage?: string | null;
}

const supported = new Set<string>(SUPPORTED_LOCALES);
const africanPortuguese = new Set(["AO", "MZ", "CV", "GW", "ST", "GQ"]);

export function isSupportedLocale(value: unknown): value is SupportedLocale {
  return typeof value === "string" && supported.has(value);
}

export function isLocalePreference(value: unknown): value is LocalePreference {
  return value === "auto" || isSupportedLocale(value);
}

export function resolveLocale(candidates: readonly string[] | string | LocaleResolutionSources | null | undefined): SupportedLocale {
  const values = isResolutionSources(candidates)
    ? candidatesFromSources(candidates)
    : typeof candidates === "string" ? parseLanguageHeader(candidates) : candidates ?? [];
  for (const candidate of values) {
    const resolved = resolveCandidate(candidate);
    if (resolved) return resolved;
  }
  return DEFAULT_LOCALE;
}

function isResolutionSources(value: readonly string[] | string | LocaleResolutionSources | null | undefined): value is LocaleResolutionSources {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function candidatesFromSources(sources: LocaleResolutionSources): string[] {
  const cookie = sources.cookie?.match(new RegExp(`(?:^|;\\s*)${LOCALE_PREFERENCE_KEY}=([^;]+)`))?.[1];
  const fixed = [cookie ? decodeURIComponent(cookie) : undefined, sources.storedPreference]
    .find((value) => value && value !== "auto");
  if (fixed) return [fixed];
  return [...(sources.navigatorLanguages ?? []), ...parseLanguageHeader(sources.acceptLanguage ?? "")];
}

function resolveCandidate(input: string): SupportedLocale | undefined {
  const raw = input.trim().replace(/^en-UK\b/i, "en-GB");
  if (!raw) return;
  let locale: Intl.Locale;
  try { locale = new Intl.Locale(raw); } catch { return; }
  const canonical = locale.toString();
  if (isSupportedLocale(canonical)) return canonical;
  const language = locale.language.toLowerCase();
  const region = locale.region?.toUpperCase();
  const script = locale.script;
  if (language === "en") {
    if (region === "GB" || region === "IE") return "en-GB";
    if (region === "AU" || region === "NZ") return "en-AU";
    return "en-US";
  }
  if (language === "zh") {
    if (region === "HK" || region === "MO") return "zh-HK";
    if (region === "TW" || script === "Hant") return "zh-TW";
    return "zh-CN";
  }
  if (language === "pt") {
    if (region === "PT") return "pt-PT";
    if (region && africanPortuguese.has(region)) return "pt-AO";
    return "pt-BR";
  }
  return;
}

function parseLanguageHeader(value: string): string[] {
  if (!value.includes(",") && !/;\s*q=/i.test(value)) return [value];
  return value.split(",")
    .map((entry, index) => {
      const [tag = "", ...parameters] = entry.trim().split(";");
      const quality = parameters.map((parameter) => /^\s*q=([0-9.]+)\s*$/i.exec(parameter)?.[1]).find(Boolean);
      return { tag, quality: quality === undefined ? 1 : Number(quality), index };
    })
    .filter(({ tag, quality }) => Boolean(tag) && Number.isFinite(quality) && quality > 0)
    .sort((a, b) => b.quality - a.quality || a.index - b.index)
    .map(({ tag }) => tag);
}

export const LOCALE_LABELS: Readonly<Record<SupportedLocale, string>> = {
  "en-US": "English (United States)",
  "en-GB": "English (United Kingdom)",
  "en-AU": "English (Australia)",
  "zh-CN": "简体中文（中国大陆）",
  "zh-TW": "繁體中文（台灣）",
  "zh-HK": "繁體中文（香港）",
  "pt-BR": "Português (Brasil)",
  "pt-PT": "Português (Portugal)",
  "pt-AO": "Português (Angola)",
};
