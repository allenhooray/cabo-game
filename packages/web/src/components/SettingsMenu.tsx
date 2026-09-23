import { useEffect, useRef, useState } from "react";
import { LOCALE_LABELS, SUPPORTED_LOCALES, type LocalePreference } from "@cabo-game/i18n";
import { useTranslation } from "react-i18next";
import { usePreferences } from "../i18n/I18nProvider.js";
import type { ThemePreference } from "../i18n/preferences.js";

export function SettingsMenu() {
  const { t } = useTranslation();
  const preferences = usePreferences();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, []);

  return (
    <div
      ref={root}
      className={`settings-menu ${open ? "is-open" : ""}`}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}
      onKeyDown={(event) => {
        if (event.key === "Escape") { setOpen(false); trigger.current?.focus(); }
      }}
    >
      <button ref={trigger} className="settings-trigger" type="button" aria-haspopup="dialog" aria-expanded={open} aria-controls="cabo-settings" onClick={() => setOpen(true)}>{t("settings.trigger")}</button>
      <section id="cabo-settings" className="settings-panel" role="dialog" aria-label={t("settings.title")} hidden={!open}>
        <SettingGroup<ThemePreference>
          legend={t("settings.theme")}
          name="theme"
          value={preferences.themePreference}
          options={[
            ["auto", t("settings.auto")], ["dark", t("settings.dark")], ["light", t("settings.light")],
          ]}
          onChange={preferences.setThemePreference}
        />
        <SettingGroup<LocalePreference>
          legend={t("settings.language")}
          name="locale"
          value={preferences.localePreference}
          options={[["auto", t("settings.auto")], ...SUPPORTED_LOCALES.map((locale) => [locale, LOCALE_LABELS[locale]] as const)]}
          onChange={preferences.setLocalePreference}
        />
      </section>
    </div>
  );
}

function SettingGroup<T extends string>(props: { legend: string; name: string; value: T; options: ReadonlyArray<readonly [T, string]>; onChange(value: T): void }) {
  return <fieldset><legend>{props.legend}</legend><div className="settings-options">{props.options.map(([value, label]) => <label key={value}><input type="radio" name={props.name} value={value} checked={props.value === value} onChange={() => props.onChange(value)} /><span>{label}</span></label>)}</div></fieldset>;
}
