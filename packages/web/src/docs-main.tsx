import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { hydrateRoot } from "react-dom/client";
import { createTranslator, resolveLocale } from "@cabo-game/i18n";
import { DocsApp, isDocPage } from "./DocsApp.js";
import { parseLocalizedDocsPath } from "./docs-route.js";
import { CaboI18nProvider } from "./i18n/I18nProvider.js";
import { applyInitialPreferences } from "./i18n/preferences.js";
import { activeLocale, readLocalePreference } from "./i18n/preferences.js";
import "./styles.css";
import "./docs.css";

const page = document.documentElement.dataset.docPage;

if (!isDocPage(page)) throw new Error(`Unknown documentation page: ${page ?? "missing"}`);
if (/^\/docs\/(rules|cli|agent)\/?$/.test(window.location.pathname)) {
  window.location.replace(`/${activeLocale(readLocalePreference())}/docs/${page}/${window.location.search}${window.location.hash}`);
}
const locale = parseLocalizedDocsPath(window.location.pathname)?.locale ?? resolveLocale(document.documentElement.lang);
applyInitialPreferences();
document.documentElement.lang = locale;
const translator = await createTranslator(locale);
const root = document.getElementById("root")!;
const app = <StrictMode><CaboI18nProvider initialLocale={locale} initialInstance={translator.i18n}><DocsApp page={page} /></CaboI18nProvider></StrictMode>;

if (root.dataset.ssg === "true") hydrateRoot(root, app);
else createRoot(root).render(app);
