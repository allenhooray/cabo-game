import { useTranslation } from "react-i18next";
import { usePreferences } from "../i18n/I18nProvider.js";
import { SettingsMenu } from "./SettingsMenu.js";

export type SitePage = "play" | "rules" | "cli" | "agent";

const pages: SitePage[] = ["play", "rules", "cli", "agent"];

export function SiteHeader(props: { activePage: SitePage; className: "home-header" | "docs-header" }) {
  const { t } = useTranslation();
  const { locale } = usePreferences();
  return (
    <header className={`${props.className} site-header`}>
      {props.activePage === "play"
        ? <span className="wordmark-static">CABO</span>
        : <a className="wordmark-static" href="/" aria-label="Cabo">CABO</a>}
      <nav aria-label={t("nav.main")}>
        {pages.map((page) => (
          <a
            key={page}
            href={page === "play" ? "/" : `/${locale}/docs/${page}/`}
            aria-current={page === props.activePage ? "page" : undefined}
          >
            {t(`nav.${page}`)}
          </a>
        ))}
      </nav>
      <SettingsMenu />
    </header>
  );
}
