import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Loader2, Search, X } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { getSectionDisplayName } from "@/lib/greek-school";

interface InstructorInfo {
  user_id: string;
  full_name: string | null;
  email: string | null;
  role: "admin" | "instructor";
}

export interface GradeSectionInfo {
  classId: string;
  sectionName: string;
  category: string | null;
  gradeLevel: string;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  courseId: string;
  courseTitle: string;
  institutionId: string;
  currentInstructorIds: string[];
  gradeSections?: GradeSectionInfo[];
  onChanged: () => void;
}

export default function CourseInstructorPicker({
  open,
  onOpenChange,
  courseId,
  courseTitle,
  institutionId,
  currentInstructorIds,
  gradeSections,
  onChanged,
}: Props) {
  const [availableInstructors, setAvailableInstructors] = useState<InstructorInfo[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sectionSelections, setSectionSelections] = useState<Map<string, boolean>>(new Map());

  useEffect(() => {
    if (open) {
      fetchInstructors();
      setSelectedIds(new Set());
      setSearchQuery("");
      initSectionSelections();
    }
  }, [open, courseId, institutionId]);

  const initSectionSelections = () => {
    if (!gradeSections || gradeSections.length === 0) {
      setSectionSelections(new Map());
      return;
    }
    const selections = new Map<string, boolean>();
    for (const sec of gradeSections) {
      selections.set(sec.classId, true);
    }
    setSectionSelections(selections);
  };

  const fetchInstructors = async () => {
    setLoading(true);
    try {
      const { data: members } = await supabase
        .from("user_institutions")
        .select("user_id, role")
        .eq("institution_id", institutionId)
        .eq("is_suspended", false)
        .in("role", ["instructor", "admin"]);

      if (!members || members.length === 0) {
        setAvailableInstructors([]);
        return;
      }

      const memberRoleMap = new Map(members.map((m) => [m.user_id, m.role as "admin" | "instructor"]));

      const { data: existing } = await supabase
        .from("course_instructors")
        .select("user_id")
        .eq("course_id", courseId);
      const assignedIds = new Set([
        ...(existing || []).map((r) => r.user_id),
        ...currentInstructorIds,
      ]);

      const availableUserIds = members
        .map((m) => m.user_id)
        .filter((id) => !assignedIds.has(id));

      if (availableUserIds.length === 0) {
        setAvailableInstructors([]);
        return;
      }

      const { data: profiles } = await supabase
        .from("profiles")
        .select("user_id, full_name, email")
        .in("user_id", availableUserIds);

      setAvailableInstructors(
        (profiles || []).map((p) => ({
          user_id: p.user_id,
          full_name: p.full_name,
          email: p.email,
          role: memberRoleMap.get(p.user_id) || "instructor",
        })),
      );
    } catch (err) {
      console.error("Error fetching instructors:", err);
    } finally {
      setLoading(false);
    }
  };

  const filtered = availableInstructors.filter((user) => {
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

  const toggleSectionSelection = (classId: string) => {
    setSectionSelections((prev) => {
      const next = new Map(prev);
      next.set(classId, !next.get(classId));
      return next;
    });
  };

  const handleSubmit = async () => {
    if (selectedIds.size === 0) return;
    setSaving(true);
    try {
      const roleByUserId = new Map(
        availableInstructors.map((i) => [i.user_id, i.role]),
      );
      const selectedUserIds = Array.from(selectedIds);
      const instructorUserIds = selectedUserIds.filter(
        (id) => roleByUserId.get(id) !== "admin",
      );

      const rows = selectedUserIds.map((userId) => ({
        course_id: courseId,
        user_id: userId,
      }));
      const { error } = await supabase.from("course_instructors").insert(rows);
      if (error) throw error;

      // Insert section restrictions for non-admin selections only. Admins
      // retain full access to all sections and are not subject to
      // course_instructor_sections restrictions.
      if (gradeSections && gradeSections.length > 0 && instructorUserIds.length > 0) {
        const checkedSections = gradeSections.filter((s) => sectionSelections.get(s.classId));
        const allChecked = checkedSections.length === gradeSections.length;

        if (checkedSections.length === 0) {
          toast.error("Select at least one section before adding the instructor.");
          setSaving(false);
          return;
        }

        if (!allChecked) {
          const sectionRows = instructorUserIds.flatMap((userId) =>
            checkedSections.map((sec) => ({
              course_id: courseId,
              user_id: userId,
              class_id: sec.classId,
            })),
          );
          const { error: secError } = await supabase
            .from("course_instructor_sections")
            .insert(sectionRows);
          if (secError) throw secError;
        }
      }

      toast.success(`${selectedIds.size} instructor(s) assigned to ${courseTitle}`);
      onChanged();
      onOpenChange(false);
    } catch (err: any) {
      toast.error(err.message || "Failed to assign instructors");
    } finally {
      setSaving(false);
    }
  };

  const hasSections = gradeSections && gradeSections.length > 0;
  const checkedCount = hasSections
    ? gradeSections.filter((s) => sectionSelections.get(s.classId)).length
    : 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add Course Instructors</DialogTitle>
          <DialogDescription>
            Assign instructors to <strong>{courseTitle}</strong>.
            {hasSections
              ? " Select which sections each instructor will have access to."
              : " This assignment applies to the course across all sections that use it."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {loading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin text-primary" />
            </div>
          ) : availableInstructors.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">
              No available instructors to assign. All instructors are already assigned to this course.
            </p>
          ) : (
            <>
              <div className="relative">
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

              <div className="space-y-2">
                <Label>
                  Select Instructors ({selectedIds.size} selected, {filtered.length} available)
                </Label>
                <ScrollArea className="h-[200px] border rounded-md">
                  {filtered.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-8">
                      No instructors match your search
                    </p>
                  ) : (
                    <div className="p-2 space-y-1">
                      {filtered.map((instructor) => (
                        <div
                          key={instructor.user_id}
                          className={`flex items-center gap-3 p-2 rounded-md cursor-pointer transition-colors ${
                            selectedIds.has(instructor.user_id)
                              ? "bg-primary/10 border border-primary/30"
                              : "hover:bg-secondary"
                          }`}
                          onClick={() => toggleSelection(instructor.user_id)}
                        >
                          <Checkbox
                            checked={selectedIds.has(instructor.user_id)}
                            className="pointer-events-none"
                          />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <p className="font-medium text-sm truncate">
                                {instructor.full_name || "No name"}
                              </p>
                              <Badge
                                variant={instructor.role === "admin" ? "default" : "secondary"}
                                className="text-xs py-0 px-1.5 shrink-0"
                              >
                                {instructor.role === "admin" ? "Admin" : "Instructor"}
                              </Badge>
                            </div>
                            <p className="text-xs text-muted-foreground truncate mt-0.5">
                              {instructor.email || "No email"}
                            </p>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </ScrollArea>
              </div>

              {hasSections && (
                <div className="space-y-2">
                  <Label>Section Access ({checkedCount} of {gradeSections.length} selected)</Label>
                  <div className="flex flex-wrap gap-3 p-3 border rounded-md">
                    {gradeSections.map((sec) => {
                      const displayName = getSectionDisplayName(sec.gradeLevel, sec.sectionName);
                      return (
                        <label
                          key={sec.classId}
                          className="flex items-center gap-1.5 cursor-pointer text-sm"
                        >
                          <Checkbox
                            checked={!!sectionSelections.get(sec.classId)}
                            onCheckedChange={() => toggleSectionSelection(sec.classId)}
                          />
                          <span>{displayName}</span>
                        </label>
                      );
                    })}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Deselect sections to restrict instructor access. If all are selected, no restrictions apply.
                  </p>
                </div>
              )}
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
              disabled={selectedIds.size === 0 || saving}
              onClick={handleSubmit}
            >
              {saving ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  Assigning...
                </>
              ) : (
                `Assign ${selectedIds.size > 0 ? selectedIds.size : ""} Instructor${selectedIds.size !== 1 ? "s" : ""}`
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
