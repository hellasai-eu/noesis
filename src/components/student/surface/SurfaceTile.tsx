import { ReactNode } from "react";
import { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { subjectColor } from "@/lib/subject-colors";

/**
 * The one tile shape the student surface uses — on shelves, in the course
 * launcher, and in the course page's quiz and guide lists.
 *
 * Successor to `ActivityRow`, and it keeps that component's hard rule: an
 * assignment the student cannot act on renders inert. `ActivityRow` expressed
 * that as `disabled`; here it is `tone="locked"`, which drops the button, the
 * click handler and the hover treatment together, so a closed or past-due quiz
 * cannot be opened by clicking the card body.
 *
 * At most one tile in a group may be `hero` — a promoted recommendation.
 * Everything else is `plain` (act on it) or `muted` (nothing to do right now,
 * still browsable).
 */
export type SurfaceTileTone = "hero" | "plain" | "muted" | "locked";
export type SurfaceTileBadgeTone = "urgent" | "warning" | "success" | "neutral";

const BADGE_TONE: Record<SurfaceTileBadgeTone, string> = {
  urgent: "bg-destructive/15 text-destructive",
  warning: "bg-amber-500/20 text-amber-700 dark:text-amber-300",
  success: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  neutral: "bg-muted text-muted-foreground",
};

export interface SurfaceTileProps {
  /** Drives the hue. Omit on a tile that belongs to no single course. */
  courseId?: string | null;
  /** Small caps line above the title — usually the course name. */
  kicker?: string;
  title: ReactNode;
  /** One line under the title: counts, progress, a deadline. */
  meta?: ReactNode;
  badge?: { label: string; tone?: SurfaceTileBadgeTone };
  icon?: LucideIcon;
  /** Renders a progress bar in the course hue. */
  progress?: { value: number; max: number };
  actionLabel?: string;
  onAction?: () => void;
  /** Optional second, outlined button beside the primary one. */
  secondaryActionLabel?: string;
  onSecondaryAction?: () => void;
  tone?: SurfaceTileTone;
  /** `wide` for tiles that carry a deadline and a button, `narrow` for counts,
      `fill` for tiles laid out by a wrapping grid rather than a shelf strip. */
  width?: "wide" | "narrow" | "fill";
  testId?: string;
}

export function SurfaceTile({
  courseId,
  kicker,
  title,
  meta,
  badge,
  icon: Icon,
  progress,
  actionLabel,
  onAction,
  secondaryActionLabel,
  onSecondaryAction,
  tone = "plain",
  width = "narrow",
  testId,
}: SurfaceTileProps) {
  const color = subjectColor(courseId);
  const isHero = tone === "hero";
  const isLocked = tone === "locked";
  const interactive = !isLocked && !!onAction;

  const handleAction = () => {
    if (interactive) onAction?.();
  };

  return (
    <div
      className={cn(
        "flex flex-col rounded-2xl border p-4 transition-shadow",
        // Fixed sizes on shelves: a shelf is a row of comparable things, and
        // tiles that resize to their content stop being comparable at a
        // glance. `fill` hands the sizing to the wrapping grid instead.
        width === "wide"
          ? "min-h-[152px] w-[300px] flex-shrink-0"
          : width === "fill"
            ? "min-h-[132px] w-full"
            : "min-h-[116px] w-[212px] flex-shrink-0",
        isLocked
          ? "border-dashed border-border bg-muted/40"
          : "border-border bg-card shadow-sm",
        tone === "muted" && "opacity-60",
        interactive && "cursor-pointer hover:shadow-md",
      )}
      style={
        isHero
          ? { background: color.hero, borderColor: color.hero, color: color.heroInk }
          : undefined
      }
      onClick={interactive ? handleAction : undefined}
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-disabled={isLocked || undefined}
      onKeyDown={
        interactive
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                handleAction();
              }
            }
          : undefined
      }
      data-testid={testId}
      data-tone={tone}
      data-subject={color.index}
    >
      <div className="flex items-start justify-between gap-2">
        {Icon && !kicker ? (
          <span
            className="flex h-8 w-8 items-center justify-center rounded-lg"
            style={{ background: isHero ? "transparent" : color.tint }}
          >
            <Icon
              className="h-4 w-4"
              style={{ color: isHero ? color.heroInk : color.ink }}
              aria-hidden="true"
            />
          </span>
        ) : (
          <span
            className="truncate text-[10.5px] font-bold uppercase tracking-[0.07em]"
            style={{ color: isHero ? color.heroInk : color.ink, opacity: isHero ? 0.85 : 1 }}
          >
            {kicker}
          </span>
        )}
        {badge && (
          <span
            className={cn(
              "flex-shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-bold",
              !isHero && BADGE_TONE[badge.tone ?? "neutral"],
            )}
            style={isHero ? { background: "rgba(255,255,255,0.22)", color: color.heroInk } : undefined}
          >
            {badge.label}
          </span>
        )}
      </div>

      <h3
        className={cn(
          "mt-2.5 font-semibold leading-snug",
          width === "wide" ? "text-base" : "text-sm",
          isLocked && "text-muted-foreground",
        )}
      >
        {title}
      </h3>

      {meta && (
        <p
          className={cn("mt-1 text-xs", !isHero && "text-muted-foreground")}
          style={isHero ? { color: color.heroInk, opacity: 0.85 } : undefined}
        >
          {meta}
        </p>
      )}

      {progress && progress.max > 0 && (
        <div className="mt-3 flex items-center gap-2">
          <div className="h-1.5 flex-1 rounded-full bg-muted">
            <div
              className="h-1.5 rounded-full"
              style={{
                width: `${Math.min(100, Math.round((progress.value / progress.max) * 100))}%`,
                background: isHero ? color.heroInk : color.solid,
              }}
            />
          </div>
          <span
            className={cn("text-xs tabular-nums", !isHero && "text-muted-foreground")}
            style={isHero ? { color: color.heroInk } : undefined}
          >
            {progress.value}/{progress.max}
          </span>
        </div>
      )}

      {(actionLabel || (secondaryActionLabel && onSecondaryAction)) && !isLocked && (
        // `mt-auto` keeps the buttons on the tile's floor, so a shelf of
        // tiles with different amounts of meta still has one button line.
        <div className="mt-auto flex flex-wrap items-center gap-2">
          {actionLabel && (
            <button
              type="button"
              className={cn(
                "inline-flex h-8 w-fit items-center rounded-full px-3.5 pt-0.5 text-xs font-semibold",
                "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2",
                !isHero && "bg-secondary text-secondary-foreground hover:bg-secondary/80",
              )}
              style={isHero ? { background: color.heroInk, color: color.hero } : undefined}
              onClick={(e) => {
                // The whole tile is clickable; don't let the click count twice.
                e.stopPropagation();
                handleAction();
              }}
            >
              {actionLabel}
            </button>
          )}
          {secondaryActionLabel && onSecondaryAction && (
            <button
              type="button"
              className={cn(
                "inline-flex h-8 w-fit items-center rounded-full border px-3.5 pt-0.5 text-xs font-semibold",
                "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2",
                !isHero && "border-border text-foreground hover:bg-muted",
              )}
              style={isHero ? { borderColor: color.heroInk, color: color.heroInk } : undefined}
              onClick={(e) => {
                e.stopPropagation();
                onSecondaryAction();
              }}
            >
              {secondaryActionLabel}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
