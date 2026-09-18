import { Link } from "react-router-dom";

import { BrandMark } from "@/components/BrandMark";
import {
  LEGAL_DOCUMENTS,
  chromeLegalLanguage,
  copyrightLine,
  legalPath,
  type LegalLanguage,
} from "@/deployment";
import { cn } from "@/lib/utils";

/**
 * The one place the legal links live (issue #937).
 *
 * Both tones render the same link set, taken from the deployment overlay's
 * published document list rather than written out here — so a document the
 * overlay adds appears in the footer and in the router without a third list to
 * keep in step, and an overlay that publishes none gets a footer with no legal
 * nav rather than links to nowhere.
 *
 * `brand` is the dark band a marketing landing page pairs with. `default` is
 * the quiet bordered strip every other page gets. App.tsx renders the default
 * one globally and skips `/`, where the overlay's landing page renders its own.
 */

interface SiteFooterProps {
  tone?: "default" | "brand";
  /**
   * Which label set to show. Defaults to the app's chrome language, because
   * the app's own chrome is English throughout — only the legal documents are
   * bilingual, and the legal pages pass whichever language the reader has
   * selected.
   */
  language?: LegalLanguage;
  className?: string;
}

export const SiteFooter = ({
  tone = "default",
  language = chromeLegalLanguage,
  className,
}: SiteFooterProps) => {
  const brandTone = tone === "brand";

  const linkClass = brandTone
    ? "text-primary-foreground/70 hover:text-primary-foreground transition-colors"
    : "text-muted-foreground hover:text-foreground transition-colors";

  const copyright = copyrightLine();

  return (
    <footer
      data-testid="site-footer"
      className={cn(
        brandTone
          ? "py-12 bg-primary text-primary-foreground"
          : "border-t bg-card py-8 mt-auto",
        className,
      )}
    >
      <div className="container mx-auto px-6">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-6">
          <BrandMark
            tone={brandTone ? "gold" : "subtle"}
            // The dark band inherits `text-primary-foreground` from the
            // footer; the quiet strip needs the name coloured explicitly.
            nameClassName={brandTone ? "text-primary-foreground" : undefined}
          />

          <nav
            aria-label={language === "el" ? "Νομικές πληροφορίες" : "Legal"}
            className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm"
          >
            {/* Empty when the overlay publishes no documents. The contact link
                stays either way — `/contact` is this app's own page, not the
                overlay's. */}
            {LEGAL_DOCUMENTS.map((doc) => (
              <Link key={doc.slug} to={legalPath(doc.slug)} className={linkClass}>
                {doc.label[language]}
              </Link>
            ))}
            <Link to="/contact" className={linkClass}>
              {language === "el" ? "Επικοινωνία" : "Contact"}
            </Link>
          </nav>
        </div>

        {copyright && (
          <p
            className={cn(
              "text-sm mt-6",
              brandTone ? "text-primary-foreground/70" : "text-muted-foreground",
            )}
          >
            {copyright}
          </p>
        )}
      </div>
    </footer>
  );
};

export default SiteFooter;
