import i18next, { type i18n, type TFunction } from "i18next";
import { catalogs, type Catalog, type MessageKey } from "./catalogs/index.js";
import { DEFAULT_LOCALE, resolveLocale, type SupportedLocale } from "./locales.js";

export * from "./locales.js";
export * from "./docs-text.js";
export type { Catalog, MessageKey } from "./catalogs/index.js";

export type MessageNamespace = "common" | "home" | "session" | "chat" | "room" | "game" | "event" | "result" | "modal" | "docs" | "settings" | "nav" | "connection";

export async function loadMessages(locale: SupportedLocale, namespaces?: readonly MessageNamespace[]): Promise<Catalog | Partial<Catalog>> {
  const catalog = catalogs[locale];
  if (!namespaces?.length) return catalog;
  const prefixes = namespaces.map((namespace) => `${namespace}.`);
  return Object.fromEntries(Object.entries(catalog).filter(([key]) => prefixes.some((prefix) => key.startsWith(prefix)))) as Partial<Catalog>;
}

export async function createTranslator(localeInput: SupportedLocale | string, namespaces?: readonly MessageNamespace[]): Promise<{ locale: SupportedLocale; i18n: i18n; t: TFunction }> {
  const locale = resolveLocale(localeInput);
  const messages = await loadMessages(locale, namespaces);
  const instance = i18next.createInstance();
  await instance.init({
    lng: locale,
    fallbackLng: DEFAULT_LOCALE,
    keySeparator: false,
    nsSeparator: false,
    interpolation: { escapeValue: false },
    resources: {
      [locale]: { translation: messages },
      ...(locale === DEFAULT_LOCALE ? {} : { [DEFAULT_LOCALE]: { translation: catalogs[DEFAULT_LOCALE] } }),
    },
    returnNull: false,
  });
  return { locale, i18n: instance, t: instance.t.bind(instance) };
}

export function messageKeys(): readonly MessageKey[] {
  return Object.keys(catalogs[DEFAULT_LOCALE]) as MessageKey[];
}
