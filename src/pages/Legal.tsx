import { useEffect, useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { Button } from "@/components/ui/button";
import { SiteFooter } from "@/components/SiteFooter";
import {
  LEGAL_DOCUMENTS,
  brand,
  legal,
  legalDocumentBySlug,
  legalPath,
  operatorPlaceholderPattern,
  primaryLegalLanguage,
  type LegalLanguage,
} from "@/deployment";
import { cn } from "@/lib/utils";

/**
 * The public legal pages (issue #937).
 *
 * Renders the markdown the deployment overlay publishes, verbatim. The overlay's
 * `legal.config.ts` is the source of truth for what exists, in what languages
 * and in what order; this page is a viewer, not a second copy. See
 * `deployment/README.md`.
 *
 * No session is read and no data is fetched, so the pages work signed out,
 * which is the point: a school evaluating the platform must be able to read
 * them before anyone has an account.
 *
 * The first language the overlay declares is the one the page opens in and the
 * one it treats as binding — Greek, for a Greek school. Anything after it is
 * offered as a reference translation and says so.
 */

const BACK_LABEL: Record<LegalLanguage, string> = { el: "Αρχική", en: "Home" };

const NAV_LABEL: Record<LegalLanguage, string> = {
  el: "Νομικές πληροφορίες",
  en: "Legal",
};

/**
 * `[OPERATOR: …]` markers are real content in a draft — the operator's private
 * open-items register tracks each one — but dropped into running prose they
 * read like a typo. Marking them keeps the page honest about being unfinished,
 * and makes one impossible to miss on the day the drafts go final.
 */
function markPlaceholders(markdown: string): string {
  return markdown.replace(operatorPlaceholderPattern(), (_match, body: string) => {
    // Collapse the newlines the source wraps at, so a marker spanning three
    // lines does not become three inline-code fragments with hard breaks.
    const text = String(body).replace(/\s+/g, " ").trim();
    return `\`⚠ TO BE COMPLETED — ${text}\``;
  });
}

/**
 * The rendered document body.
 *
 * Exported so the two behaviours that are easy to get silently wrong — the
 * table wrapper and the placeholder marking — can be tested against input the
 * published set does not happen to contain today.
 */
export const LegalMarkdown = ({
  markdown,
  language,
}: {
  markdown: string;
  language: LegalLanguage;
}) => (
  <article
    lang={language}
    data-testid="legal-body"
    className={cn(
      "text-sm leading-relaxed text-foreground",
      "[&_h1]:text-2xl [&_h1]:font-display [&_h1]:font-bold [&_h1]:mt-8 [&_h1]:mb-4 first:[&_h1]:mt-0",
      "[&_h2]:text-lg [&_h2]:font-semibold [&_h2]:mt-8 [&_h2]:mb-3",
      "[&_h3]:text-base [&_h3]:font-semibold [&_h3]:mt-6 [&_h3]:mb-2",
      "[&_p]:mb-4",
      "[&_ul]:list-disc [&_ul]:pl-5 [&_ul]:mb-4",
      "[&_ol]:list-decimal [&_ol]:pl-5 [&_ol]:mb-4",
      "[&_li]:mb-1",
      "[&_a]:text-primary [&_a]:underline hover:[&_a]:opacity-80",
      "[&_strong]:font-semibold",
      "[&_code]:bg-muted [&_code]:rounded [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-xs",
      // The DRAFT banner is a blockquote in the source. It is the first
      // thing on every one of these pages and must read as a warning.
      "[&_blockquote]:border-l-4 [&_blockquote]:border-amber-500/60 [&_blockquote]:bg-amber-500/10",
      "[&_blockquote]:px-4 [&_blockquote]:py-3 [&_blockquote]:rounded-r [&_blockquote]:mb-6",
      "[&_blockquote_p]:mb-0 [&_blockquote_p]:text-xs",
      "[&_hr]:my-8 [&_hr]:border-border",
      // Tables are wide and the page must not scroll sideways, so each
      // one scrolls inside its own wrapper.
      "[&_table]:w-full [&_table]:border-collapse [&_table]:my-4 [&_table]:text-xs",
      "[&_th]:border [&_th]:border-border [&_th]:px-2 [&_th]:py-1 [&_th]:bg-muted [&_th]:text-start",
      "[&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_td]:align-top",
    )}
  >
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        table: ({ node: _node, ...props }) => (
          <div className="overflow-x-auto">
            <table {...props} />
          </div>
        ),
        a: ({ node: _node, href, ...props }) => {
          const external =
            href?.startsWith("http://") ||
            href?.startsWith("https://") ||
            href?.startsWith("//");
          return external ? (
            <a {...props} href={href} target="_blank" rel="noopener noreferrer" />
          ) : (
            <a {...props} href={href} />
          );
        },
      }}
    >
      {markPlaceholders(markdown)}
    </ReactMarkdown>
  </article>
);

