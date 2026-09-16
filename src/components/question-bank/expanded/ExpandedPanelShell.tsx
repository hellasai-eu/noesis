/**
 * Shared scaffolding for the per-type expanded panels rendered by the
 * unified question bank (#621). Each panel has a common header (title +
 * close X) and a common footer (explanation / generation rationale /
 * competencies / chapters) — only the middle section varies by type, so we
 * extract the common chrome here.
 */
import { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { X } from "lucide-react";
import { formatQuestionText } from "@/lib/latex-utils";
import type {
  ChapterReference,
  Competency,
  MaterialReference,
} from "@/lib/unified-question";
import { VoteBadges } from "@/components/QuestionMetaCells";
import { QuestionDiagram } from "@/components/QuestionDiagram";
import { useFormatters } from "@/i18n/formatters";

interface ExpandedPanelShellProps {
  titleHtml: string;
  onClose: () => void;
  isAdmin: boolean;
  explanation: string | null;
  generationRationale: string | null;
  competencies: Competency[];
  chapters: ChapterReference[];
  /** Whole-document generation sources (#1019) — rendered like chapters. */
  materials?: MaterialReference[];
  /** Name of the group the question was generated for (provenance). */
  generatedFor?: string | null;
  /** Created date — surfaced inside the panel since #623 dropped the table column. */
  createdAt?: string | null;
  /** Vote counts — surfaced inside the panel since #623 dropped the table column. */
  upvotes?: number;
  downvotes?: number;
  /** #627 — optional SVG figure rendered above the per-type children. */
  diagram?: { source: string; alt?: string } | null;
  children?: ReactNode;
}

export function ExpandedPanelShell({
  titleHtml,
  onClose,
  isAdmin,
  explanation,
  generationRationale,
  competencies,
  chapters,
  materials,
  generatedFor,
  createdAt,
  upvotes,
  downvotes,
  diagram,
  children,
}: ExpandedPanelShellProps) {
  const { formatDate } = useFormatters();
  const createdLabel = createdAt
    ? formatDate(createdAt, {
        year: "numeric",
        month: "short",
        day: "numeric",
      })
    : null;
  const showMeta =
    createdLabel != null || typeof upvotes === "number" || typeof downvotes === "number";

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-start gap-3">
        <div
          className="font-medium prose prose-sm dark:prose-invert max-w-none flex-1"
          dangerouslySetInnerHTML={{ __html: titleHtml }}
        />
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 shrink-0"
          onClick={onClose}
          aria-label="Collapse"
        >
          <X className="w-4 h-4" />
        </Button>
      </div>

      {showMeta && (
        <div
          className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground"
          data-testid="expanded-meta"
        >
          {createdLabel && (
            <span data-testid="expanded-meta-created">Created {createdLabel}</span>
          )}
          {(typeof upvotes === "number" || typeof downvotes === "number") && (
            <VoteBadges upvotes={upvotes ?? 0} downvotes={downvotes ?? 0} />
          )}
        </div>
      )}

      {diagram?.source && (
        <QuestionDiagram source={diagram.source} alt={diagram.alt ?? null} />
      )}

      {children}

      {explanation && (
        <div className="bg-background border border-border rounded-md p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">
            Explanation
          </p>
          <div
            className="text-sm prose prose-sm dark:prose-invert max-w-none"
            dangerouslySetInnerHTML={{ __html: formatQuestionText(explanation) }}
          />
        </div>
      )}

      {isAdmin && generationRationale && (
        <div
          data-testid="generation-rationale"
          className="bg-muted/50 border border-border rounded-md p-3"
        >
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">
            Why this question was generated
          </p>
          <div
            className="text-sm prose prose-sm dark:prose-invert max-w-none text-foreground/80"
            dangerouslySetInnerHTML={{ __html: formatQuestionText(generationRationale) }}
          />
        </div>
      )}

      {competencies.length > 0 && (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
            Competencies
          </p>
          <div className="flex flex-wrap gap-1">
            {competencies.map((c) => (
              <Badge key={c.id} variant="secondary" className="text-xs">
                {c.title}
              </Badge>
            ))}
          </div>
        </div>
      )}

      {chapters.length > 0 && (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
            Chapters
          </p>
          <div className="flex flex-wrap gap-1">
            {chapters.map((ch) => (
              <Badge key={ch.id} variant="outline" className="text-xs">
                {ch.materialTitle} — {ch.title}
              </Badge>
            ))}
          </div>
        </div>
      )}

      {(materials?.length ?? 0) > 0 && (
        <div data-testid="expanded-materials">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
            Documents
          </p>
          <div className="flex flex-wrap gap-1">
            {(materials ?? []).map((m) => (
              <Badge key={m.id} variant="outline" className="text-xs">
                {m.title}
              </Badge>
            ))}
          </div>
        </div>
      )}

      {generatedFor && (
        <div data-testid="expanded-generated-for">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
            Generated for
          </p>
          <Badge variant="secondary" className="text-xs">
            {generatedFor}
          </Badge>
        </div>
      )}
    </div>
  );
}
