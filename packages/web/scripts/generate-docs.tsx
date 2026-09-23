import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToString } from "react-dom/server";
import { createTranslator, SUPPORTED_LOCALES, type SupportedLocale } from "@cabo-game/i18n";
import { DocsApp, docPages, type DocPage } from "../src/DocsApp.js";
import { CaboI18nProvider } from "../src/i18n/I18nProvider.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(packageRoot, "dist");
const origin = "https://cabo.human404.link";

for (const page of docPages) {
  const template = await readFile(resolve(dist, "docs", page, "index.html"), "utf8");
  for (const locale of SUPPORTED_LOCALES) await generatePage(template, page, locale);
}

const urls = ["/", ...SUPPORTED_LOCALES.flatMap((locale) => docPages.map((page) => `/${locale}/docs/${page}/`))];
await writeFile(resolve(dist, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((url) => `  <url><loc>${origin}${url}</loc></url>`).join("\n")}\n</urlset>\n`);

async function generatePage(template: string, page: DocPage, locale: SupportedLocale): Promise<void> {
  const translator = await createTranslator(locale);
  const markup = renderToString(<CaboI18nProvider initialLocale={locale} initialInstance={translator.i18n}><DocsApp page={page} /></CaboI18nProvider>);
  const canonical = `${origin}/${locale}/docs/${page}/`;
  const title = translator.t(`docs.${page}.title`);
  const description = translator.t(`docs.${page}.lede`);
  const alternates = [
    ...SUPPORTED_LOCALES.map((candidate) => `<link rel="alternate" hreflang="${candidate}" href="${origin}/${candidate}/docs/${page}/" />`),
    `<link rel="alternate" hreflang="x-default" href="${origin}/docs/${page}/" />`,
  ].join("\n    ");
  const html = template
    .replace(/<html lang="[^"]+"/, `<html lang="${locale}"`)
    .replace(/<div id="root"><\/div>/, `<div id="root" data-ssg="true">${markup}</div>`)
    .replace(/<title>.*?<\/title>/, `<title>${escapeHtml(title)} — Cabo</title>`)
    .replace(/<meta name="description" content="[^"]*" \/>/, `<meta name="description" content="${escapeHtml(description)}" />`)
    .replace(/<link rel="canonical" href="[^"]*" \/>/, `<link rel="canonical" href="${canonical}" />\n    ${alternates}`)
    .replace(/<meta property="og:title" content="[^"]*" \/>/, `<meta property="og:title" content="${escapeHtml(title)}" />`)
    .replace(/<meta property="og:description" content="[^"]*" \/>/, `<meta property="og:description" content="${escapeHtml(description)}" />`)
    .replace(/<meta property="og:url" content="[^"]*" \/>/, `<meta property="og:url" content="${canonical}" />`)
    .replace(/<meta name="twitter:title" content="[^"]*" \/>/, `<meta name="twitter:title" content="${escapeHtml(title)}" />`)
    .replace(/<meta name="twitter:description" content="[^"]*" \/>/, `<meta name="twitter:description" content="${escapeHtml(description)}" />`);
  const output = resolve(dist, locale, "docs", page, "index.html");
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, html);
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
