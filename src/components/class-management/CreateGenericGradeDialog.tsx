import { useEffect, useMemo, useState } from "react";
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
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existingGradeLevels: string[];
  onCreateGradeLevel: (
    gradeLevel: string,
    sections: { name: string; section_name: string }[],
  ) => Promise<void>;
}

const MAX_SECTIONS = 50;

export default function CreateGenericGradeDialog({
  open,
  onOpenChange,
  existingGradeLevels,
  onCreateGradeLevel,
}: Props) {
  const [gradeName, setGradeName] = useState("");
  const [sectionCount, setSectionCount] = useState(1);
  const [creating, setCreating] = useState(false);

  // Reset form when the dialog opens so stale values from a cancelled flow don't reappear.
  useEffect(() => {
    if (open) {
      setGradeName("");
      setSectionCount(1);
    }
  }, [open]);

  const trimmedName = gradeName.trim();
  const isDuplicate = useMemo(
    () =>
      existingGradeLevels.some(
        (g) => g.toLowerCase() === trimmedName.toLowerCase(),
      ),
    [existingGradeLevels, trimmedName],
  );

  const preview = useMemo(
    () =>
      Array.from({ length: sectionCount }, (_, i) => `Section ${i + 1}`),
    [sectionCount],
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!trimmedName || isDuplicate || sectionCount < 1) return;

    setCreating(true);
    try {
      const sections = Array.from({ length: sectionCount }, (_, i) => {
        const sectionName = String(i + 1);
        return {
          name: `${trimmedName} - Section ${sectionName}`,
          section_name: sectionName,
        };
      });

      await onCreateGradeLevel(trimmedName, sections);
      toast.success(
        `Created ${trimmedName} with ${sectionCount} section${sectionCount !== 1 ? "s" : ""}`,
      );
      onOpenChange(false);
    } catch (err: any) {
      toast.error(err.message || "Failed to create grade");
    } finally {
      setCreating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Grade</DialogTitle>
          <DialogDescription>
            Name the grade and choose how many sections to create. You can add more
            sections and attach courses afterwards.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="grade-name">Grade Name</Label>
            <Input
              id="grade-name"
              placeholder="e.g. Year 1, Beginners, General"
              value={gradeName}
              onChange={(e) => setGradeName(e.target.value)}
              required
            />
            {isDuplicate && (
              <p className="text-sm text-destructive">
                A grade with this name already exists.
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="section-count">Number of Sections</Label>
            <Input
              id="section-count"
              type="number"
              min={1}
              max={MAX_SECTIONS}
              value={sectionCount}
              onChange={(e) =>
                setSectionCount(
                  Math.max(1, Math.min(MAX_SECTIONS, parseInt(e.target.value) || 1)),
                )
              }
            />
          </div>

          {trimmedName && (
            <div className="space-y-2">
              <Label>Preview</Label>
              <div className="p-3 rounded-lg bg-secondary/50 text-sm">
                Will create: {preview.map((p) => `${trimmedName} – ${p}`).join(", ")}
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
              disabled={creating || !trimmedName || isDuplicate}
            >
              {creating ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  Creating...
                </>
              ) : (
                "Add Grade"
              )}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
