import { isSupportedLocale, type SupportedLocale } from "@cabo-game/i18n";
import { isDocPage, type DocPage } from "./DocsApp.js";

export interface LocalizedDocsRoute {
  locale: SupportedLocale;
  page: DocPage;
}

export function parseLocalizedDocsPath(pathname: string): LocalizedDocsRoute | undefined {
  const match = pathname.match(/^\/([^/]+)\/docs\/([^/]+)\/?$/);
  if (!match || !isSupportedLocale(match[1]) || !isDocPage(match[2])) return;
  return { locale: match[1], page: match[2] };
}

export function rewriteLocalizedDocsUrl(url: string): string | undefined {
  const parsed = new URL(url, "http://localhost");
  const route = parseLocalizedDocsPath(parsed.pathname);
  if (!route) return;
  return `/docs/${route.page}/${parsed.search}`;
}
