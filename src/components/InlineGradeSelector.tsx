import { useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useInstitutionGradeLevels } from "@/hooks/useInstitutionGradeLevels";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { School, Loader2 } from "lucide-react";
import { toast } from "sonner";

interface InlineGradeSelectorProps {
  userId: string;
  institutionId: string;
  userInstitutionId: string;
  role: "student" | "instructor";
  currentGradeLevel?: string | null;
  currentGradeLevels?: string[];
  /**
   * grade_levels.id values actually used by the institution's classes.
   * When provided, the dropdown is restricted to these grades (the current
   * selection stays visible even if it falls outside the set, so admins can
   * clear it). When omitted, every grade_level row is shown — the historical
   * behavior, which surfaces the full 12-row Greek taxonomy for institutions
   * that only use a subset (see #805).
   */
  availableGradeLevelIds?: string[] | null;
  onGradeChange?: (
    grades: string[],
    removedEnrollmentClassIds?: string[],
    removedCourseIds?: string[],
  ) => void;
}

export const InlineGradeSelector = ({
  userId,
  institutionId,
  userInstitutionId,
  role,
  currentGradeLevel,
  currentGradeLevels = [],
  availableGradeLevelIds,
  onGradeChange,
}: InlineGradeSelectorProps) => {
  const [saving, setSaving] = useState(false);
  const gradeLevels = useInstitutionGradeLevels(institutionId);
  const visibleGrades = useMemo(() => {
    if (!availableGradeLevelIds) return gradeLevels.options;
    const idSet = new Set(availableGradeLevelIds);
    return gradeLevels.options.filter((o) => idSet.has(o.id));
  }, [gradeLevels.options, availableGradeLevelIds]);

  const handleStudentGradeChange = async (value: string) => {
    setSaving(true);
    try {
      const newGrade = value === "none" ? null : value;
      const newGradeId = newGrade ? gradeLevels.findIdByCode(newGrade) : null;
      const { error } = await supabase
        .from("user_institutions")
        .update({ grade_level_id: newGradeId })
        .eq("user_id", userId)
        .eq("institution_id", institutionId);

      if (error) throw error;

      // Find and remove class enrollments that don't match the new grade.
      // FK identity match — the TEXT column no longer exists after #799.
      const { data: enrollments } = await supabase
        .from("class_enrollments")
        .select("class_id, classes!inner(id, grade_level_id, name, institution_id)")
        .eq("user_id", userId)
        .eq("classes.institution_id", institutionId);

      const toRemove = (enrollments || []).filter((e: any) => {
        if (newGradeId === null) return true; // clearing grade removes all
        return e.classes.grade_level_id !== newGradeId;
      });

      const removedClassIds: string[] = [];
      const removedClassNames: string[] = [];

      if (toRemove.length > 0) {
        const classIds = toRemove.map((e: any) => e.class_id);
        const { error: delError } = await supabase
          .from("class_enrollments")
          .delete()
          .eq("user_id", userId)
          .in("class_id", classIds);

        if (delError) throw delError;

        toRemove.forEach((e: any) => {
          removedClassIds.push(e.class_id);
          removedClassNames.push(e.classes.name);
        });
      }

      onGradeChange?.(newGrade ? [newGrade] : [], removedClassIds);

      if (removedClassNames.length > 0) {
        toast.success(`Grade updated. Removed from ${removedClassNames.join(", ")}.`);
      } else {
        toast.success("Grade updated");
      }
    } catch (error: any) {
      toast.error(error.message || "Failed to update grade");
    } finally {
      setSaving(false);
    }
  };

  const handleInstructorGradeToggle = async (gradeValue: string, checked: boolean) => {
    setSaving(true);
    try {
      const gradeValueId = gradeLevels.findIdByCode(gradeValue);
      if (!gradeValueId) {
        // Shouldn't happen — every option in the dropdown maps to a row.
        // Guard so the NOT NULL insert below never fails cryptically.
        throw new Error(`Grade level "${gradeValue}" is not registered for this institution`);
      }
      if (checked) {
        const { error } = await supabase
          .from("user_institution_grades")
          .insert({
            user_institution_id: userInstitutionId,
            grade_level_id: gradeValueId,
          });

        if (error) {
          if (error.code === "23505") {
            // Grade already exists in DB but not in local state — sync UI
            const newGrades = [...currentGradeLevels, gradeValue];
            onGradeChange?.(newGrades);
            return;
          }
          throw error;
        }

        const newGrades = [...currentGradeLevels, gradeValue];
        onGradeChange?.(newGrades);
      } else {
        // FK identity delete — the TEXT column no longer exists after #799.
        const { error } = await supabase
          .from("user_institution_grades")
          .delete()
          .eq("user_institution_id", userInstitutionId)
          .eq("grade_level_id", gradeValueId);

        if (error) throw error;

        const newGrades = currentGradeLevels.filter((g) => g !== gradeValue);

        // Find classes of the unchecked grade in this institution — FK
        // identity on grade_level_id.
        const { data: classesOfGrade } = await supabase
          .from("classes")
          .select("id")
          .eq("institution_id", institutionId)
          .eq("grade_level_id", gradeValueId);

        const classIds = (classesOfGrade || []).map((c) => c.id);
        const removedCourseIds: string[] = [];
        const removedCourseNames: string[] = [];

        if (classIds.length > 0) {
          // Delete section restrictions for those classes
          const { error: sectionDelError } = await supabase
            .from("course_instructor_sections")
            .delete()
            .eq("user_id", userId)
            .in("class_id", classIds);

          if (sectionDelError) throw sectionDelError;

          // Find courses offered in those classes
          const { data: offeringsData } = await supabase
            .from("offerings")
            .select("course_id")
            .in("class_id", classIds);

          const courseIdsInGrade = [
            ...new Set((offeringsData || []).map((o) => o.course_id)),
          ];

          if (courseIdsInGrade.length > 0) {
            // Find classes of remaining grades to check if courses are still needed.
            // FK identity match — TEXT column no longer exists after #799.
            const remainingGradeIds = newGrades
              .map((code) => gradeLevels.findIdByCode(code))
              .filter((id): id is string => !!id);
            const { data: remainingClasses } = remainingGradeIds.length > 0
              ? await supabase
                  .from("classes")
                  .select("id")
                  .eq("institution_id", institutionId)
                  .in("grade_level_id", remainingGradeIds)
              : { data: [] };

            const remainingClassIds = (remainingClasses || []).map((c) => c.id);

            // Find courses still offered via remaining grades
            const { data: remainingOfferings } = remainingClassIds.length > 0
              ? await supabase
                  .from("offerings")
                  .select("course_id")
                  .in("class_id", remainingClassIds)
              : { data: [] };

            const stillNeededCourseIds = new Set(
              (remainingOfferings || []).map((o) => o.course_id),
            );

            // Remove course_instructors only for courses no longer covered by remaining grades
            const toRemoveCourseIds = courseIdsInGrade.filter(
              (cid) => !stillNeededCourseIds.has(cid),
            );

            if (toRemoveCourseIds.length > 0) {
              // Get course titles for toast
              const { data: coursesData } = await supabase
                .from("courses")
                .select("id, title")
                .in("id", toRemoveCourseIds);

              const { error: delError } = await supabase
                .from("course_instructors")
                .delete()
                .eq("user_id", userId)
                .in("course_id", toRemoveCourseIds);

              if (delError) throw delError;

              (coursesData || []).forEach((c) => {
                removedCourseIds.push(c.id);
                removedCourseNames.push(c.title);
              });
            }
          }
        }

        onGradeChange?.(newGrades, undefined, removedCourseIds);

        if (removedCourseNames.length > 0) {
          toast.success(
            `Grade removed. Unassigned from ${removedCourseNames.join(", ")}.`,
          );
        } else {
          toast.success("Grade removed.");
        }
      }
    } catch (error: any) {
      toast.error(error.message || "Failed to update grades");
    } finally {
      setSaving(false);
    }
  };

  if (role === "student") {
    // Keep the current selection visible even if it falls outside the
    // in-use filter, so admins can see (and clear) a stale grade tag —
    // e.g. one set before the last matching class was deleted.
    const studentGrades =
      currentGradeLevel && !visibleGrades.some((g) => g.value === currentGradeLevel)
        ? [
            ...visibleGrades,
            gradeLevels.options.find((o) => o.value === currentGradeLevel),
          ].filter((g): g is NonNullable<typeof g> => !!g)
        : visibleGrades;
    return (
      <div className="flex items-center gap-1">
        <School className="w-3 h-3 text-muted-foreground" />
        <Select
          value={currentGradeLevel || "none"}
          onValueChange={handleStudentGradeChange}
          disabled={saving}
        >
          <SelectTrigger className="h-6 text-xs w-auto min-w-[120px] border-dashed">
            <SelectValue placeholder="Set grade" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">No grade</SelectItem>
            {studentGrades.map((g) => (
              <SelectItem key={g.value} value={g.value}>
                {g.labelEl} ({g.labelEn})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {saving && <Loader2 className="w-3 h-3 animate-spin" />}
      </div>
    );
  }

  // Instructor: multi-select popover — show badges for every currently
  // assigned grade, taking labels from the visible option list so custom
  // (non-Greek) grades render too. Order stays consistent with the popover.
  const sortedCurrentGrades = visibleGrades.filter((g) =>
    currentGradeLevels.includes(g.value)
  );
  const knownValues = new Set(visibleGrades.map((g) => g.value));
  // Fall through to the full option list first so out-of-scope grades keep
  // their proper labels, and only fall back to the raw code as a last resort.
  const extraCurrentGrades = currentGradeLevels
    .filter((v) => !knownValues.has(v))
    .map((v) => {
      const opt = gradeLevels.options.find((o) => o.value === v);
      return opt
        ? { value: v, labelEl: opt.labelEl, labelEn: opt.labelEn }
        : { value: v, labelEl: v, labelEn: v };
    });

  return (
    <div className="flex items-center gap-1">
      <School className="w-3 h-3 text-muted-foreground" />
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-auto min-h-[24px] px-1.5 py-0.5 text-xs font-normal"
          >
            {sortedCurrentGrades.length + extraCurrentGrades.length > 0 ? (
              <span className="flex flex-wrap gap-1">
                {[...sortedCurrentGrades, ...extraCurrentGrades].map((g) => (
                  <Badge
                    key={g.value}
                    variant="outline"
                    className="text-[10px] h-4 px-1 bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-200 dark:border-blue-800"
                  >
                    {gradeLevels.getLabel(g.value, "el")}
                  </Badge>
                ))}
              </span>
            ) : (
              <span className="text-muted-foreground">Set grades...</span>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-56 p-2" align="start">
          <div className="space-y-1 max-h-64 overflow-y-auto">
            {visibleGrades.map((g) => (
              <label
                key={g.value}
                className="flex items-center gap-2 p-1.5 rounded hover:bg-secondary transition-colors cursor-pointer"
              >
                <Checkbox
                  checked={currentGradeLevels.includes(g.value)}
                  onCheckedChange={(checked) =>
                    handleInstructorGradeToggle(g.value, !!checked)
                  }
                  disabled={saving}
                />
                <span className="text-sm">
                  {g.labelEl}{" "}
                  <span className="text-muted-foreground text-xs">
                    ({g.labelEn})
                  </span>
                </span>
              </label>
            ))}
            {extraCurrentGrades.length > 0 && (
              <>
                <div className="border-t my-1" />
                {extraCurrentGrades.map((g) => (
                  <label
                    key={g.value}
                    className="flex items-center gap-2 p-1.5 rounded hover:bg-secondary transition-colors cursor-pointer"
                    title="This grade is no longer in the institution's class list"
                  >
                    <Checkbox
                      checked
                      onCheckedChange={() =>
                        handleInstructorGradeToggle(g.value, false)
                      }
                      disabled={saving}
                    />
                    <span className="text-sm text-muted-foreground line-through">
                      {g.labelEl}
                    </span>
                  </label>
                ))}
              </>
            )}
          </div>
        </PopoverContent>
      </Popover>
      {saving && <Loader2 className="w-3 h-3 animate-spin" />}
    </div>
  );
};
