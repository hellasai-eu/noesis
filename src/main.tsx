// Side-effect import: initialises the i18next singleton and picks a locale from
// storage/browser *before* anything renders, so no surface flashes untranslated.
// Kept first on purpose — imports execute in source order.
import "./i18n";

import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import { initErrorTracking } from "./lib/error-tracking";
import "./index.css";

// No-op unless VITE_SENTRY_DSN is set at build time. Installed before the
// first render so render-time crashes are caught too.
initErrorTracking();

createRoot(document.getElementById("root")!).render(<App />);
