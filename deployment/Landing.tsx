import { Navigate } from "react-router-dom";

/**
 * The default landing page: there isn't one.
 *
 * `/` used to be a 600-line marketing page for one particular product, which
 * made this repository unusable by anyone else without deleting it first. The
 * route now renders whatever the deployment overlay puts here, and the default
 * is to send a visitor straight to the sign-in screen — the only thing an
 * unbranded clone can honestly offer at `/`.
 *
 * A deployment replaces this file with its own component. It is an ordinary
 * route element, so it can be a full marketing page, a redirect to a separate
 * marketing site, or a role-aware switch. Two things worth knowing if you
 * write a real one:
 *
 * - `/` is in `GlobalFooter`'s exclusion list, so this component owns its own
 *   footer. `<SiteFooter tone="brand" />` is the dark band that pairs with a
 *   marketing page; omit it and `/` has no footer at all.
 * - `useAuth()` is available here, so a signed-in visitor can be sent to their
 *   dashboard rather than shown the pitch again.
 *
 * `replace` rather than a push, so that Back from the sign-in screen leaves
 * the app instead of bouncing through this redirect forever.
 */
const Landing = () => <Navigate to="/auth" replace />;

export default Landing;
