import { useState, useEffect, useMemo, useRef, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Check, X, Loader2, User } from "lucide-react";
import { buildClassDisplayName } from "@/lib/greek-school";
import type {
  CourseClass,
  OfferingGroup,
  AssignmentTarget,
  AssignSelection,
  OfferingSelection,
} from "@/types/content-assignments";

interface ContentAssignDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  classes: CourseClass[];
  /** Legacy: a set of offering ids assigned at the whole-class scope. */
  currentAssignedOfferingIds?: Set<string>;
  /** Preferred: full (offering, group) assignment targets. */
  currentAssignedTargets?: AssignmentTarget[];
  /** Groups available per offering id. Empty when no groups exist. */
  groupsByOffering?: Record<string, OfferingGroup[]>;
  /** Legacy single-arg save; called only when no groups feature is in use. */
  onSave: (selection: Set<string> | AssignSelection) => Promise<void>;
  saving: boolean;
  title?: string;
  description?: string;
  /**
   * Rendered between the class list and the Save/Cancel row — content-type
   * specific controls whose state lives in the caller, so this dialog stays
   * a pure target picker.
   */
  extraControls?: ReactNode;
  /**
   * Rendered inside each class card, below the class row and its groups —
   * per-class controls such as the study guides' per-section due date.
   * `selected` is whether anything in that class (whole class or a group) is
   * currently picked, so the caller can withhold controls that are
   * meaningless for a class that won't be saved.
   */
  perOfferingControls?: (cls: CourseClass, selected: boolean) => ReactNode;
}

