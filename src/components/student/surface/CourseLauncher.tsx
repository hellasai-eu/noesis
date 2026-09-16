import { LucideIcon } from "lucide-react";
import { SurfaceTile, type SurfaceTileBadgeTone } from "./SurfaceTile";

/**
 * One option on the course page, declared by the page and rendered dumb: the
 * page owns which tiles exist, their counts, and what opening one does.
 */
export interface LauncherTile {
  key: string;
  title: string;
  meta?: string;
  icon: LucideIcon;
  badge?: { label: string; tone?: SurfaceTileBadgeTone };
  /** Renders the tile quiet — the option exists but has nothing waiting. */
  muted?: boolean;
  onOpen: () => void;
  testId: string;
}

/**
 * The course page's body: every option as a tile in one wrapping grid.
 *
 * Options a course does not offer are left out by the page; options that are
 * merely empty render muted rather than disappearing, so the page keeps a
 * learnable shape (the same rule `Shelf` applied to its empty rows).
 */
interface CourseLauncherProps {
  courseId: string;
  tiles: LauncherTile[];
}

export function CourseLauncher({ courseId, tiles }: CourseLauncherProps) {
  return (
    <div
      className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
      data-testid="course-launcher"
    >
      {tiles.map((tile) => (
        <SurfaceTile
          key={tile.key}
          courseId={courseId}
          title={tile.title}
          meta={tile.meta}
          icon={tile.icon}
          badge={tile.badge}
          width="fill"
          tone={tile.muted ? "muted" : "plain"}
          onAction={tile.onOpen}
          testId={tile.testId}
        />
      ))}
    </div>
  );
}
