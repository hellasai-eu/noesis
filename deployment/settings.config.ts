/**
 * The default deployment policy: which roles must enrol in two-factor
 * authentication, and from when.
 *
 * It reproduces exactly what this codebase enforced before the policy became
 * configurable — platform staff immediately, institution admins from
 * 2026-11-01 — so adopting the configurable version is not also a policy
 * change.
 *
 * ## Changing it takes two steps, not one
 *
 * Editing `settings.json` changes what the *app* believes. It does not change
 * what the *database* enforces, and the database is where enforcement lives
 * (see `src/deployment/settings.ts` for why a bundle-only setting would be
 * worthless). So:
 *
 *     npm run settings:sql            # the UPDATE to apply
 *     npm run settings:sql -- --check # fail if the file and the DB disagree
 *
 * The deployment repository applies the statement against its Supabase
 * project. Skip that step and the app will nudge a role the database does not
 * gate — or, worse, stay quiet about one it does. `--check` in the deploy
 * pipeline is what keeps that from shipping.
 *
 * The data lives in `settings.json` rather than in this file because
 * `scripts/emit-settings-sql.ts` and `vite.config.ts` read it with
 * `readFileSync`, before any module has run.
 */

import { defineSettings } from "@/deployment/contract";

import settings from "./settings.json";

export default defineSettings(settings);
