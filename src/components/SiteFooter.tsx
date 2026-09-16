import { BookOpen } from "lucide-react";
import { Link } from "react-router-dom";

import { LEGAL_DOCUMENTS, type LegalLanguage } from "@/content/legal";
import { cn } from "@/lib/utils";

/**
 * The one place the legal links live (issue #937).
 *
 * Both tones render the same link set, taken from `LEGAL_DOCUMENTS` rather than
 * written out here — so a document added to the compliance set appears in the
 * footer and in the router without a third list to keep in step.
 *
 * `brand` is the landing page's existing dark band, kept as it was. `default`
 * is the quiet bordered strip every other page gets. App.tsx renders the
 * default one globally and skips `/`, where the landing page renders its own.
 */

interface SiteFooterProps {
  tone?: "default" | "brand";
  /**
   * Which label set to show. Defaults to English because the app's own chrome
   * is English throughout — only the legal documents are bilingual, and the
   * legal pages pass whichever language the reader has selected.
   */
  language?: LegalLanguage;
  className?: string;
}

export const SiteFooter = ({
  tone = "default",
  language = "en",
  className,
}: SiteFooterProps) => {
  const brand = tone === "brand";

  const linkClass = brand
    ? "text-primary-foreground/70 hover:text-primary-foreground transition-colors"
    : "text-muted-foreground hover:text-foreground transition-colors";

  return (
    <footer
      data-testid="site-footer"
      className={cn(
        brand ? "py-12 bg-primary text-primary-foreground" : "border-t bg-card py-8 mt-auto",
        className,
      )}
    >
      <div className="container mx-auto px-6">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-6">
          <div className="flex items-center gap-3">
            <div
              className={cn(
                "w-10 h-10 rounded-lg flex items-center justify-center",
                brand ? "bg-gold" : "bg-primary/10",
              )}
            >
              <BookOpen className={cn("w-6 h-6", brand ? "text-foreground" : "text-primary")} />
            </div>
            <span className={cn("text-xl font-display font-bold", !brand && "text-foreground")}>
              Noesis
            </span>
          </div>

          <nav
            aria-label={language === "el" ? "Νομικές πληροφορίες" : "Legal"}
            className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm"
          >
            {LEGAL_DOCUMENTS.map((doc) => (
              <Link key={doc.slug} to={doc.path} className={linkClass}>
                {doc.label[language]}
              </Link>
            ))}
            <Link to="/contact" className={linkClass}>
              {language === "el" ? "Επικοινωνία" : "Contact"}
            </Link>
          </nav>
        </div>

        <p
          className={cn(
            "text-sm mt-6",
            brand ? "text-primary-foreground/70" : "text-muted-foreground",
          )}
        >
          © {new Date().getFullYear()} Noesis. Empowering education through technology.
        </p>
      </div>
    </footer>
  );
};

export default SiteFooter;
