/**
 * EvaluatorCourse (#667) — read-only per-course question browser for the
 * evaluator role. Renders the unified question bank (#621) with every
 * write affordance gated off:
 *
 *   isAdmin={false}    — hides Generate, Similarity, the row-actions menu,
 *                         the bulk-action bar, the generation-rationale block,
 *                         and the checkbox column in the unified table.
 *   classes={[]}       — hides the Classes column and disables the
 *                         ContentAssignDialog entry points.
 *   materials={[]}      — the unified Generate dialog is gated by isAdmin
 *                         and never renders here, so we don't need to fetch
 *                         materials.
 *
 * Access is enforced server-side by RLS (`is_course_evaluator(course_id,
 * auth.uid())` policies on `courses`, `questions`, `question_chapters`,
 * `question_competencies`, `question_votes`, `material_chapters`,
 * `course_materials`, `course_competencies`). The client redirect to
 * `/evaluator` on a missing course is just a UX nicety; the table itself
 * cannot leak rows from courses the evaluator is not assigned to.
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useParams, useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { useUserInstitution } from "@/hooks/useUserInstitution";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  ArrowLeft,
  ClipboardCheck,
  Loader2,
  BookOpen,
} from "lucide-react";
import UnifiedQuestionBank from "@/components/UnifiedQuestionBank";

interface Course {
  id: string;
  title: string;
  description: string | null;
  theme: string | null;
}

const EvaluatorCourse = () => {
  const { t } = useTranslation("evaluator");
  const { courseId } = useParams();
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const {
    isAdmin,
    isInstructor,
    isEvaluator,
    loading: institutionLoading,
  } = useUserInstitution(user?.id);
  const [course, setCourse] = useState<Course | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  // Auth + role gates — match EvaluatorDashboard so a non-evaluator hitting
  // /evaluator/course/* gets bounced to their own landing.
  useEffect(() => {
    if (!authLoading && !user) {
      navigate("/auth");
      return;
    }
    if (!authLoading && !institutionLoading && user) {
      if (isAdmin || isInstructor) {
        navigate("/dashboard");
        return;
      }
      if (!isEvaluator) {
        navigate("/student");
      }
    }
  }, [user, isAdmin, isInstructor, isEvaluator, authLoading, institutionLoading, navigate]);

  useEffect(() => {
    const fetchCourse = async () => {
      if (!user || !courseId) return;
      setLoading(true);
      setNotFound(false);
      try {
        const { data, error } = await supabase
          .from("courses")
          .select("id, title, description, theme")
          .eq("id", courseId)
          .maybeSingle();
        if (error) throw error;
        if (!data) {
          setNotFound(true);
        } else {
          setCourse(data);
        }
      } catch (err) {
        console.error("Failed to load course for evaluator", err);
        setNotFound(true);
      } finally {
        setLoading(false);
      }
    };
    fetchCourse();
  }, [user, courseId]);

  if (authLoading || institutionLoading || loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-primary/5 via-background to-secondary/10">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (notFound || !course) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-primary/5 via-background to-secondary/10">
        <div className="container mx-auto px-4 sm:px-6 py-8">
          <Button
            variant="ghost"
            size="sm"
            className="mb-6"
            onClick={() => navigate("/evaluator")}
          >
            <ArrowLeft className="w-4 h-4 mr-2" />
            {t("course.back")}
          </Button>
          <Card className="py-12">
            <CardContent className="text-center">
              <BookOpen className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
              <p className="text-muted-foreground">
                {t("course.unavailable")}
              </p>
              <Button
                variant="outline"
                className="mt-4"
                onClick={() => navigate("/evaluator")}
              >
                {t("course.returnToCourses")}
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-primary/5 via-background to-secondary/10">
      <nav className="border-b border-border bg-card/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="container mx-auto px-4 sm:px-6 py-3 sm:py-4 flex items-center gap-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate("/evaluator")}
          >
            <ArrowLeft className="w-4 h-4 mr-2" />
            <span className="hidden sm:inline">{t("course.back")}</span>
          </Button>
          <div className="flex items-center gap-2 ml-auto">
            <Button
              size="sm"
              onClick={() => navigate(`/evaluator/course/${course?.id}/review`)}
              data-testid="start-review-button"
            >
              <ClipboardCheck className="w-4 h-4 mr-2" />
              {t("course.startReview")}
            </Button>
          </div>
        </div>
      </nav>

      <main className="container mx-auto px-4 sm:px-6 py-4 sm:py-6 lg:py-8 space-y-4">
        <div>
          <h1
            className="text-xl sm:text-2xl font-display font-bold text-foreground"
            data-testid="evaluator-course-title"
          >
            {course.title}
          </h1>
          {course.description && (
            <p className="text-sm text-muted-foreground mt-1">{course.description}</p>
          )}
        </div>

        <UnifiedQuestionBank
          courseId={course.id}
          materials={[]}
          isAdmin={false}
          classes={[]}
        />
      </main>
    </div>
  );
};

export default EvaluatorCourse;
