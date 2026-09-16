/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BUILD_TIME: string;
  readonly VITE_GIT_COMMIT: string;
  // Error-tracking ingest DSN (Sentry/GlitchTip). Unset = tracking disabled.
  readonly VITE_SENTRY_DSN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
