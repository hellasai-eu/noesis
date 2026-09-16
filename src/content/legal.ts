/**
 * The published legal documents (issue #937).
 *
 * The markdown is imported straight out of `docs/compliance/legal/`, which is
 * where #938 keeps the authoritative text. It is deliberately NOT copied into
 * `src/`: two copies of a privacy policy is two documents, and the day they
 * disagree the published one is wrong while the reviewed one looks fine.
 *
 * Vite inlines these at build time, so the pages are static and need no
 * network request and no session to render.
 */

import privacyEl from "../../docs/compliance/legal/privacy-policy.el.md?raw";
import privacyEn from "../../docs/compliance/legal/privacy-policy.en.md?raw";
import termsEl from "../../docs/compliance/legal/terms-of-service.el.md?raw";
import termsEn from "../../docs/compliance/legal/terms-of-service.en.md?raw";
import aiEl from "../../docs/compliance/legal/ai-usage-notice.el.md?raw";
import aiEn from "../../docs/compliance/legal/ai-usage-notice.en.md?raw";
import subEl from "../../docs/compliance/legal/subprocessors.el.md?raw";
import subEn from "../../docs/compliance/legal/subprocessors.en.md?raw";

/** Greek binds for a Greek school; English is the reference translation. */
export type LegalLanguage = "el" | "en";

export type LegalSlug = "privacy" | "terms" | "ai" | "subprocessors";

export interface LegalDocument {
  slug: LegalSlug;
  /** The route path, so the footer and the router cannot drift apart. */
  path: string;
  /** Nav label per language — the page title comes from the markdown's own H1. */
  label: Record<LegalLanguage, string>;
  /** For <meta name="description">. */
  description: Record<LegalLanguage, string>;
  body: Record<LegalLanguage, string>;
}

export const LEGAL_DOCUMENTS: LegalDocument[] = [
  {
    slug: "privacy",
    path: "/legal/privacy",
    label: { el: "Απόρρητο", en: "Privacy" },
    description: {
      el: "Ποια προσωπικά δεδομένα τηρεί το Noesis, γιατί, πού πηγαίνουν και τι δικαιώματα έχετε.",
      en: "What personal data Noesis holds, why, where it goes, and what rights you have.",
    },
    body: { el: privacyEl, en: privacyEn },
  },
  {
    slug: "terms",
    path: "/legal/terms",
    label: { el: "Όροι Χρήσης", en: "Terms" },
    description: {
      el: "Οι όροι υπό τους οποίους χρησιμοποιείτε την πλατφόρμα Noesis.",
      en: "The terms on which you use the Noesis platform.",
    },
    body: { el: termsEl, en: termsEn },
  },
  {
    slug: "ai",
    path: "/legal/ai",
    label: { el: "Τεχνητή Νοημοσύνη", en: "AI" },
    description: {
      el: "Τι κάνει η τεχνητή νοημοσύνη στο Noesis, σε τι δεν είναι καλή, και τι γίνεται με όσα γράφετε.",
      en: "What the AI in Noesis does, what it is not good at, and what happens to what you write.",
    },
    body: { el: aiEl, en: aiEn },
  },
  {
    slug: "subprocessors",
    path: "/legal/subprocessors",
    label: { el: "Υπεργολάβοι", en: "Subprocessors" },
    description: {
      el: "Οι πάροχοι που επεξεργάζονται δεδομένα για λογαριασμό μας, και τι λαμβάνει ο καθένας.",
      en: "The providers that process data on our behalf, and what each one receives.",
    },
    body: { el: subEl, en: subEn },
  },
];

export const legalDocumentBySlug = (slug: string): LegalDocument | undefined =>
  LEGAL_DOCUMENTS.find((doc) => doc.slug === slug);

/**
 * Placeholders the compliance set leaves for the operator: legal entity,
 * privacy contact, DPO decision, hosting region, vendor DPA status.
 *
 * They are real content, not a rendering bug — the documents are drafts and the
 * operator's private open-items register tracks each one (see
 * `docs/compliance/README.md`; the register itself is not in this repository).
 * But `[OPERATOR: …]` dropped into running prose reads like a typo, so the page
 * marks them instead, which is also what makes one impossible to miss on the
 * day the drafts go final.
 *
 * The optional backticks matter. Most markers are already written as inline
 * code in the source, so a pattern matching only the brackets leaves the
 * original pair in place and the replacement adds a second — which happens to
 * render correctly, because CommonMark reads the doubled pair as one delimiter
 * run of length two. Correct by coincidence is not correct: a marker whose text
 * ever contained a backtick would break it. Consuming the delimiters means the
 * replacement owns exactly one pair either way.
 *
 * Built fresh per call rather than shared: a `/g` regex carries `lastIndex`,
 * and a module-level one is a state bug waiting for its second caller.
 */
export const operatorPlaceholderPattern = () => /`?\[OPERATOR:\s*([^\]]+)\]`?/g;