export function ContentAssignDialog({
  open,
  onOpenChange,
  classes,
  currentAssignedOfferingIds,
  currentAssignedTargets,
  groupsByOffering,
  onSave,
  saving,
  title = "Assign to Classes",
  description = "Select which classes (or groups within a class) should have access to this content.",
  extraControls,
  perOfferingControls,
}: ContentAssignDialogProps) {
  const groupsMap = groupsByOffering ?? {};
  const anyGroups = useMemo(
    () => classes.some(c => (groupsMap[c.offering_id]?.length ?? 0) > 0),
    [classes, groupsMap]
  );

  const [perOffering, setPerOffering] = useState<Map<string, OfferingSelection>>(new Map());

  // Sync the selection from the saved assignments only until the user's first
  // edit in this opening. Callers build `currentAssignedTargets` inline on
  // every render, so re-initialising on every identity change would discard
  // unsaved picks whenever the caller re-renders mid-edit — e.g. checking a
  // class and then typing its due date, which lives in caller state. But a
  // snapshot taken strictly once per opening is wrong too: the dialog can open
  // before the assignments fetch resolves, and the authoritative targets that
  // arrive moments later must still be reflected — otherwise saving the stale
  // empty selection would delete existing assignments.
  const dirty = useRef(false);
  useEffect(() => {
    if (!open) {
      dirty.current = false;
      return;
    }
    if (dirty.current) return;
    const next = new Map<string, OfferingSelection>();
    if (currentAssignedTargets) {
      for (const t of currentAssignedTargets) {
        const sel = next.get(t.offering_id) ?? { wholeClass: false, groupIds: new Set<string>() };
        if (t.group_id === null) sel.wholeClass = true;
        else sel.groupIds.add(t.group_id);
        next.set(t.offering_id, sel);
      }
    } else if (currentAssignedOfferingIds) {
      for (const oid of currentAssignedOfferingIds) {
        next.set(oid, { wholeClass: true, groupIds: new Set() });
      }
    }
    setPerOffering(next);
  }, [open, currentAssignedTargets, currentAssignedOfferingIds]);

  const toggleWholeClass = (offeringId: string) => {
    dirty.current = true;
    setPerOffering(prev => {
      const next = new Map(prev);
      const sel = next.get(offeringId) ?? { wholeClass: false, groupIds: new Set<string>() };
      const updated: OfferingSelection = {
        wholeClass: !sel.wholeClass,
        groupIds: new Set(sel.groupIds),
      };
      if (!updated.wholeClass && updated.groupIds.size === 0) {
        next.delete(offeringId);
      } else {
        next.set(offeringId, updated);
      }
      return next;
    });
  };

  const toggleGroup = (offeringId: string, groupId: string) => {
    dirty.current = true;
    setPerOffering(prev => {
      const next = new Map(prev);
      const sel = next.get(offeringId) ?? { wholeClass: false, groupIds: new Set<string>() };
      const groupIds = new Set(sel.groupIds);
      if (groupIds.has(groupId)) groupIds.delete(groupId);
      else groupIds.add(groupId);
      const updated: OfferingSelection = { wholeClass: sel.wholeClass, groupIds };
      if (!updated.wholeClass && groupIds.size === 0) {
        next.delete(offeringId);
      } else {
        next.set(offeringId, updated);
      }
      return next;
    });
  };

  const handleSave = () => {
    if (anyGroups) {
      return onSave({ kind: 'targets', perOffering });
    }
    // No groups anywhere — keep the legacy save shape so older callers behave identically.
    const offeringIds = new Set<string>();
    for (const [oid, sel] of perOffering.entries()) {
      if (sel.wholeClass) offeringIds.add(oid);
    }
    return onSave(offeringIds);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-[460px]">
          <div className="space-y-3 p-1">
            {classes.map((cls) => {
              const sel = perOffering.get(cls.offering_id);
              const wholeClass = sel?.wholeClass ?? false;
              const selectedGroupIds = sel?.groupIds ?? new Set<string>();
              const groups = groupsMap[cls.offering_id] ?? [];
              const manualGroups = groups.filter(g => !g.is_individual);
              const individualGroups = groups.filter(g => g.is_individual);

              return (
                <div
                  key={cls.id}
                  className="p-3 rounded-lg border hover:bg-muted/50 transition-colors"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <Checkbox
                        id={`assign-${cls.id}`}
                        checked={wholeClass}
                        onCheckedChange={() => toggleWholeClass(cls.offering_id)}
                      />
                      <label htmlFor={`assign-${cls.id}`} className="cursor-pointer">
                        <p className="font-medium">{buildClassDisplayName(cls)}</p>
                        {cls.academic_period && (
                          <p className="text-xs text-muted-foreground">{cls.academic_period}</p>
                        )}
                      </label>
                    </div>
                    {wholeClass ? (
                      <Check className="w-4 h-4 text-primary" />
                    ) : (
                      <X className="w-4 h-4 text-muted-foreground" />
                    )}
                  </div>

                  {manualGroups.length > 0 && (
                    <div className="mt-3 ml-7 space-y-1.5 border-l pl-3">
                      <p className="text-xs uppercase tracking-wide text-muted-foreground">Groups</p>
                      {manualGroups.map(g => {
                        const checked = selectedGroupIds.has(g.id);
                        const groupCheckboxId = `assign-${cls.id}-group-${g.id}`;
                        return (
                          <div key={g.id} className="flex items-center gap-2">
                            <Checkbox
                              id={groupCheckboxId}
                              checked={checked}
                              onCheckedChange={() => toggleGroup(cls.offering_id, g.id)}
                            />
                            <label htmlFor={groupCheckboxId} className="text-sm cursor-pointer">
                              {g.name}
                            </label>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {individualGroups.length > 0 && (
                    <div className="mt-3 ml-7 space-y-1.5 border-l pl-3">
                      <p className="text-xs uppercase tracking-wide text-muted-foreground">Students</p>
                      {individualGroups.map(g => {
                        const checked = selectedGroupIds.has(g.id);
                        const groupCheckboxId = `assign-${cls.id}-group-${g.id}`;
                        const label = g.owner_label ?? "Student";
                        return (
                          <div key={g.id} className="flex items-center gap-2">
                            <Checkbox
                              id={groupCheckboxId}
                              checked={checked}
                              onCheckedChange={() => toggleGroup(cls.offering_id, g.id)}
                            />
                            <label
                              htmlFor={groupCheckboxId}
                              className="text-sm cursor-pointer flex items-center gap-1.5"
                            >
                              <User className="w-3.5 h-3.5 text-muted-foreground" />
                              {label}
                            </label>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {perOfferingControls?.(cls, wholeClass || selectedGroupIds.size > 0)}
                </div>
              );
            })}
          </div>
        </ScrollArea>

        {extraControls}

        <div className="flex justify-end gap-2 pt-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            Save
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
