/**
 * The contract between the application and its deployment overlay — and the
 * single module an overlay imports from.
 *
 * This repository ships no identity and no policy of its own: the landing
 * page, the legal documents, the logo and the security settings all come from
 * a directory outside `src/`, resolved through the `@deployment` alias (see
 * `vite.config.ts`). A deployment repository points `DEPLOYMENT_DIR` at its
 * own copy; an unconfigured clone gets the neutral defaults in `deployment/`.
 *
 * Everything an overlay must provide is typed here, and the `define*` helpers
 * fill in every optional field — so a deployment that only wants its own name
 * and logo writes a short `brand.config.ts` rather than a copy of the default
 * it then has to keep in step.
 *
 * The types live under `src/` rather than in the overlay so that the overlay
 * can import them, and so `tsc` checks a deployment's config against the
 * version of the app it is actually building.
 *
 * Nothing here imports a value at run time — only `ComponentType` as a type,
 * which is erased. That is deliberate: `vite.config.ts` reads the overlay's
 * `brand.meta.json` and `settings.json` with `readFileSync` before any module
 * has been loaded, and keeping the data half of the contract free of code is
 * what lets the static HTML shell, the SQL emitter and the running app share
 * one source of truth.
 */

import type { ComponentType } from "react";

/**
 * Deployment settings live in their own module — they are policy rather than
 * presentation, and `scripts/emit-settings-sql.ts` imports them without
 * wanting anything to do with logos. Re-exported here so an overlay still has
 * one import path to remember.
 */
export * from "./settings";

/**
 * Greek binds for a Greek school; English is the reference translation. The
 * *set* of languages the legal pages can offer is fixed here, because the
 * app's own chrome is English throughout and only these documents are
 * bilingual — but which of them an overlay publishes, and in what order, is
 * the overlay's choice.
 */
export type LegalLanguage = "el" | "en";

/**
 * An icon component drawn inside the brand tile. Any `lucide-react` icon
 * satisfies this, and so does a plain inline-SVG component — which matters,
 * because an overlay directory need not be able to resolve `lucide-react`.
 */
export type BrandIcon = ComponentType<{ className?: string }>;

export interface BrandLogo {
  /**
   * Anything the browser can load: a path served out of `public/`, a data URI,
   * or the default export of a Vite asset import (`import logo from
   * "./logo.svg"`). The asset import is the safer choice — it is hashed and
   * fingerprinted with the rest of the bundle, so a logo change cannot be
   * served stale.
   */
  src: string;
  /** Defaults to the brand name. Pass "" for a purely decorative wordmark. */
  alt?: string;
  /**
   * Draw the image on its own rather than inside the rounded, filled tile.
   * The right setting for a wordmark or a logo that carries its own
   * background; the wrong one for a bare glyph, which needs the tile to read
   * as a mark.
   */
  bare?: boolean;
}

/**
 * The plain-data half of the brand: everything the static HTML shell in
 * `index.html` needs, and therefore everything that must be readable without
 * running a module.
 *
 * An overlay keeps these in `brand.meta.json`. `vite.config.ts` reads that
 * file directly to fill in the document head at build time, and
 * `brand.config.ts` imports the same file — so the `<title>` a crawler sees
 * and the name the app renders cannot disagree.
 */
export interface BrandMeta {
  /** Shown in the app chrome, in page titles, and in the footer. */
  name: string;
  /** `<title>` on every route that does not set its own. */
  title: string;
  /** `<meta name="description">` and `og:description`. */
  description: string;
  /** `keywords` meta. An empty array omits the tag. */
  keywords: string[];
  /** `<link rel="canonical">` and `og:url`. `null` omits both. */
  canonicalUrl: string | null;
  /** `twitter:site`, including the `@`. `null` omits it. */
  twitterHandle: string | null;
  /**
   * An absolute URL for `og:image` / `twitter:image`. `null` omits both, and
   * the card type drops to `summary` — which is correct, because
   * `summary_large_image` reserves space for an image and renders a blank or
   * cropped placeholder when none is supplied.
   */
  ogImage: string | null;
  /** `<html lang>`, and the language the `<meta>` tags are written in. */
  htmlLang: string;
  /**
   * The footer's copyright line. `{year}` is replaced with the current year
   * and `{name}` with the brand name. `null` omits the line.
   */
  copyright: string | null;
  /**
   * Address behind the Auth page's "express interest" button, for a visitor
   * with no invitation. `null` hides the button — the right setting for a
   * deployment that only ever onboards schools out of band.
   */
  contactEmail: string | null;
  /**
   * The "Powered by …" line on an institution's own portal. `null` hides it,
   * which is what a white-label deployment wants.
   */
  poweredBy: string | null;
}

/** The brand as the app consumes it: the metadata, plus the artwork. */
export interface BrandConfig extends BrandMeta {
  /** An image logo, or `null` to draw `icon` in a tile instead. */
  logo: BrandLogo | null;
  /**
   * The glyph used when there is no image logo, or `null` to use the app's
   * own neutral fallback mark.
   */
  icon: BrandIcon | null;
}

