/**
 * The resolved deployment overlay — the single place the app reads its identity
 * from.
 *
 * Nothing under `src/` may hardcode a product name, a logo, a legal document,
 * a landing page or a security policy. It all arrives through the `@deployment`
 * alias, which points at `deployment/` in this repository unless
 * `DEPLOYMENT_DIR` says otherwise. See `deployment/README.md` for the overlay
 * contract and `src/deployment/contract.ts` for the types.
 *
 * The overlay is resolved at build time, not fetched at run time: the values
 * below are ordinary module constants, so a page needs no loading state and no
 * session to render its own chrome.
 */

import brandConfig from "@deployment/brand.config";
import legalConfig from "@deployment/legal.config";
import settingsConfig from "@deployment/settings.config";

import type { LegalDocument, LegalLanguage } from "./contract";
import { mfaPolicyRow, type MfaRole } from "./settings";

export type {
  BrandConfig,
  BrandIcon,
  BrandLogo,
  BrandMeta,
  DeploymentSettings,
  LegalConfig,
  LegalDocument,
  LegalLanguage,
  MfaPolicyRow,
  MfaRole,
  MfaSettings,
} from "./contract";
export { MFA_ROLES } from "./settings";

/**
 * The `define*` helpers are deliberately *not* re-exported here.
 *
 * An overlay imports them from `@/deployment/contract` directly. Re-exporting
 * them from this module would offer a second, circular route: this module
 * imports the overlay's configs, so an overlay importing `defineBrand` from
 * here would close the loop.
 */

/** Name, logo, contact address and metadata. Always defined. */
export const brand = brandConfig;

/**
 * Deployment policy — today, the MFA mandate.
 *
 * **Not an authorisation source.** Enforcement is in Postgres (see
 * `src/deployment/settings.ts`), and the frontend asks
 * `mfa_enrollment_status()` which gate to show. Read this for copy, for the
 * super-admin drift panel, and for nothing that decides access.
 */
export const settings = settingsConfig;

/** The declared MFA policy in the shape the database stores it. */
export const declaredMfaPolicy = mfaPolicyRow(settingsConfig);

/**
 * Whether the declared policy names a role at all — used only to decide
 * whether it is worth showing the operator a policy panel.
 */
export const mfaEnforcedRoles: MfaRole[] = settingsConfig.mfa.enforceForRoles;

/** Published legal documents and the languages they come in. */
export const legal = legalConfig;

/**
 * The documents to link and route, in nav order.
 *
 * Empty when the overlay publishes none — which every consumer has to handle
 * rather than assume away, because the unconfigured default *is* empty of real
 * text and a deployment may deliberately serve its legal pages elsewhere.
 */
export const LEGAL_DOCUMENTS: LegalDocument[] = legal.languages.length
  ? legal.documents
  : [];

/** `true` when there is anything to show at `/legal`. */
export const hasLegalDocuments = LEGAL_DOCUMENTS.length > 0;

/** The route path for a document, so the footer and the router cannot drift. */
export const legalPath = (slug: string) => `/legal/${slug}`;

export const legalDocumentBySlug = (slug: string): LegalDocument | undefined =>
  LEGAL_DOCUMENTS.find((doc) => doc.slug === slug);

/**
 * The language a legal page opens in, and the one its translation note calls
 * binding. `null` when no documents are published.
 */
export const primaryLegalLanguage: LegalLanguage | null =
  legal.languages[0] ?? null;

/**
 * The language the app's own chrome uses for the few strings that are
 * language-dependent outside the legal pages — the footer's nav label, mainly.
 * English unless the overlay publishes nothing but Greek.
 */
export const chromeLegalLanguage: LegalLanguage = legal.languages.includes("en")
  ? "en"
  : (primaryLegalLanguage ?? "en");

/**
 * The footer's copyright line with its placeholders filled, or `null` when the
 * overlay asked for no line.
 *
 * Computed per call rather than once at module load: a tab left open across
 * New Year would otherwise show last year's notice.
 */
export const copyrightLine = (): string | null =>
  brand.copyright
    ?.replace("{year}", String(new Date().getFullYear()))
    .replace("{name}", brand.name) ?? null;

/**
 * Placeholders a draft legal document leaves for the operator: legal entity,
 * privacy contact, DPO decision, hosting region, vendor DPA status.
 *
 * They are real content, not a rendering bug — the document is unfinished and
 * the operator's own open-items register tracks each one. But `[OPERATOR: …]`
 * dropped into running prose reads like a typo, so `Legal.tsx` marks each one
 * visibly instead, which is also what makes one impossible to miss on the day
 * the drafts go final.
 *
 * The optional backticks matter. Most markers are already written as inline
 * code in the source, so a pattern matching only the brackets leaves the
 * original pair in place and the replacement adds a second — which happens to
 * render correctly, because CommonMark reads the doubled pair as one delimiter
 * run of length two. Correct by coincidence is not correct: a marker whose
 * text ever contained a backtick would break it. Consuming the delimiters
 * means the replacement owns exactly one pair either way.
 *
 * Built fresh per call rather than shared: a `/g` regex carries `lastIndex`,
 * and a module-level one is a state bug waiting for its second caller.
 */
export const operatorPlaceholderPattern = () => /`?\[OPERATOR:\s*([^\]]+)\]`?/g;
