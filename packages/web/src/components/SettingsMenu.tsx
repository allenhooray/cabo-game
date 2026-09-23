import { LOCALE_LABELS, SUPPORTED_LOCALES, type LocalePreference } from "@cabo-game/i18n";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { usePreferences } from "../i18n/I18nProvider.js";
import type { ThemePreference } from "../i18n/preferences.js";
import { Popover } from "./Popover.js";

export function SettingsMenu() {
  const { t } = useTranslation();
  const preferences = usePreferences();
  return (
    <Popover
      id="cabo-settings"
      className="settings-menu"
      triggerClassName="settings-trigger"
      panelClassName="settings-panel"
      trigger={<><SettingsIcon /><span>{t("settings.trigger")}</span></>}
      panelAs="section"
      role="dialog"
      ariaLabel={t("settings.title")}
    >
      <div className="settings-panel-content">
        <SettingSelect<ThemePreference>
          icon={<ThemeIcon />}
          label={t("settings.theme")}
          name="theme"
          value={preferences.themePreference}
          options={[
            ["auto", t("settings.auto")], ["dark", t("settings.dark")], ["light", t("settings.light")],
          ]}
          onChange={preferences.setThemePreference}
        />
        <SettingSelect<LocalePreference>
          icon={<LanguageIcon />}
          label={t("settings.language")}
          name="locale"
          value={preferences.localePreference}
          options={[["auto", t("settings.auto")], ...SUPPORTED_LOCALES.map((locale) => [locale, LOCALE_LABELS[locale]] as const)]}
          onChange={preferences.setLocalePreference}
        />
      </div>
    </Popover>
  );
}

function SettingSelect<T extends string>(props: { icon: ReactNode; label: string; name: string; value: T; options: ReadonlyArray<readonly [T, string]>; onChange(value: T): void }) {
  return (
    <label className="settings-field" htmlFor={`settings-${props.name}`}>
      <span className="settings-field-label">{props.icon}<span>{props.label}</span></span>
      <span className="settings-select-wrap">
        <select id={`settings-${props.name}`} name={props.name} value={props.value} onChange={(event) => props.onChange(event.target.value as T)}>
          {props.options.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <ChevronIcon />
      </span>
    </label>
  );
}

const iconProps = { "aria-hidden": true, focusable: false, viewBox: "0 0 24 24" } as const;

function SettingsIcon() {
  return <svg {...iconProps}><path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" /><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V21h-4v-.08A1.7 1.7 0 0 0 8.94 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.03H3v-4h.08A1.7 1.7 0 0 0 4.6 8.94a1.7 1.7 0 0 0-.34-1.88L4.2 7l2.83-2.83.06.06a1.7 1.7 0 0 0 1.88.34H9A1.7 1.7 0 0 0 10 3.08V3h4v.08a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.88-.34l.06-.06L19.8 7l-.06.06a1.7 1.7 0 0 0-.34 1.88v.03A1.7 1.7 0 0 0 20.92 10H21v4h-.08A1.7 1.7 0 0 0 19.4 15Z" /></svg>;
}

function ThemeIcon() {
  return <svg {...iconProps}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.65 17.65l1.42 1.42M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.65 6.35l1.42-1.42" /></svg>;
}

function LanguageIcon() {
  return <svg {...iconProps}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></svg>;
}

function ChevronIcon() {
  return <svg {...iconProps}><path d="m8 10 4 4 4-4" /></svg>;
}
