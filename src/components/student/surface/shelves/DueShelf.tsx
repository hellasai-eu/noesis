import { ReactNode } from "react";
import { LucideIcon } from "lucide-react";
import { subjectColorByIndex } from "@/lib/subject-colors";
import type { DueItem } from "@/lib/student-surface";
import { Shelf } from "../Shelf";
import { DueTile } from "../DueTile";

/**
 * A shelf of assigned, deadline-bearing work — the dashboard renders one for
 * quizzes and one for study guides, each already filtered to what it names.
 *
 * Order is the loader's: `loadDueItems` sorts nearest-deadline-first, so the
 * first tile is the thing to do next. Completed items, when a caller includes
 * them, keep their loader position and render muted; work the student can no
 * longer act on renders locked (see `DueTile`).
 */
interface DueShelfProps {
  items: DueItem[];
  loading: boolean;
  title: string;
  icon: LucideIcon;
  empty: string;
  testId: string;
  /** Slot in the surface's accent rotation, so sibling shelves differ. */
  accentIndex?: number;
  /** Trailing control in the heading row. */
  action?: ReactNode;
  onOpen: (item: DueItem) => void;
}

export function DueShelf({
  items,
  loading,
  title,
  icon,
  empty,
  testId,
  accentIndex = 1,
  action,
  onOpen,
}: DueShelfProps) {
  const accent = subjectColorByIndex(accentIndex);
  const open = items.filter((i) => i.status !== "completed").length;

  return (
    <Shelf
      title={title}
      icon={icon}
      accent={accent}
      count={open > 0 ? open : undefined}
      action={action}
      loading={loading}
      empty={empty}
      testId={testId}
    >
      {items.map((item) => (
        <DueTile key={`${item.kind}:${item.id}`} item={item} onOpen={onOpen} />
      ))}
    </Shelf>
  );
}
