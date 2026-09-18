/**
 * The default published legal set — four skeletons, no operative text.
 *
 * This repository holds no real legal documents. What is here documents the
 * expected shape and keeps `/legal` rendering something harmless in a clone;
 * every file carries a DRAFT banner saying so, and leaves each substantive
 * statement as an explicit `[OPERATOR: …]` marker that the app renders as a
 * visible **⚠ TO BE COMPLETED** badge.
 *
 * A deployment replaces this file along with the rest of the overlay. Its own
 * documents are the ones its users read, so:
 *
 * - **Removing a document from this list unpublishes it.** `/legal/<slug>`
 *   stops resolving and the footer drops the link. There is no second list to
 *   keep in step — the router and the footer both read this one.
 * - **Editing a markdown file ships new legal text** on the next build. Treat
 *   a change as a publication, not a docs tidy-up.
 * - **Set `languages: []`** to turn the legal pages off entirely, for a
 *   deployment that serves its policies from somewhere else.
 */

import { defineLegal } from "@/deployment/contract";

import privacyEl from "./legal/privacy-policy.el.md?raw";
import privacyEn from "./legal/privacy-policy.en.md?raw";
import termsEl from "./legal/terms-of-service.el.md?raw";
import termsEn from "./legal/terms-of-service.en.md?raw";
import aiEl from "./legal/ai-usage-notice.el.md?raw";
import aiEn from "./legal/ai-usage-notice.en.md?raw";
import subEl from "./legal/subprocessors.el.md?raw";
import subEn from "./legal/subprocessors.en.md?raw";

export default defineLegal({
  // Greek first: it is the binding text for a Greek school, so it is what the
  // page opens in. English is offered as a reference translation.
  languages: ["el", "en"],

  translationNote: {
    el: null,
    en: "Reference translation. The Greek version is the binding text.",
  },

  documents: [
    {
      slug: "privacy",
      label: { el: "Απόρρητο", en: "Privacy" },
      description: {
        el: "Ποια προσωπικά δεδομένα τηρεί η πλατφόρμα, γιατί, πού πηγαίνουν και τι δικαιώματα έχετε.",
        en: "What personal data the platform holds, why, where it goes, and what rights you have.",
      },
      body: { el: privacyEl, en: privacyEn },
    },
    {
      slug: "terms",
      label: { el: "Όροι Χρήσης", en: "Terms" },
      description: {
        el: "Οι όροι υπό τους οποίους χρησιμοποιείτε την πλατφόρμα.",
        en: "The terms on which you use the platform.",
      },
      body: { el: termsEl, en: termsEn },
    },
    {
      slug: "ai",
      label: { el: "Τεχνητή Νοημοσύνη", en: "AI" },
      description: {
        el: "Τι κάνει η τεχνητή νοημοσύνη εδώ, σε τι δεν είναι καλή, και τι γίνεται με όσα γράφετε.",
        en: "What the AI does here, what it is not good at, and what happens to what you write.",
      },
      body: { el: aiEl, en: aiEn },
    },
    {
      slug: "subprocessors",
      label: { el: "Υπεργολάβοι", en: "Subprocessors" },
      description: {
        el: "Οι πάροχοι που επεξεργάζονται δεδομένα για λογαριασμό μας, και τι λαμβάνει ο καθένας.",
        en: "The providers that process data on our behalf, and what each one receives.",
      },
      body: { el: subEl, en: subEn },
    },
  ],
});