/**
 * The shape an overlay's `brand.config.ts` may supply: every field optional,
 * because `defineBrand` fills in the rest.
 */
export type BrandConfigInput = Partial<BrandConfig>;

export interface LegalDocument {
  /** The URL segment: the document is served at `/legal/<slug>`. */
  slug: string;
  /** Nav label per language — the page heading comes from the markdown's H1. */
  label: Record<LegalLanguage, string>;
  /** `<meta name="description">` for this document's route. */
  description: Record<LegalLanguage, string>;
  /** The markdown itself, normally a `?raw` import of a `.md` file. */
  body: Record<LegalLanguage, string>;
}

export interface LegalConfig {
  /**
   * Order matters. The first entry is the language the page opens in and the
   * one the translation note treats as binding. An empty array turns the legal
   * pages off: `/legal` stops resolving and the footer drops the links.
   */
  languages: LegalLanguage[];
  /** Human label for each language's toggle button. */
  languageLabels: Record<LegalLanguage, string>;
  /**
   * Shown above a document rendered in a non-binding language. `null` for a
   * language that needs no note — the binding one never does.
   */
  translationNote: Record<LegalLanguage, string | null>;
  /** The published set, in nav order. */
  documents: LegalDocument[];
}

/**
 * The shape an overlay's `legal.config.ts` may supply.
 *
 * The two per-language maps are partial as well, because `defineLegal` merges
 * them into the defaults key by key: an overlay adding a note for one language
 * should not have to restate the other.
 */
export type LegalConfigInput = Partial<
  Omit<LegalConfig, "languageLabels" | "translationNote">
> & {
  languageLabels?: Partial<Record<LegalLanguage, string>>;
  translationNote?: Partial<Record<LegalLanguage, string | null>>;
};

/**
 * The metadata an unconfigured clone runs on.
 *
 * `vite.config.ts` imports this as its fallback when an overlay ships no
 * `brand.meta.json`, so the defaults are stated once rather than once here and
 * once in the build.
 */
export const BRAND_META_DEFAULTS: BrandMeta = {
  // Reads as a description rather than a name, which is the point: a clone
  // should look unconfigured, not like somebody else's product.
  name: "Study Platform",
  title: "Study Platform",
  description:
    "An AI study platform for schools: course material turned into practice questions and guided study, with the instructor in charge of what reaches the class.",
  keywords: [],
  canonicalUrl: null,
  twitterHandle: null,
  ogImage: null,
  htmlLang: "en",
  copyright: "© {year} {name}",
  contactEmail: null,
  poweredBy: null,
};

/**
 * Fills in an overlay's metadata.
 *
 * Shared by `defineBrand` and by `vite.config.ts`, which reads the same JSON
 * off disk for the static document head. It has to be one function: when the
 * build derived the `<title>` differently from the app, a deployment that set
 * only `name` got its own name in the chrome and this repository's default in
 * the `<title>` — which is the precise disagreement the shared file exists to
 * prevent.
 */
export function resolveBrandMeta(input: Partial<BrandMeta> = {}): BrandMeta {
  const stripped = stripUndefined(input);
  const merged = { ...BRAND_META_DEFAULTS, ...stripped };
  // A name given without a matching title is the common case, and a <title>
  // reading "Study Platform" on a deployment called something else is worse
  // than no title at all.
  if (stripped.name && stripped.title === undefined) merged.title = stripped.name;
  return merged;
}

/**
 * Normalises an overlay's brand configuration.
 *
 * Call it from `brand.config.ts` and export the result as the module default.
 * Passing the object through here rather than exporting it raw is what makes a
 * partial overlay safe: a field this app adds tomorrow gets its default today,
 * instead of arriving in the UI as `undefined`.
 */
export function defineBrand(input: BrandConfigInput = {}): BrandConfig {
  const { logo, icon, ...meta } = stripUndefined(input);
  return {
    ...resolveBrandMeta(meta),
    logo: logo ?? null,
    icon: icon ?? null,
  };
}

const LEGAL_DEFAULTS: LegalConfig = {
  languages: [],
  languageLabels: { el: "Ελληνικά", en: "English" },
  translationNote: { el: null, en: null },
  documents: [],
};

/**
 * Normalises an overlay's legal configuration.
 *
 * `languages` defaults to empty, which switches the legal pages off rather
 * than publishing documents in a language nobody declared. An overlay that
 * ships documents must say which languages they are written in.
 */
export function defineLegal(input: LegalConfigInput = {}): LegalConfig {
  const stripped = stripUndefined(input);
  return {
    ...LEGAL_DEFAULTS,
    ...stripped,
    languageLabels: { ...LEGAL_DEFAULTS.languageLabels, ...stripped.languageLabels },
    translationNote: { ...LEGAL_DEFAULTS.translationNote, ...stripped.translationNote },
  };
}

/**
 * An explicit `undefined` in an overlay's object literal — easy to produce
 * from a conditional — would otherwise win the spread and erase the default.
 */
function stripUndefined<T extends object>(input: T): T {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as T;
}
