/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CABO_SERVER_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
