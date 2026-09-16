import { ReactNode, useRef } from "react";
import { LucideIcon, ChevronLeft, ChevronRight } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * One horizontal row of the student surface: a heading, and a strip of tiles
 * that scrolls sideways.
 *
 * Sideways scrolling is the one real cost of this layout — a shelf's tail is
 * out of sight — so three things here are deliberate rather than decorative:
 * the strip is padded so the next tile always peeks past the edge, the arrows
 * appear whenever the row overflows (not only on hover, which is invisible on
 * touch), and the row is a labelled region so a screen reader reaches it as a
 * named group rather than a wall of cards.
 *
 * A shelf with nothing in it renders its empty line rather than disappearing:
 * "no cards due" is information, and a surface whose rows come and go is one
 * a student cannot learn the shape of.
 */
interface ShelfProps {
  title: string;
  icon: LucideIcon;
  /** Course hue when the shelf belongs to one course, else the shelf's own. */
  accent?: { ink: string; tint: string };
  count?: ReactNode;
  badge?: { label: string } | null;
  action?: ReactNode;
  loading?: boolean;
  /** Shown in place of the strip when there is nothing to list. */
  empty?: ReactNode;
  children?: ReactNode;
  testId?: string;
}

const SCROLL_STEP = 324;

export function Shelf({
  title,
  icon: Icon,
  accent,
  count,
  badge,
  action,
  loading = false,
  empty,
  children,
  testId,
}: ShelfProps) {
  const stripRef = useRef<HTMLDivElement>(null);
  const hasItems = Array.isArray(children) ? children.flat().some(Boolean) : !!children;

  const scrollBy = (direction: -1 | 1) => {
    stripRef.current?.scrollBy({ left: direction * SCROLL_STEP, behavior: "smooth" });
  };

  return (
    <section className="mb-7" aria-label={title} data-testid={testId}>
      <div className="mb-3 flex items-center gap-2.5">
        <span
          className="flex h-7 w-7 items-center justify-center rounded-lg"
          style={{ background: accent?.tint ?? "hsl(var(--muted))" }}
        >
          <Icon
            className="h-4 w-4"
            style={{ color: accent?.ink ?? "hsl(var(--muted-foreground))" }}
            aria-hidden="true"
          />
        </span>
        <h2 className="text-base font-bold tracking-tight">{title}</h2>
        {count !== undefined && count !== null && (
          <span className="text-sm text-muted-foreground tabular-nums">{count}</span>
        )}
        {badge && (
          <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-[10.5px] font-bold text-amber-700 dark:text-amber-300">
            {badge.label}
          </span>
        )}
        <div className="flex-1" />
        {hasItems && !loading && (
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label={`${title} — scroll left`}
              className="hidden h-7 w-7 items-center justify-center rounded-full border border-border text-muted-foreground hover:bg-muted sm:flex"
              onClick={() => scrollBy(-1)}
            >
              <ChevronLeft className="h-4 w-4" aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label={`${title} — scroll right`}
              className="hidden h-7 w-7 items-center justify-center rounded-full border border-border text-muted-foreground hover:bg-muted sm:flex"
              onClick={() => scrollBy(1)}
            >
              <ChevronRight className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        )}
        {action}
      </div>

      {loading ? (
        <div className="flex gap-3">
          <Skeleton className="h-[116px] w-[212px] rounded-2xl" />
          <Skeleton className="h-[116px] w-[212px] rounded-2xl" />
          <Skeleton className="h-[116px] w-[212px] rounded-2xl" />
        </div>
      ) : hasItems ? (
        <div
          ref={stripRef}
          className={cn(
            "flex gap-3 overflow-x-auto pb-2",
            // Hide the bar but keep the scrolling: the arrows and the peeking
            // tile carry the affordance, and a permanent bar under every row
            // makes the page look like a spreadsheet.
            "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
          )}
        >
          {children}
        </div>
      ) : (
        <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
          {empty}
        </p>
      )}
    </section>
  );
}
