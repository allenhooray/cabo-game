import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { CaboI18nProvider } from "./i18n/I18nProvider.js";
import { applyInitialPreferences } from "./i18n/preferences.js";
import "./styles.css";

applyInitialPreferences();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <CaboI18nProvider><App /></CaboI18nProvider>
  </StrictMode>,
);
