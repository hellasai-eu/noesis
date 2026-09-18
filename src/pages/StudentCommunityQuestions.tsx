import { useParams, useNavigate } from "react-router-dom";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { CommunityQuestions } from "@/components/student/CommunityQuestions";
import StudentQuestionGenerator from "@/components/StudentQuestionGenerator";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ArrowLeft, AlertTriangle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { brand } from "@/deployment";

export default function StudentCommunityQuestions() {
  const { t } = useTranslation("practice");
  const { courseId } = useParams<{ courseId: string }>();
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const [showGenerator, setShowGenerator] = useState(false);
  const [courseData, setCourseData] = useState<{
    title: string;
    student_questions_enabled: boolean;
    restrict_to_completed_chapters: boolean;
    show_difficulty_to_students: boolean;
    offering_id?: string;
    class_id?: string;
  } | null>(null);

  useEffect(() => {
    if (!authLoading && !user) {
      navigate("/auth");
    }
  }, [user, authLoading, navigate]);

  useEffect(() => {
    if (!courseId || !user) return;
    (async () => {
      const { data: course } = await supabase
        .from("courses")
        .select("title, student_questions_enabled, restrict_to_completed_chapters, show_difficulty_to_students")
        .eq("id", courseId)
        .single();
      if (!course) return;

      const { data: enrollmentRows } = await supabase
        .from("class_enrollments")
        .select("class_id")
        .eq("user_id", user.id);

      const classIds = (enrollmentRows || []).map((r) => r.class_id);
      let offeringId: string | undefined;
      let classId: string | undefined;

      if (classIds.length > 0) {
        const { data: offeringRows } = await supabase
          .from("offerings")
          .select("id, class_id")
          .eq("course_id", courseId)
          .in("class_id", classIds);

        const firstOffering = offeringRows?.[0];
        offeringId = firstOffering?.id;
        classId = firstOffering?.class_id;
      }

      setCourseData({
        title: course.title,
        student_questions_enabled: course.student_questions_enabled,
        restrict_to_completed_chapters: course.restrict_to_completed_chapters ?? false,
        show_difficulty_to_students: course.show_difficulty_to_students !== false,
        offering_id: offeringId,
        class_id: classId,
      });
    })();
  }, [courseId, user]);

  if (!courseId) return null;

  if (showGenerator && courseData && (courseData.class_id || !courseData.restrict_to_completed_chapters)) {
    return (
      <StudentQuestionGenerator
        courseId={courseId}
        classId={courseData.class_id ?? null}
        restrictToCompletedChapters={courseData.restrict_to_completed_chapters}
        onBack={() => setShowGenerator(false)}
      />
    );
  }

  return (
    <div className="container max-w-7xl mx-auto py-6 px-4 space-y-4">
      <Button
        variant="ghost"
        size="sm"
        // The course surface has no tabs to return to — every shelf is on the
        // one page — so a bare course URL lands the student back where the
        // Community tile is, which is where they came from.
        onClick={() => navigate(`/student/course/${courseId}`)}
        className="gap-2"
      >
        <ArrowLeft className="w-4 h-4" />
        {t("community.backToCourse", {
          course: courseData?.title || t("community.courseFallback"),
        })}
      </Button>

      <div>
        <h1 className="text-2xl font-bold">{t("community.title")}</h1>
        <p className="text-muted-foreground text-sm mt-1">
          {t("community.subtitle")}
        </p>
      </div>

      <Alert variant="default" className="border-amber-200 bg-amber-50 dark:bg-amber-950/30">
        <AlertTriangle className="h-4 w-4 text-amber-600" />
        <AlertDescription className="text-amber-800 dark:text-amber-200">
          {/* Deliberately untranslated: this is an AI-content disclaimer, not
              interface copy. Legal and AI-content wording is a separate track,
              and a translation that drifts from the English notice is worse
              than an English one. */}
          These questions and answers have been created by {brand.name} AI on behalf of students and have not been reviewed or curated by instructors. They may contain errors.
        </AlertDescription>
      </Alert>

      <CommunityQuestions
        courseId={courseId}
        offeringId={courseData?.offering_id}
        classId={courseData?.class_id}
        showDifficulty={courseData?.show_difficulty_to_students ?? true}
        studentQuestionsEnabled={courseData?.student_questions_enabled ?? false}
        onOpenGenerator={() => setShowGenerator(true)}
      />
    </div>
  );
}