export const Legal = () => {
  const { slug } = useParams<{ slug: string }>();
  // `primaryLegalLanguage` is null only when the overlay publishes nothing, in
  // which case App.tsx does not register this route at all.
  const [language, setLanguage] = useState<LegalLanguage>(
    primaryLegalLanguage ?? "en",
  );

  const doc = slug ? legalDocumentBySlug(slug) : undefined;

  useEffect(() => {
    if (!doc) return;

    // The pages must be indexable, and a single-page app has one static title
    // and description unless a page sets its own.
    const previousTitle = document.title;
    document.title = `${doc.label[language]} · ${brand.name}`;

    let meta = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    const created = !meta;
    if (!meta) {
      meta = document.createElement("meta");
      meta.name = "description";
      document.head.appendChild(meta);
    }
    const previousDescription = meta.content;
    meta.content = doc.description[language];

    return () => {
      document.title = previousTitle;
      if (created) meta?.remove();
      else if (meta) meta.content = previousDescription;
    };
  }, [doc, language]);

  if (!doc) {
    // `/legal` with no slug, or a slug the overlay does not publish. The first
    // document is the entry point rather than a 404, so a stale link to a
    // renamed document still lands somewhere useful.
    return <Navigate to={legalPath(LEGAL_DOCUMENTS[0].slug)} replace />;
  }

  // A note only on the languages that are not the binding one.
  const translationNote =
    language === primaryLegalLanguage ? null : legal.translationNote[language];

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <nav className="border-b bg-card sticky top-0 z-40">
        <div className="container mx-auto px-6 py-3 flex flex-wrap items-center gap-3">
          <Button variant="ghost" size="sm" asChild>
            <Link to="/">
              <ArrowLeft className="w-4 h-4 mr-2" />
              {BACK_LABEL[language]}
            </Link>
          </Button>

          <nav
            aria-label={NAV_LABEL[language]}
            className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm"
          >
            {LEGAL_DOCUMENTS.map((other) => (
              <Link
                key={other.slug}
                to={legalPath(other.slug)}
                aria-current={other.slug === doc.slug ? "page" : undefined}
                className={cn(
                  "transition-colors",
                  other.slug === doc.slug
                    ? "text-foreground font-medium"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {other.label[language]}
              </Link>
            ))}
          </nav>

          {/* A single-language overlay gets no toggle rather than one button
              that does nothing. */}
          {legal.languages.length > 1 && (
            <div className="ms-auto flex items-center gap-1" role="group" aria-label="Language">
              {legal.languages.map((code) => (
                <Button
                  key={code}
                  variant={language === code ? "secondary" : "ghost"}
                  size="sm"
                  aria-pressed={language === code}
                  onClick={() => setLanguage(code)}
                >
                  {legal.languageLabels[code]}
                </Button>
              ))}
            </div>
          )}
        </div>
      </nav>

      <main className="flex-1 container mx-auto px-6 py-10 max-w-3xl w-full">
        {translationNote && (
          <p className="mb-6 text-xs text-muted-foreground">{translationNote}</p>
        )}

        <LegalMarkdown markdown={doc.body[language]} language={language} />
      </main>

      <SiteFooter language={language} />
    </div>
  );
};

export default Legal;
