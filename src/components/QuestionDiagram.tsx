/**
 * QuestionDiagram (#627) — renders an optional SVG figure above a question
 * stem. Sanitization happens on every render via DOMPurify
 * (`sanitizeDiagram`); the source string is the raw SVG from the question
 * payload's `diagram.source` field.
 *
 * Fallback policy (#636): when `source` is missing or sanitization strips
 * everything, render the `alt` text as a plain caption so the figure's
 * meaning is still conveyed. Render nothing only when both are absent.
 */
import { useMemo } from "react";
import { sanitizeDiagram } from "@/lib/latex-utils";

interface QuestionDiagramProps {
  source?: string | null;
  alt?: string | null;
  className?: string;
}

export function QuestionDiagram({ source, alt, className }: QuestionDiagramProps) {
  const sanitized = useMemo(() => {
    if (!source) return "";
    return sanitizeDiagram(source);
  }, [source]);

  const altText = alt?.trim() ?? "";
  const hasSvg = sanitized.trim().length > 0;

  if (!hasSvg) {
    if (!altText) return null;
    return (
      <div
        role="img"
        aria-label={altText}
        data-testid="question-diagram"
        className={
          "my-3 mx-auto flex justify-center text-muted-foreground italic text-sm question-diagram-alt " +
          (className ?? "")
        }
        style={{ maxWidth: "min(100%, 480px)" }}
      >
        {altText}
      </div>
    );
  }

  return (
    <div
      role="img"
      aria-label={altText || undefined}
      aria-hidden={!altText ? true : undefined}
      data-testid="question-diagram"
      className={
        "my-3 mx-auto flex justify-center text-foreground question-diagram " +
        (className ?? "")
      }
      style={{ maxWidth: "min(100%, 480px)" }}
      dangerouslySetInnerHTML={{ __html: sanitized }}
    />
  );
}

export default QuestionDiagram;
