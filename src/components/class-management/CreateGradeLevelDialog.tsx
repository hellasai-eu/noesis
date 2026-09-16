import { useState, useMemo } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  gradeOptionsForLevels,
  getGradeLabel,
  getSectionDisplayName,
  SECTION_LETTERS,
  ALL_SCHOOL_LEVELS,
  type SchoolLevel,
} from "@/lib/greek-school";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  schoolLevels: SchoolLevel[];
  existingGradeLevels: string[];
  onCreateGradeLevel: (
    gradeLevel: string,
    sections: { name: string; section_name: string; category?: string | null }[],
  ) => Promise<void>;
}

export default function CreateGradeLevelDialog({
  open,
  onOpenChange,
  schoolLevels,
  existingGradeLevels,
  onCreateGradeLevel,
}: Props) {
  const [selectedGrade, setSelectedGrade] = useState<string>("");
  const [sectionCount, setSectionCount] = useState(3);
  const [category, setCategory] = useState("");
  const [creating, setCreating] = useState(false);

  // If an institution's school_levels is empty (e.g. a greek_school converted
  // from a generic institution), fall back to all 12 grades so admins can
  // still bootstrap their grade structure from the dialog.
  const effectiveSchoolLevels = useMemo(
    () => (schoolLevels.length > 0 ? schoolLevels : ALL_SCHOOL_LEVELS),
    [schoolLevels],
  );

  const availableGrades = useMemo(
    () =>
      gradeOptionsForLevels(effectiveSchoolLevels).filter(
        (g) => !existingGradeLevels.includes(g.value),
      ),
    [effectiveSchoolLevels, existingGradeLevels],
  );

  const preview = useMemo(() => {
    if (!selectedGrade) return [];
    const count = Math.min(sectionCount, SECTION_LETTERS.length);
    const catSuffix = category.trim() ? ` (${category.trim()})` : "";
    return SECTION_LETTERS.slice(0, count).map((letter) => ({
      displayName: `${getSectionDisplayName(selectedGrade, letter)}${catSuffix}`,
      letter,
    }));
  }, [selectedGrade, sectionCount, category]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedGrade || sectionCount < 1) return;

    setCreating(true);
    try {
      const gradeLabel = getGradeLabel(selectedGrade, "el");
      const catValue = category.trim() || null;
      const catSuffix = catValue ? ` (${catValue})` : "";
      const sections = SECTION_LETTERS.slice(0, sectionCount).map((letter) => ({
        name: `${gradeLabel} - Τμήμα ${getSectionDisplayName(selectedGrade, letter)}${catSuffix}`,
        section_name: letter,
        category: catValue,
      }));

      await onCreateGradeLevel(selectedGrade, sections);
      toast.success(
        `Created ${gradeLabel}${catSuffix} with ${sectionCount} section${sectionCount !== 1 ? "s" : ""}`,
      );
      onOpenChange(false);
      setSelectedGrade("");
      setSectionCount(3);
      setCategory("");
    } catch (err: any) {
      toast.error(err.message || "Failed to create grade level");
    } finally {
      setCreating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create Grade Level</DialogTitle>
          <DialogDescription>
            Choose a grade level and how many sections (τμήματα) to create.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label>Grade Level</Label>
            {availableGrades.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                All grade levels have already been created.
              </p>
            ) : (
              <Select value={selectedGrade} onValueChange={setSelectedGrade}>
                <SelectTrigger>
                  <SelectValue placeholder="Select grade level" />
                </SelectTrigger>
                <SelectContent>
                  {availableGrades.map((g) => (
                    <SelectItem key={g.value} value={g.value}>
                      {g.labelEl}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="section-count">Number of Sections</Label>
            <Input
              id="section-count"
              type="number"
              min={1}
              max={SECTION_LETTERS.length}
              value={sectionCount}
              onChange={(e) => setSectionCount(Math.max(1, Math.min(SECTION_LETTERS.length, parseInt(e.target.value) || 1)))}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="category">Category (optional)</Label>
            <Input
              id="category"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder="e.g., English, PT"
            />
            <p className="text-xs text-muted-foreground">
              Leave empty for default/regular sections. Use a category name to group sections by subject area.
            </p>
          </div>

          {preview.length > 0 && (
            <div className="space-y-2">
              <Label>Preview</Label>
              <div className="p-3 rounded-lg bg-secondary/50 text-sm">
                Will create: {preview.map((p) => p.displayName).join(", ")}
              </div>
            </div>
          )}

          <div className="flex gap-2 pt-2">
            <Button
              type="button"
              variant="outline"
              className="flex-1"
              onClick={() => onOpenChange(false)}
              disabled={creating}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              className="flex-1"
              disabled={creating || !selectedGrade || availableGrades.length === 0}
            >
              {creating ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  Creating...
                </>
              ) : (
                "Create Grade Level"
              )}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
