import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const entry = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  build: {
    outDir: "dist",
    rollupOptions: {
      input: {
        main: entry("./index.html"),
        rules: entry("./docs/rules/index.html"),
        cli: entry("./docs/cli/index.html"),
        agent: entry("./docs/agent/index.html"),
      },
    },
  },
});
