import { LOCALE_LABELS, SUPPORTED_LOCALES, type LocalePreference } from "@cabo-game/i18n";
import { useTranslation } from "react-i18next";
import { usePreferences } from "../i18n/I18nProvider.js";
import type { ThemePreference } from "../i18n/preferences.js";
import { useDisclosure } from "./useDisclosure.js";

export function SettingsMenu() {
  const { t } = useTranslation();
  const preferences = usePreferences();
  const disclosure = useDisclosure({ hover: true, outsidePress: true, clickMode: "open", closePinnedOnLeave: true });

  return (
    <div
      ref={disclosure.rootRef}
      className={`settings-menu ${disclosure.open ? "is-open" : ""}`}
      {...disclosure.rootProps}
    >
      <button ref={disclosure.triggerRef} className="settings-trigger" type="button" aria-haspopup="dialog" aria-expanded={disclosure.open} aria-controls="cabo-settings" {...disclosure.triggerProps}>{t("settings.trigger")}</button>
      <section id="cabo-settings" className="settings-panel" role="dialog" aria-label={t("settings.title")} hidden={!disclosure.open}>
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
