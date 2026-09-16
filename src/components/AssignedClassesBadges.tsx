import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Plus, Users } from "lucide-react";
import { buildClassDisplayName, buildCompactClassDisplayName } from "@/lib/greek-school";
import type {
  CourseClass,
  AssignmentTarget,
  OfferingGroup,
} from "@/types/content-assignments";

interface AssignedClassesBadgesProps {
  classes: CourseClass[];
  /** Legacy: ids of offerings the content is assigned to (whole-class only). */
  assignedOfferingIds?: string[];
  /** Preferred: full (offering, group) targets. */
  assignedTargets?: AssignmentTarget[];
  /** Group catalog per offering, used to render the group name. */
  groupsByOffering?: Record<string, OfferingGroup[]>;
  onClickAssign?: () => void;
  /**
   * Hide the trailing "+" button while keeping the badges clickable.
   * For callers (e.g. study guides) that gate their own add affordance
   * but must keep the dialog reachable for removing assignments.
   */
  showAddButton?: boolean;
  compact?: boolean;
}

interface RenderableBadge {
  key: string;
  full: string;
  short: string;
}

export function AssignedClassesBadges({
  classes,
  assignedOfferingIds,
  assignedTargets,
  groupsByOffering,
  onClickAssign,
  showAddButton = true,
  compact = false,
}: AssignedClassesBadgesProps) {
  const items = useMemo<RenderableBadge[]>(() => {
    const targets: AssignmentTarget[] = assignedTargets
      ? assignedTargets
      : (assignedOfferingIds || []).map(oid => ({ offering_id: oid, group_id: null }));

    const classByOffering = new Map<string, CourseClass>();
    for (const c of classes) classByOffering.set(c.offering_id, c);

    const groupName = (offeringId: string, groupId: string): string | null => {
      const groups = groupsByOffering?.[offeringId];
      if (!groups) return null;
      const g = groups.find(x => x.id === groupId);
      if (!g) return null;
      // Individual (per-student) groups have an internal name like
      // `_individual_<uuid>` — surface the owning student's display name instead.
      if (g.is_individual) return g.owner_label ?? "Student";
      return g.name;
    };

    const list: RenderableBadge[] = [];
    const seen = new Set<string>();
    for (const t of targets) {
      const cls = classByOffering.get(t.offering_id);
      if (!cls) continue;
      const key = `${t.offering_id}::${t.group_id ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const classFull = buildClassDisplayName(cls);
      const classShort = buildCompactClassDisplayName(cls);

      if (t.group_id) {
        const gn = groupName(t.offering_id, t.group_id);
        const suffix = gn ?? "Group";
        list.push({
          key,
          full: `${classFull} → ${suffix}`,
          short: `${classShort} → ${suffix}`,
        });
      } else {
        list.push({ key, full: classFull, short: classShort });
      }
    }
    return list;
  }, [classes, assignedOfferingIds, assignedTargets, groupsByOffering]);

  if (items.length === 0) {
    if (onClickAssign) {
      return (
        <Button
          variant="ghost"
          size="sm"
          className="text-xs text-muted-foreground h-auto py-1 px-2"
          onClick={onClickAssign}
        >
          <Users className="w-3 h-3 mr-1" />
          Assign
        </Button>
      );
    }
    return <span className="text-xs text-muted-foreground italic">Not assigned</span>;
  }

  const maxShow = compact ? 2 : 3;
  const visible = items.slice(0, maxShow);
  const overflow = items.length - maxShow;

  // With the "+" button rendered, that button is the keyboard-accessible
  // control — the wrapper stays mouse-clickable but out of the tab order,
  // so one action doesn't get two tab stops.
  const hasAddButton = !!onClickAssign && showAddButton;
  const wrapperIsButton = !!onClickAssign && !hasAddButton;

  return (
    <div
      className={`flex flex-wrap gap-1 items-center${onClickAssign ? " cursor-pointer" : ""}`}
      onClick={onClickAssign}
      role={wrapperIsButton ? "button" : undefined}
      tabIndex={wrapperIsButton ? 0 : undefined}
      onKeyDown={
        wrapperIsButton
          ? e => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onClickAssign();
              }
            }
          : undefined
      }
    >
      {visible.map(item => {
        const label = compact ? item.short : item.full;

        return compact ? (
          <Tooltip key={item.key}>
            <TooltipTrigger asChild>
              <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                {label}
              </Badge>
            </TooltipTrigger>
            <TooltipContent>{item.full}</TooltipContent>
          </Tooltip>
        ) : (
          <Badge key={item.key} variant="secondary" className="text-xs">
            {label}
          </Badge>
        );
      })}
      {overflow > 0 && (
        <Badge variant="outline" className={compact ? "text-[10px] px-1.5 py-0" : "text-xs"}>
          +{overflow}
        </Badge>
      )}
      {hasAddButton && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className={compact ? "h-4 w-4 text-muted-foreground" : "h-5 w-5 text-muted-foreground"}
              aria-label="Assign to more sections"
              onClick={e => {
                e.stopPropagation();
                onClickAssign?.();
              }}
            >
              <Plus className="w-3 h-3" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Assign to more sections</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}
