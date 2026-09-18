import { useLocation } from "react-router-dom";

import { SiteFooter } from "@/components/SiteFooter";

/**
 * Renders the site footer everywhere except the routes that already end in one
 * (issue #937).
 *
 * There is no shared authenticated shell in this app — every page builds its
 * own nav — so a footer added page by page would be a sweep across forty files
 * and would be missing from the forty-first. Rendering it once under `<Routes>`
 * catches all of them.
 *
 * The catch is that nearly every page opens with `min-h-screen`, so a footer
 * rendered *after* the route starts at 100vh at the earliest. On a page whose
 * content fills the screen that reads as an ordinary footer; on a short one it
 * means scrolling through blank space to reach the legal links. So the pages
 * people actually live in render their own inside a flex column, where the
 * footer sits at the bottom of the content or the bottom of the viewport,
 * whichever is lower — and this component stays out of their way.
 *
 * Adding a page to this list without giving it a footer of its own silently
 * removes the legal links from it. The list is short on purpose.
 */

const ROUTES_WITH_THEIR_OWN_FOOTER = [
  // `/` is the deployment overlay's landing page, so it owns its own footer —
  // `<SiteFooter tone="brand" />` if it wants the dark band, none if it does
  // not. The default overlay redirects to `/auth` and needs neither.
  /^\/$/,
  /^\/legal(\/|$)/, // legal pages — their own flex column
  /^\/student\/?$/, // student dashboard
  // The course surface wears the same `SurfaceShell` as the dashboard, footer
  // included — but only the course page itself. The routes nested under it
  // (quiz history, community questions) are ordinary pages and still need one.
  /^\/student\/course\/[^/]+\/?$/,
  /^\/dashboard\/?$/, // instructor / institution dashboard
  /^\/instructor\/?$/, // instructor home — its own flex column with SiteFooter
];

export const GlobalFooter = () => {
  const { pathname } = useLocation();

  if (ROUTES_WITH_THEIR_OWN_FOOTER.some((pattern) => pattern.test(pathname))) {
    return null;
  }

  return <SiteFooter />;
};

export default GlobalFooter;
