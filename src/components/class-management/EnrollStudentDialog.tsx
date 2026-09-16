import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ArrowRightLeft, Info, Loader2, Search, X } from "lucide-react";
import { useInstitutionGradeLevels } from "@/hooks/useInstitutionGradeLevels";
import type { AvailableUser, StudentFilterMode } from "./hooks/useClassManagement";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  availableUsers: AvailableUser[];
  targetName: string;
  institutionId?: string | null;
  classGradeLevel?: string | null;
  classCategory?: string | null;
  filterMode: StudentFilterMode;
  onFilterModeChange: (mode: StudentFilterMode) => void;
  onEnroll: (userIds: string[], reassignments?: { userId: string; fromClassId: string }[]) => Promise<void>;
}

export default function EnrollStudentDialog({
  open,
  onOpenChange,
  availableUsers,
  targetName,
  institutionId,
  classGradeLevel,
  classCategory,
  filterMode,
  onFilterModeChange,
  onEnroll,
}: Props) {
  const gradeLevels = useInstitutionGradeLevels(institutionId ?? null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState("");
  const [enrolling, setEnrolling] = useState(false);
  const [confirmReassignStudents, setConfirmReassignStudents] = useState<AvailableUser[]>([]);

  const filtered = availableUsers.filter((user) => {
    const q = searchQuery.toLowerCase();
    return (
      !searchQuery ||
      user.full_name?.toLowerCase().includes(q) ||
      user.email?.toLowerCase().includes(q)
    );
  });

  const toggleSelection = (userId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) {
        next.delete(userId);
      } else {
        next.add(userId);
      }
      return next;
    });
  };

  const allFilteredSelected = filtered.length > 0 && filtered.every((s) => selectedIds.has(s.user_id));

  const toggleSelectAll = () => {
    if (allFilteredSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filtered.map((s) => s.user_id)));
    }
  };

  const handleSubmit = async () => {
    if (selectedIds.size === 0) return;
    const selected = availableUsers.filter((u) => selectedIds.has(u.user_id));
    const needReassign = selected.filter((s) => s.current_class_id);
    if (needReassign.length > 0) {
      setConfirmReassignStudents(needReassign);
      return;
    }
    await doEnroll();
  };

  const doEnroll = async (reassignStudents?: AvailableUser[]) => {
    if (selectedIds.size === 0) return;
    setEnrolling(true);
    try {
      const userIds = Array.from(selectedIds);
      const reassignments = reassignStudents?.map((s) => ({
        userId: s.user_id,
        fromClassId: s.current_class_id!,
      }));
      await onEnroll(userIds, reassignments);
      onOpenChange(false);
      setSelectedIds(new Set());
      setSearchQuery("");
    } catch {
      // handled by parent
    } finally {
      setEnrolling(false);
    }
  };

  const handleConfirmReassign = async () => {
    const students = confirmReassignStudents;
    setConfirmReassignStudents([]);
    await doEnroll(students);
  };

  const gradeCategoryLabel = classGradeLevel
    ? `${gradeLevels.getLabel(classGradeLevel, "el")}${classCategory ? ` (${classCategory})` : ""}`
    : null;

  const filterModeLabel =
    filterMode === "unassigned"
      ? "Showing unassigned students"
      : filterMode === "same-grade"
        ? "Showing all students in grade (including assigned)"
        : "Showing all students";

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Add Student</DialogTitle>
            <DialogDescription>Add a student to {targetName}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {classGradeLevel && (
              <div className="flex items-center gap-2 text-sm text-blue-600 bg-blue-50 dark:bg-blue-950/30 dark:text-blue-400 px-3 py-2 rounded-md">
                <Info className="w-4 h-4 flex-shrink-0" />
                <span>{filterModeLabel}{filterMode !== "all" && gradeCategoryLabel && ` — ${gradeCategoryLabel}`}</span>
              </div>
            )}

            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Filter students</Label>
              <ToggleGroup
                type="single"
                value={filterMode}
                onValueChange={(val) => {
                  if (val) {
                    setSelectedIds(new Set());
                    onFilterModeChange(val as StudentFilterMode);
                  }
                }}
                className="justify-start"
              >
                <ToggleGroupItem value="unassigned" size="sm" className="text-xs">
                  Unassigned
                </ToggleGroupItem>
                <ToggleGroupItem value="same-grade" size="sm" className="text-xs">
                  Same grade
                </ToggleGroupItem>
                <ToggleGroupItem value="all" size="sm" className="text-xs">
                  All students
                </ToggleGroupItem>
              </ToggleGroup>
            </div>

            {availableUsers.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">
                {filterMode === "unassigned" && classGradeLevel
                  ? `No unassigned students in ${gradeCategoryLabel}. Try "Same grade" or "All students" to see assigned students.`
                  : classGradeLevel
                    ? `No available students in ${gradeCategoryLabel}. Ensure students have their grade level set.`
                    : "No available students to add. All students are already in this class."}
              </p>
            ) : (
              <>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                      placeholder="Search by name or email..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="pl-9"
                    />
                    {searchQuery && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="absolute right-1 top-1/2 -translate-y-1/2 h-6 w-6"
                        onClick={() => setSearchQuery("")}
                      >
                        <X className="h-3 w-3" />
                      </Button>
                    )}
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label>Select Students ({filtered.length} available)</Label>
                    {filtered.length > 0 && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-xs h-7"
                        onClick={toggleSelectAll}
                      >
                        {selectedIds.size === filtered.length ? "Deselect All" : "Select All"}
                      </Button>
                    )}
                  </div>
                  <ScrollArea className="h-[200px] border rounded-md">
                    {filtered.length === 0 ? (
                      <p className="text-sm text-muted-foreground text-center py-8">
                        No students match your search
                      </p>
                    ) : (
                      <div className="p-2 space-y-1">
                        {filtered.map((student) => (
                          <div
                            key={student.user_id}
                            className={`flex items-center gap-3 p-2 rounded-md cursor-pointer transition-colors ${
                              selectedIds.has(student.user_id)
                                ? "bg-primary/10 border border-primary/30"
                                : "hover:bg-secondary"
                            }`}
                            onClick={() => toggleSelection(student.user_id)}
                          >
                            <Checkbox
                              checked={selectedIds.has(student.user_id)}
                              className="pointer-events-none"
                            />
                            <div className="flex-1 min-w-0">
                              <p className="font-medium text-sm truncate">
                                {student.full_name || "No name"}
                              </p>
                              <p className="text-xs text-muted-foreground truncate">
                                {student.email || "No email"}
                              </p>
                              {student.current_class_name && (
                                <div className="flex items-center gap-1 mt-0.5">
                                  <ArrowRightLeft className="w-3 h-3 text-amber-500" />
                                  <span className="text-xs text-amber-600 dark:text-amber-400">
                                    Currently in {student.current_class_name}
                                  </span>
                                </div>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </ScrollArea>
                </div>
              </>
            )}
            <div className="flex gap-2">
              <Button
                variant="outline"
                className="flex-1"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button
                className="flex-1"
                disabled={selectedIds.size === 0 || enrolling}
                onClick={handleSubmit}
              >
                {enrolling ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin mr-2" />
                    Adding...
                  </>
                ) : selectedIds.size <= 1 ? (
                  "Add Student"
                ) : (
                  `Add ${selectedIds.size} Students`
                )}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmReassignStudents.length > 0} onOpenChange={(open) => { if (!open) setConfirmReassignStudents([]); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reassign {confirmReassignStudents.length === 1 ? "Student" : "Students"}?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div>
                {confirmReassignStudents.length === 1 ? (
                  <p>
                    <strong>{confirmReassignStudents[0]?.full_name || "This student"}</strong> is currently enrolled in{" "}
                    <strong>{confirmReassignStudents[0]?.current_class_name}</strong>. Adding them to{" "}
                    <strong>{targetName}</strong> will remove them from their current class.
                  </p>
                ) : (
                  <>
                    <p className="mb-2">
                      The following {confirmReassignStudents.length} students are currently enrolled in other classes.
                      Adding them to <strong>{targetName}</strong> will remove them from their current classes:
                    </p>
                    <ul className="list-disc pl-4 space-y-1">
                      {confirmReassignStudents.map((s) => (
                        <li key={s.user_id}>
                          <strong>{s.full_name || "Unknown"}</strong> — currently in {s.current_class_name}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmReassign}>
              Reassign {confirmReassignStudents.length === 1 ? "Student" : `${confirmReassignStudents.length} Students`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
