import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2 } from "lucide-react";
import { getSectionDisplayName } from "@/lib/greek-school";
import { useInstitutionGradeLevels } from "@/hooks/useInstitutionGradeLevels";
import type { ClassItem } from "./hooks/useClassManagement";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  availableCourses: { id: string; title: string; grade_level_id?: string | null }[];
  targetName: string;
  institutionId?: string | null;
  // For grade-level mode: show section checkboxes
  gradeSections?: ClassItem[];
  gradeLevel?: string;
  onAttach: (courseId: string, sectionIds?: string[]) => Promise<void>;
}

export default function AttachCourseDialog({
  open,
  onOpenChange,
  availableCourses,
  targetName,
  institutionId,
  gradeSections,
  gradeLevel,
  onAttach,
}: Props) {
  const gradeLevels = useInstitutionGradeLevels(institutionId ?? null);
  const [selectedCourseId, setSelectedCourseId] = useState<string>("");
  const [attaching, setAttaching] = useState(false);
  const [selectedSections, setSelectedSections] = useState<Set<string>>(
    new Set(gradeSections?.map((s) => s.id) || []),
  );

  // Reset state when dialog opens
  const handleOpenChange = (v: boolean) => {
    if (v) {
      setSelectedCourseId("");
      setSelectedSections(new Set(gradeSections?.map((s) => s.id) || []));
    }
    onOpenChange(v);
  };

  const handleSubmit = async () => {
    if (!selectedCourseId) return;
    setAttaching(true);
    try {
      const sectionIds = gradeSections
        ? Array.from(selectedSections)
        : undefined;
      await onAttach(selectedCourseId, sectionIds);
      handleOpenChange(false);
    } catch (err: any) {
      // Error handled by parent
    } finally {
      setAttaching(false);
    }
  };

  const toggleSection = (id: string) => {
    setSelectedSections((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Attach Course</DialogTitle>
          <DialogDescription>
            Select a course to attach to {targetName}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {availableCourses.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">
              No available courses to attach. All courses are already attached.
            </p>
          ) : (
            <>
              <Select value={selectedCourseId} onValueChange={setSelectedCourseId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a course" />
                </SelectTrigger>
                <SelectContent>
                  {availableCourses.map((course) => (
                    <SelectItem key={course.id} value={course.id}>
                      {course.title}
                      {course.grade_level_id
                        ? ` (${gradeLevels.getLabelById(course.grade_level_id, "el")})`
                        : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {/* Section checkboxes for grade-level mode */}
              {gradeSections && gradeSections.length > 0 && gradeLevel && selectedCourseId && (
                <div className="space-y-2">
                  <p className="text-sm font-medium">Sections</p>
                  {(() => {
                    // Group sections by category
                    const catMap = new Map<string, typeof gradeSections>();
                    for (const s of gradeSections) {
                      const cat = s.category ?? "";
                      if (!catMap.has(cat)) catMap.set(cat, []);
                      catMap.get(cat)!.push(s);
                    }
                    const hasMultipleCats = catMap.size > 1;
                    return Array.from(catMap.entries()).map(([cat, sections]) => (
                      <div key={cat}>
                        {hasMultipleCats && (
                          <p className="text-xs text-muted-foreground font-medium mt-1 mb-0.5">
                            {cat || "Default"}
                          </p>
                        )}
                        <div className="flex flex-wrap gap-3">
                          {sections.map((section) => {
                            const displayName = section.section_name
                              ? getSectionDisplayName(gradeLevel, section.section_name)
                              : section.name;
                            return (
                              <label
                                key={section.id}
                                className="flex items-center gap-1.5 cursor-pointer text-sm"
                              >
                                <Checkbox
                                  checked={selectedSections.has(section.id)}
                                  onCheckedChange={() => toggleSection(section.id)}
                                />
                                <span>{displayName}{section.category ? ` (${section.category})` : ""}</span>
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    ));
                  })()}
                </div>
              )}
            </>
          )}

          <div className="flex gap-2">
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => handleOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              className="flex-1"
              disabled={
                !selectedCourseId ||
                attaching ||
                availableCourses.length === 0 ||
                (gradeSections && selectedSections.size === 0)
              }
              onClick={handleSubmit}
            >
              {attaching ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  Attaching...
                </>
              ) : (
                "Attach Course"
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
