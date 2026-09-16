import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { TablesUpdate } from "@/integrations/supabase/types";
import { CardTitle, CardDescription } from "@/components/ui/card";
import { Sparkles, CheckSquare } from "lucide-react";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";

interface StudentQuestionSettings {
  student_questions_enabled: boolean;
  restrict_to_completed_chapters: boolean;
}

interface StudentQuestionSettingsSectionProps {
  courseId: string;
  canManage: boolean;
  studentQuestionsEnabled: boolean;
  restrictToCompletedChapters: boolean;
  onSettingsChange?: (next: Partial<StudentQuestionSettings>) => void;
}

export function StudentQuestionSettingsSection({
  courseId,
  canManage,
  studentQuestionsEnabled,
  restrictToCompletedChapters,
  onSettingsChange,
}: StudentQuestionSettingsSectionProps) {
  const [savingSetting, setSavingSetting] = useState<keyof StudentQuestionSettings | null>(null);

  const updateSetting = async (key: keyof StudentQuestionSettings, value: boolean) => {
    if (!canManage) return;
    setSavingSetting(key);
    try {
      // Built as a typed patch rather than `{ [key]: value }`: a computed key
      // widens the literal to an index signature, which postgrest-js now
      // rejects outright (it can no longer tell the column names apart).
      const patch: TablesUpdate<"courses"> =
        key === "student_questions_enabled"
          ? { student_questions_enabled: value }
          : { restrict_to_completed_chapters: value };

      // .select() returns the updated rows so we can detect silent RLS failures
      // (where no error is raised but zero rows were affected).
      const { data, error } = await supabase
        .from("courses")
        .update(patch)
        .eq("id", courseId)
        .select("id");

      if (error) throw error;
      if (!data || data.length === 0) {
        throw new Error("You do not have permission to update this course setting.");
      }

      const changes: Partial<StudentQuestionSettings> = { [key]: value };

      if (key === "student_questions_enabled" && !value && restrictToCompletedChapters) {
        const { error: resetError } = await supabase
          .from("courses")
          .update({ restrict_to_completed_chapters: false })
          .eq("id", courseId);
        if (resetError) throw resetError;
        changes.restrict_to_completed_chapters = false;
      }

      onSettingsChange?.(changes);

      if (key === "student_questions_enabled") {
        toast.success(value ? "Student question creation enabled" : "Student question creation disabled");
      } else {
        toast.success(value ? "Restricted to completed chapters" : "All chapters available to students");
      }
    } catch (error: any) {
      toast.error(error.message || "Failed to update setting");
    } finally {
      setSavingSetting(null);
    }
  };

  return (
    <section className="p-6 space-y-4">
      <div className="space-y-1.5">
        <CardTitle className="flex items-center gap-2 text-base">
          <Sparkles className="w-4 h-4" />
          Student Question Generation
        </CardTitle>
        <CardDescription>
          Control whether students can generate their own practice questions and which chapters they can draw from.
        </CardDescription>
      </div>
      <div className="space-y-4 max-w-2xl">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <Label htmlFor="student-questions-toggle" className="cursor-pointer font-medium flex items-center gap-2">
              <Sparkles className="w-4 h-4" />
              Student Questions
            </Label>
            <p className="text-xs text-muted-foreground">
              Allow students to generate their own practice questions
            </p>
          </div>
          <Switch
            id="student-questions-toggle"
            checked={studentQuestionsEnabled}
            disabled={savingSetting === "student_questions_enabled"}
            onCheckedChange={(v) => updateSetting("student_questions_enabled", v)}
          />
        </div>

        <div className="border-t" />

        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <Label
              htmlFor="restrict-chapters-toggle"
              className={`font-medium flex items-center gap-2 ${studentQuestionsEnabled ? "cursor-pointer" : "opacity-60"}`}
            >
              <CheckSquare className="w-4 h-4" />
              Restrict to completed chapters
            </Label>
            <p className={`text-xs ${studentQuestionsEnabled ? "text-muted-foreground" : "text-muted-foreground/60"}`}>
              When on, students can only generate questions from chapters you've marked complete in Section Progress
            </p>
          </div>
          <Switch
            id="restrict-chapters-toggle"
            checked={restrictToCompletedChapters}
            disabled={!studentQuestionsEnabled || savingSetting === "restrict_to_completed_chapters"}
            onCheckedChange={(v) => updateSetting("restrict_to_completed_chapters", v)}
          />
        </div>
      </div>
    </section>
  );
}
