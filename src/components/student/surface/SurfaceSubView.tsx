import { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The frame a shelf tile opens into.
 *
 * Every activity the course surface launches used to bring its own sticky nav
 * bar and its own gradient background, so opening a tile changed the page's
 * chrome as well as its content. Here the chrome is `SurfaceShell` — the same
 * bar as the surface behind it — and this component supplies only what the
 * sub-view genuinely adds: a way back, and the name of what you are in.
 *
 * The back control is a real button rather than a browser-history nudge,
 * because these views are state on one route, not routes of their own.
 */
interface SurfaceSubViewProps {
  title: string;
  backLabel: string;
  onBack?: () => void;
  /** Reading widths, matching what each sub-view was already tuned for. */
  width?: "narrow" | "wide" | "full";
  children: ReactNode;
}

const WIDTH_CLASS = {
  narrow: "max-w-3xl",
  wide: "max-w-4xl",
  full: "",
} as const;

export function SurfaceSubView({
  title,
  backLabel,
  onBack,
  width = "wide",
  children,
}: SurfaceSubViewProps) {
  return (
    <div className={cn("mx-auto w-full", WIDTH_CLASS[width])}>
      <div className="mb-5 flex items-center gap-3">
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            aria-label={backLabel}
            className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full border border-border text-muted-foreground transition-colors hover:bg-muted"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
        <h1 className="truncate font-display text-xl font-bold text-foreground sm:text-2xl">
          {title}
        </h1>
      </div>
      {children}
    </div>
  );
}
