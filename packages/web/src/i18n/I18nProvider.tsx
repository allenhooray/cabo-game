import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { createTranslator, DEFAULT_LOCALE, type LocalePreference, type SupportedLocale } from "@cabo-game/i18n";
import type { i18n } from "i18next";
import { I18nextProvider } from "react-i18next";
import {
  activeLocale, applyTheme, persistLocale, persistTheme, readLocalePreference, readThemePreference,
  type ThemePreference,
} from "./preferences.js";

interface PreferencesContextValue {
  locale: SupportedLocale;
  localePreference: LocalePreference;
  themePreference: ThemePreference;
  setLocalePreference(value: LocalePreference): void;
  setThemePreference(value: ThemePreference): void;
}

const PreferencesContext = createContext<PreferencesContextValue>({
  locale: DEFAULT_LOCALE,
  localePreference: "auto",
  themePreference: "auto",
  setLocalePreference: () => undefined,
  setThemePreference: () => undefined,
});

export function CaboI18nProvider(props: { children: ReactNode; initialLocale?: SupportedLocale; initialInstance?: i18n }) {
  const [localePreference, setLocalePreferenceState] = useState<LocalePreference>(() => props.initialLocale ?? readLocalePreference());
  const [themePreference, setThemePreferenceState] = useState<ThemePreference>(readThemePreference);
  const locale = props.initialLocale ?? activeLocale(localePreference);
  const [instance, setInstance] = useState<i18n | undefined>(props.initialInstance);

  useEffect(() => {
    let active = true;
    void createTranslator(locale).then((translator) => {
      if (!active) return;
      document.documentElement.lang = translator.locale;
      setInstance(translator.i18n);
      updateMetadata(translator.t);
    });
    return () => { active = false; };
  }, [locale]);

  useEffect(() => {
    applyTheme(themePreference);
    const media = matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => { if (themePreference === "auto") applyTheme("auto"); };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [themePreference]);

  useEffect(() => {
    const onLanguageChange = () => {
      if (localePreference !== "auto" || props.initialLocale) return;
      setLocalePreferenceState("auto");
      navigateLocalizedDocs(activeLocale("auto"));
    };
    window.addEventListener("languagechange", onLanguageChange);
    return () => window.removeEventListener("languagechange", onLanguageChange);
  }, [localePreference, props.initialLocale]);

  const setLocalePreference = useCallback((value: LocalePreference) => {
    persistLocale(value);
    const next = activeLocale(value);
    if (navigateLocalizedDocs(next)) return;
    setLocalePreferenceState(value);
  }, []);
  const setThemePreference = useCallback((value: ThemePreference) => {
    persistTheme(value);
    setThemePreferenceState(value);
  }, []);
  const value = useMemo<PreferencesContextValue>(() => ({
    locale, localePreference, themePreference, setLocalePreference, setThemePreference,
  }), [locale, localePreference, setLocalePreference, setThemePreference, themePreference]);

  if (!instance) return <div className="boot-skeleton" aria-busy="true" />;
  return <I18nextProvider i18n={instance}><PreferencesContext.Provider value={value}>{props.children}</PreferencesContext.Provider></I18nextProvider>;
}

export function usePreferences(): PreferencesContextValue {
  return useContext(PreferencesContext);
}

function navigateLocalizedDocs(locale: SupportedLocale): boolean {
  if (typeof window === "undefined") return false;
  const match = window.location.pathname.match(/^\/(?:[A-Za-z]{2}(?:-[A-Za-z]{2})?\/)?docs\/(rules|cli|agent)\/?$/);
  if (!match?.[1]) return false;
  const destination = `/${locale}/docs/${match[1]}/${window.location.search}${window.location.hash}`;
  if (destination !== `${window.location.pathname}${window.location.search}${window.location.hash}`) window.location.assign(destination);
  return true;
}

function updateMetadata(t: (key: string) => string): void {
  const page = document.documentElement.dataset.docPage;
  const titleKey = page === "rules" || page === "cli" || page === "agent" ? `docs.${page}.title` : undefined;
  if (titleKey) document.title = `${t(titleKey)} — Cabo`;
}
