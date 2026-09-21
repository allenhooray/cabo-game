import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { DocsApp, isDocPage } from "./DocsApp.js";
import "./styles.css";
import "./docs.css";

const page = document.documentElement.dataset.docPage;

if (!isDocPage(page)) throw new Error(`Unknown documentation page: ${page ?? "missing"}`);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <DocsApp page={page} />
  </StrictMode>,
);
