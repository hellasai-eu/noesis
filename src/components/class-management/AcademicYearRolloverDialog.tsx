import { useState } from "react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AlertTriangle, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  institutionId: string;
  currentPeriod: string | null;
  activeSectionCount: number;
  onCompleted: () => void;
}

export default function AcademicYearRolloverDialog({
  open,
  onOpenChange,
  institutionId,
  currentPeriod,
  activeSectionCount,
  onCompleted,
}: Props) {
  const [newPeriod, setNewPeriod] = useState("");
  const [rolling, setRolling] = useState(false);

  const handleRollover = async () => {
    if (!newPeriod.trim()) return;
    setRolling(true);
    try {
      const { data, error } = await supabase.functions.invoke("academic-year-rollover", {
        body: {
          institution_id: institutionId,
          new_academic_period: newPeriod.trim(),
        },
      });

      if (error) throw error;
      if (!data.success) throw new Error(data.error || "Rollover failed");

      const result = data.data;
      toast.success(
        `Rollover complete: ${result.archived_count} sections archived, ${result.created_count} new sections created, ${result.offerings_copied} course offerings copied`,
      );
      onCompleted();
      onOpenChange(false);
      setNewPeriod("");
    } catch (err: any) {
      toast.error(err.message || "Failed to perform rollover");
    } finally {
      setRolling(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>New Academic Year Rollover</AlertDialogTitle>
          <AlertDialogDescription>
            This action will transition your institution to a new academic year.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-4 py-2">
          <div className="p-3 bg-amber-500/10 border border-amber-500/20 rounded-lg flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
            <div className="text-sm text-amber-700 dark:text-amber-400 space-y-1">
              <p>This will:</p>
              <ul className="list-disc list-inside space-y-0.5">
                <li>Archive all {activeSectionCount} active section{activeSectionCount !== 1 ? "s" : ""} (set to inactive)</li>
                <li>Create new sections with the same names for the new year</li>
                <li>Re-attach the same courses to new sections</li>
              </ul>
              <p className="mt-2 font-medium">
                Student enrollments will NOT be copied. Course-level instructor assignments will be preserved.
              </p>
            </div>
          </div>

          {currentPeriod && (
            <div>
              <Label className="text-muted-foreground">Current Academic Period</Label>
              <p className="font-medium">{currentPeriod}</p>
            </div>
          )}

          <div>
            <Label htmlFor="new-period">New Academic Period</Label>
            <Input
              id="new-period"
              placeholder="e.g., 2026-2027"
              value={newPeriod}
              onChange={(e) => setNewPeriod(e.target.value)}
              disabled={rolling}
            />
          </div>
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={rolling}>Cancel</AlertDialogCancel>
          <Button
            onClick={handleRollover}
            disabled={!newPeriod.trim() || rolling}
            variant="default"
          >
            {rolling ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
                Rolling over...
              </>
            ) : (
              "Start Rollover"
            )}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
