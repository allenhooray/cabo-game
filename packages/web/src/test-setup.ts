import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import { loadMessages } from "@cabo-game/i18n";

await i18next.use(initReactI18next).init({
  lng: "en-US",
  fallbackLng: "en-US",
  keySeparator: false,
  nsSeparator: false,
  interpolation: { escapeValue: false },
  resources: { "en-US": { translation: await loadMessages("en-US") } },
});

afterEach(() => cleanup());
