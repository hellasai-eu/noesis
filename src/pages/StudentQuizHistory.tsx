import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  ArrowLeft,
  Loader2,
  ClipboardCheck,
  Clock,
  CheckCircle,
  Lock,
  Calendar,
  Eye,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { useFormatters } from "@/i18n/formatters";
import { StudentQuizReview } from "@/components/student/StudentQuizReview";

interface QuizResult {
  id: string;
  quizId: string;
  title: string;
  completedAt: string;
  score: number;
  totalPoints: number;
  timeLimit: number | null;
  showAnswers: boolean;
  dueDate: string | null;
}

const StudentQuizHistory = () => {
  const { t } = useTranslation("student");
  const { formatDateTime } = useFormatters();
  const { courseId } = useParams();
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const [courseTitle, setCourseTitle] = useState<string>("");
  const [quizResults, setQuizResults] = useState<QuizResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [reviewTarget, setReviewTarget] = useState<QuizResult | null>(null);

  useEffect(() => {
    if (!authLoading && !user) {
      navigate("/auth");
    }
  }, [user, authLoading, navigate]);

  useEffect(() => {
    if (courseId && user) {
      fetchQuizHistory();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch on courseId/user change
  }, [courseId, user]);

  const fetchQuizHistory = async () => {
    if (!courseId || !user) return;

    try {
      // Fetch course title
      const { data: courseData } = await supabase
        .from("courses")
        .select("title")
        .eq("id", courseId)
        .single();

      if (courseData) {
        setCourseTitle(courseData.title);
      }

      // Get user's class enrollments to find offerings
      const { data: enrollmentRows } = await supabase
        .from("class_enrollments")
        .select("class_id")
        .eq("user_id", user.id);

      const classIds = (enrollmentRows || []).map((r) => r.class_id);
      
      if (classIds.length === 0) {
        setQuizResults([]);
        setLoading(false);
        return;
      }

      // Get offerings for this course
      const { data: offeringRows } = await supabase
        .from("offerings")
        .select("id")
        .eq("course_id", courseId)
        .in("class_id", classIds);

      const offeringIds = (offeringRows || []).map((o) => o.id);

      if (offeringIds.length === 0) {
        setQuizResults([]);
        setLoading(false);
        return;
      }

      // Fetch quiz sessions with completed status for this course
      const { data: quizSessions } = await supabase
        .from("quiz_sessions")
        .select(`
          id,
          quiz_id,
          status,
          completed_at,
          quizzes!inner (
            id,
            title,
            time_limit_minutes,
            show_answers
          )
        `)
        .eq("user_id", user.id)
        .eq("course_id", courseId)
        .eq("status", "completed");

      // Filter to quizzes from this course's offerings
      const { data: offeringQuizzes } = await supabase
        .from("offering_quizzes")
        .select("quiz_id, due_date, answers_released")
        .in("offering_id", offeringIds);

      const offeringQuizIds = new Set((offeringQuizzes || []).map((oq) => oq.quiz_id));
      const quizDueDates: Record<string, string | null> = {};
      // Per-quiz OR of answers_released across all assignments the student can see
      // for this course — if any of their assignments released answers, show them.
      const quizAnswersReleased: Record<string, boolean> = {};
      (offeringQuizzes || []).forEach((oq) => {
        quizDueDates[oq.quiz_id] = oq.due_date;
        if (oq.answers_released) {
          quizAnswersReleased[oq.quiz_id] = true;
        }
      });

      // Get scores per session so repeated attempts each show their own score
      const sessionIds = (quizSessions || []).map((qs: any) => qs.id);

      const { data: sessionAnswers } = sessionIds.length > 0
        ? await supabase
            .from("quiz_answers")
            .select("session_id, quiz_id, is_correct")
            .eq("user_id", user.id)
            .in("session_id", sessionIds)
        : { data: [] as { session_id: string | null; quiz_id: string; is_correct: boolean }[] };

      const sessionScores: Record<string, { correct: number; total: number }> = {};
      (sessionAnswers || []).forEach((answer: any) => {
        if (!answer.session_id) return;
        if (!sessionScores[answer.session_id]) {
          sessionScores[answer.session_id] = { correct: 0, total: 0 };
        }
        sessionScores[answer.session_id].total++;
        if (answer.is_correct) {
          sessionScores[answer.session_id].correct++;
        }
      });

      // For sessions with no answers found (legacy rows where session_id was null),
      // fall back to quiz_id-keyed answers — same pattern as StudentQuizReview.
      const sessionsWithNoAnswers = (quizSessions || []).filter(
        (qs: any) => !sessionScores[qs.id]
      );
      if (sessionsWithNoAnswers.length > 0) {
        const legacyQuizIds = sessionsWithNoAnswers.map((qs: any) => qs.quiz_id);
        const { data: legacyAnswers } = await supabase
          .from("quiz_answers")
          .select("quiz_id, is_correct")
          .eq("user_id", user.id)
          .in("quiz_id", legacyQuizIds)
          .is("session_id", null);

        const legacyScoresByQuiz: Record<string, { correct: number; total: number }> = {};
        (legacyAnswers || []).forEach((answer: any) => {
          if (!legacyScoresByQuiz[answer.quiz_id]) {
            legacyScoresByQuiz[answer.quiz_id] = { correct: 0, total: 0 };
          }
          legacyScoresByQuiz[answer.quiz_id].total++;
          if (answer.is_correct) {
            legacyScoresByQuiz[answer.quiz_id].correct++;
          }
        });

        sessionsWithNoAnswers.forEach((qs: any) => {
          const duplicates = sessionsWithNoAnswers.filter(
            (s: any) => s.quiz_id === qs.quiz_id
          );
          if (duplicates.length === 1 && legacyScoresByQuiz[qs.quiz_id]) {
            sessionScores[qs.id] = legacyScoresByQuiz[qs.quiz_id];
          }
        });
      }

      // Build results - include all completed sessions for this course
      // (not just those from offerings, as quizzes may be taken without offering assignment)
      const results: QuizResult[] = (quizSessions || [])
        .map((qs: any) => ({
          id: qs.id,
          quizId: qs.quiz_id,
          title: qs.quizzes.title,
          completedAt: qs.completed_at || qs.created_at,
          score: sessionScores[qs.id]?.correct || 0,
          totalPoints: sessionScores[qs.id]?.total || 0,
          timeLimit: qs.quizzes.time_limit_minutes,
          showAnswers:
            (qs.quizzes.show_answers ?? false) ||
            (quizAnswersReleased[qs.quiz_id] ?? false),
          dueDate: quizDueDates[qs.quiz_id] || null,
        }))
        .sort((a: QuizResult, b: QuizResult) => 
          new Date(b.completedAt).getTime() - new Date(a.completedAt).getTime()
        );

      setQuizResults(results);
    } catch (error) {
      console.error("Error fetching quiz history:", error);
    } finally {
      setLoading(false);
    }
  };

  if (authLoading || loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-primary/5 via-background to-secondary/10">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-primary/5 via-background to-secondary/10">
      <nav className="border-b border-border bg-card/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="container mx-auto px-6 py-4 flex items-center gap-4">
          <Button 
            variant="ghost" 
            size="icon" 
            onClick={() => navigate(`/student/course/${courseId}`)}
          >
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <div>
            <h1 className="text-xl font-bold">{t("quizHistory.title")}</h1>
            <p className="text-sm text-muted-foreground">{courseTitle}</p>
          </div>
        </div>
      </nav>

      <main className="container mx-auto px-6 py-8">
        {quizResults.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center">
              <ClipboardCheck className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
              <h3 className="text-lg font-semibold mb-2">{t("quizHistory.emptyTitle")}</h3>
              <p className="text-muted-foreground">
                {t("quizHistory.emptyBody")}
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-4">
            {quizResults.map((result) => (
              <Card
                key={result.id}
                className={`transition-colors ${
                  result.showAnswers
                    ? "hover:border-primary/50 hover:bg-secondary/30 cursor-pointer"
                    : "hover:border-primary/30"
                }`}
                onClick={
                  result.showAnswers ? () => setReviewTarget(result) : undefined
                }
              >
                <CardContent className="p-6">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-2">
                        <Badge variant="secondary" className="bg-green-500/20 text-green-600 border-0">
                          <CheckCircle className="h-3 w-3 mr-1" />
                          {t("quizHistory.badgeCompleted")}
                        </Badge>
                        {result.timeLimit && (
                          <span className="text-xs text-muted-foreground flex items-center gap-1">
                            <Clock className="h-3 w-3" />
                            {t("quizHistory.minutes", { count: result.timeLimit })}
                          </span>
                        )}
                      </div>
                      
                      <h3 className="text-lg font-semibold mb-1">{result.title}</h3>
                      
                      <div className="flex items-center gap-4 text-sm text-muted-foreground">
                        <span className="flex items-center gap-1">
                          <Calendar className="h-3.5 w-3.5" />
                          {t("quizHistory.completedOn", {
                            date: formatDateTime(result.completedAt, {
                              dateStyle: "medium",
                              timeStyle: "short",
                            }),
                          })}
                        </span>
                      </div>
                    </div>

                    <div className="text-right flex flex-col items-end gap-2">
                      {result.showAnswers ? (
                        <>
                          <div>
                            <div className="text-3xl font-bold text-primary">
                              {result.score}/{result.totalPoints}
                            </div>
                            <div className="text-sm text-muted-foreground">
                              {result.totalPoints > 0
                                ? Math.round((result.score / result.totalPoints) * 100)
                                : 0}%
                            </div>
                          </div>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={(e) => {
                              e.stopPropagation();
                              setReviewTarget(result);
                            }}
                            className="gap-1.5"
                          >
                            <Eye className="h-3.5 w-3.5" />
                            {t("quizHistory.reviewAnswers")}
                          </Button>
                        </>
                      ) : (
                        <div className="flex items-center gap-2 text-muted-foreground">
                          <Lock className="h-4 w-4" />
                          <span className="text-sm">{t("quizHistory.resultsPending")}</span>
                        </div>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </main>

      {reviewTarget && user && (
        <StudentQuizReview
          open={!!reviewTarget}
          onOpenChange={(open) => {
            if (!open) setReviewTarget(null);
          }}
          quizId={reviewTarget.quizId}
          sessionId={reviewTarget.id}
          userId={user.id}
          quizTitle={reviewTarget.title}
        />
      )}
    </div>
  );
};

export default StudentQuizHistory;
