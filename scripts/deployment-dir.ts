import path from "path";
import { loadEnv } from "vite";

/**
 * Resolves where the deployment overlay lives — the landing page, the legal
 * documents and the logo.
 *
 * Nothing under `src/` carries a product identity: a deployment points
 * `DEPLOYMENT_DIR` at its own directory, and an unconfigured clone falls back to
 * `deployment/`. See `deployment/README.md`.
 *
 * Shared by `vite.config.ts` and `vitest.config.ts` rather than written twice,
 * so the tests resolve the same overlay the build does. A suite that ran
 * against this repository's defaults while the bundle shipped a deployment's
 * own would assert nothing anybody deploys.
 *
 * The returned path must sit inside the checkout. The overlay's files import
 * `react` and `@/deployment/contract`, and a bare specifier resolves from the
 * importing file's own location — so a directory outside the project (or a
 * symlink to one, which Vite resolves to its real path) cannot find
 * `node_modules`.
 */
export function resolveDeploymentDir(root: string, mode: string): string {
  // Vite loads `.env` *after* the config is evaluated, so a `DEPLOYMENT_DIR`
  // written there is invisible to `process.env` at this point. Load it
  // explicitly, with an empty prefix because the name is deliberately not
  // `VITE_`-prefixed — it is a build input, not a value for the bundle.
  const env = loadEnv(mode, root, "");

  // A real shell variable wins: that is the one a CI step sets, and it should
  // not be silently overridden by a checked-in `.env`.
  const dir = process.env.DEPLOYMENT_DIR || env.DEPLOYMENT_DIR || "./deployment";

  return path.resolve(root, dir);
}
