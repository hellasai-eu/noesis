import { useState, useEffect } from "react";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { processLatexContent } from "@/lib/latex-utils";
import "katex/dist/katex.min.css";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Loader2, Sparkles, CheckCircle, XCircle, ArrowLeft, Zap } from "lucide-react";
import { submitQuizAnswers } from "@/lib/submit-quiz-answers";
import { renderQuestionStem } from "@/lib/question-stem";
import { AiDisclaimer } from "@/components/AiDisclaimer";
import {
  mcqCorrectIndicesFromAnswerKey,
  mcqOptionsFromPayload,
} from "@/lib/question-payload";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";

interface Chapter {
  id: string;
  title: string;
  chapter_number: number;
  material_title: string;
  has_content: boolean;
}

interface GeneratedQuestion {
  id: string;
  question: string;
  options: string[];
  // Multi-correct (#592). The generator may return either `correct_answers`
  // (preferred) or legacy `correct_answer`; the API normalizes server-side.
  correct_answers: number[];
  explanation: string;
  difficulty: string;
}

const QUESTIONS_PER_GENERATION = 10;

interface StudentQuestionGeneratorProps {
  courseId: string;
  classId?: string | null;
  restrictToCompletedChapters?: boolean;
  onBack: () => void;
}

const DAILY_LIMIT = 10;

const checkIsAdminOrSuperAdmin = async (userId: string): Promise<boolean> => {
  const [superAdminResult, adminResult] = await Promise.all([
    supabase.rpc('is_super_admin', { _user_id: userId }),
    supabase.rpc('is_admin', { _user_id: userId })
  ]);
  return superAdminResult.data === true || adminResult.data === true;
};
const StudentQuestionGenerator = ({ courseId, classId, restrictToCompletedChapters = false, onBack }: StudentQuestionGeneratorProps) => {
  const { t } = useTranslation("study");
  const { user } = useAuth();
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [selectedChapter, setSelectedChapter] = useState<string>("");
  const [difficulty, setDifficulty] = useState<string>("mixed");
  const [loading, setLoading] = useState(false);
  const [chaptersLoading, setChaptersLoading] = useState(true);
  const [generatedQuestions, setGeneratedQuestions] = useState<GeneratedQuestion[]>([]);
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
  // Multi-correct (#592): the student's selected option indices. Empty
  // array = no selection yet.
  const [selectedAnswers, setSelectedAnswers] = useState<number[]>([]);
  const [showResult, setShowResult] = useState(false);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [todayCount, setTodayCount] = useState(0);
  const [hasUnlimitedAccess, setHasUnlimitedAccess] = useState(false);

  const currentQuestion = generatedQuestions[currentQuestionIndex] || null;

  useEffect(() => {
    fetchChapters();
    fetchTodayCount();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch on courseId/classId/restrict/user change
  }, [courseId, classId, restrictToCompletedChapters, user]);

  const fetchChapters = async () => {
    try {
      const { data: materials, error: materialsError } = await supabase
        .from("course_materials")
        .select("id, title, file_name")
        .eq("course_id", courseId)
        .eq("material_type", "textbook");

      if (materialsError) throw materialsError;

      if (!materials || materials.length === 0) {
        setChapters([]);
        setSelectedChapter("");
        setChaptersLoading(false);
        return;
      }

      const materialIds = materials.map(m => m.id);

      const { data: chaptersData, error: chaptersError } = await supabase
        .from("material_chapters")
        .select("id, title, chapter_number, material_id, content, openai_file_id")
        .in("material_id", materialIds)
        .order("chapter_number").order("id");

      if (chaptersError) throw chaptersError;

      const formattedChapters: Chapter[] = (chaptersData || []).map(ch => {
        const material = materials.find(m => m.id === ch.material_id);
        return {
          id: ch.id,
          title: ch.title,
          chapter_number: ch.chapter_number,
          material_title: material?.title || material?.file_name || t("generator.unknownMaterial"),
          has_content: !!ch.content || !!ch.openai_file_id,
        };
      }).filter(ch => ch.has_content);

      if (restrictToCompletedChapters) {
        // Only show chapters the instructor has marked complete for this class
        if (classId && formattedChapters.length > 0) {
          const chapterIds = formattedChapters.map(ch => ch.id);
          const { data: progressData } = await supabase
            .from("course_chapter_progress")
            .select("chapter_id, is_complete")
            .eq("class_id", classId)
            .in("chapter_id", chapterIds)
            .eq("is_complete", true);

          const completedIds = new Set((progressData || []).map(p => p.chapter_id));
          setChapters(formattedChapters.filter(ch => completedIds.has(ch.id)));
        } else {
          // Restriction is on but no class context — cannot determine completion
          setChapters([]);
        }
      } else {
        // Restriction off — all chapters with content are fair game
        setChapters(formattedChapters);
      }
      setSelectedChapter("");
    } catch (error) {
      console.error("Error fetching chapters:", error);
      toast.error(t("generator.loadChaptersFailed"));
    } finally {
      setChaptersLoading(false);
    }
  };

  const fetchTodayCount = async () => {
    if (!user) return;
    
    // Check if user is admin/superadmin
    const isUnlimited = await checkIsAdminOrSuperAdmin(user.id);
    setHasUnlimitedAccess(isUnlimited);
    
    if (isUnlimited) {
      setRemaining(-1); // -1 indicates unlimited
      return;
    }
    
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    // Limit is per student per course
    const { data, error } = await supabase
      .from("questions")
      .select("id")
      .eq("created_by", user.id)
      .eq("course_id", courseId)
      .eq("is_user_generated", true)
      .gte("created_at", todayStart.toISOString());

    if (!error && data) {
      setTodayCount(data.length);
      setRemaining(DAILY_LIMIT - data.length);
    }
  };

  const generateQuestions = async () => {
    if (!selectedChapter || !user) return;

    if (!hasUnlimitedAccess && remaining !== null && remaining <= 0) {
      toast.error(t("generator.dailyLimitReached"));
      return;
    }

    setLoading(true);
    setGeneratedQuestions([]);
    setCurrentQuestionIndex(0);
    setSelectedAnswers([]);
    setShowResult(false);

    try {
      // Use fetch with 5-minute timeout to prevent browser timeout issues
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5 * 60 * 1000);

      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        throw new Error(t("generator.notAuthenticated"));
      }

      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/generate-student-questions`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${session.access_token}`,
            "apikey": import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
          },
          body: JSON.stringify({
            courseId,
            chapterId: selectedChapter,
            difficulty,
            numQuestions: QUESTIONS_PER_GENERATION,
            format: "mcq",
          }),
          signal: controller.signal,
        }
      );

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        console.error("Function error:", errorData);
        throw new Error(errorData.error || `HTTP error ${response.status}`);
      }

      const data = await response.json();

      if (data.error) {
        toast.error(data.error);
        return;
      }

      // The edge function returns the inserted `public.questions` rows.
      // Those rows carry the unified `payload` / `answer_key` jsonb (#582);
      // normalize them to the runtime shape this component renders. After
      // #592 we read `correct_indices` and fall back to `correct_index`.
      const normalized: GeneratedQuestion[] = (data.questions || []).map((q: any) => ({
        id: q.id,
        question: q.question,
        options: mcqOptionsFromPayload(q.payload),
        correct_answers: mcqCorrectIndicesFromAnswerKey(q.answer_key),
        explanation: q.explanation || "",
        difficulty: q.difficulty || "medium",
      }));
      setGeneratedQuestions(normalized);
      if (data.remaining !== undefined) {
        if (data.remaining === -1) {
          setHasUnlimitedAccess(true);
        }
        setRemaining(data.remaining);
      }
      toast.success(
        t("generator.generated", { count: data.questions?.length || 0 }),
      );
    } catch (error: any) {
      console.error("Error generating questions:", error);
      toast.error(error.message || t("generator.generateFailed"));
    } finally {
      setLoading(false);
    }
  };

  const handleAnswerToggle = (answerIndex: number) => {
    if (showResult) return;
    setSelectedAnswers((prev) => {
      const next = new Set(prev);
      if (next.has(answerIndex)) next.delete(answerIndex);
      else next.add(answerIndex);
      return [...next].sort((a, b) => a - b);
    });
  };

  const handleSubmitAnswer = async () => {
    if (showResult || !currentQuestion || !user || selectedAnswers.length === 0) return;

    setShowResult(true);

    // Record the answer. Grading is the server's (#1094) — this sends the
    // picks and nothing else; the options grid below keeps rendering the key it
    // generated with.
    try {
      await submitQuizAnswers({
        courseId,
        sessionId: crypto.randomUUID(),
        answers: [
          {
            questionId: currentQuestion.id,
            submission: { selected_indices: selectedAnswers },
          },
        ],
      });
    } catch (error) {
      console.error("Error recording answer:", error);
    }
  };

  const handleNextQuestion = () => {
    if (currentQuestionIndex < generatedQuestions.length - 1) {
      setCurrentQuestionIndex(prev => prev + 1);
      setSelectedAnswers([]);
      setShowResult(false);
    } else {
      // All questions completed
      setGeneratedQuestions([]);
      setCurrentQuestionIndex(0);
      setSelectedAnswers([]);
      setShowResult(false);
    }
  };

  if (chaptersLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <Button variant="ghost" onClick={onBack}>
          <ArrowLeft className="w-4 h-4 mr-2" />
          {t("generator.back")}
        </Button>
        {remaining !== null && (
          <Badge variant={hasUnlimitedAccess ? "secondary" : remaining > 3 ? "secondary" : "destructive"} className="text-sm">
            <Zap className="w-3 h-3 mr-1" />
            {hasUnlimitedAccess
              ? t("generator.unlimited")
              : t("generator.questionsLeft", { count: Math.max(0, remaining) })}
          </Badge>
        )}
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-violet-500/20 to-purple-500/20 flex items-center justify-center">
              <Sparkles className="w-6 h-6 text-violet-600" />
            </div>
            <div>
              <CardTitle>{t("generator.title")}</CardTitle>
              <CardDescription>
                {t("generator.description", { count: QUESTIONS_PER_GENERATION })}
                {!hasUnlimitedAccess &&
                  t("generator.dailyLimitNote", { limit: DAILY_LIMIT })}
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {chapters.length === 0 ? (
            <p className="text-muted-foreground text-center py-4">
              {t("generator.noChapters")}
            </p>
          ) : (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">{t("generator.selectChapter")}</label>
                  <Select value={selectedChapter} onValueChange={setSelectedChapter}>
                    <SelectTrigger>
                      <SelectValue placeholder={t("generator.chooseChapter")} />
                    </SelectTrigger>
                    <SelectContent>
                      {chapters.map((ch) => (
                        <SelectItem key={ch.id} value={ch.id}>
                          {t("generator.chapterOption", {
                            material: ch.material_title,
                            number: ch.chapter_number,
                            title: ch.title,
                          })}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium">{t("generator.difficulty")}</label>
                  <Select value={difficulty} onValueChange={setDifficulty}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="mixed">{t("generator.difficultyMixed")}</SelectItem>
                      <SelectItem value="easy">{t("common:difficulty.easy")}</SelectItem>
                      <SelectItem value="medium">{t("common:difficulty.medium")}</SelectItem>
                      <SelectItem value="hard">{t("common:difficulty.hard")}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <Button
                onClick={generateQuestions}
                disabled={!selectedChapter || loading || (!hasUnlimitedAccess && remaining !== null && remaining <= 0)}
                className="w-full bg-gradient-to-r from-violet-500 to-purple-500 hover:from-violet-600 hover:to-purple-600"
              >
                {loading ? (
                  <div className="flex flex-col items-center gap-1">
                    <div className="flex items-center">
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      {t("generator.generating", { count: QUESTIONS_PER_GENERATION })}
                    </div>
                    <span className="text-xs opacity-80">{t("generator.generatingNote")}</span>
                  </div>
                ) : (
                  <>
                    <Sparkles className="w-4 h-4 mr-2" />
                    {t("generator.generate", { count: QUESTIONS_PER_GENERATION })}
                  </>
                )}
              </Button>
            </>
          )}
        </CardContent>
      </Card>

      {currentQuestion && (
        <Card className="border-2 border-violet-500/30">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="capitalize">
                  {currentQuestion.difficulty}
                </Badge>
                <Badge variant="secondary">
                  {t("generator.questionProgress", {
                    current: currentQuestionIndex + 1,
                    total: generatedQuestions.length,
                  })}
                </Badge>
              </div>
              <Badge variant="secondary" className="bg-violet-500/10 text-violet-600 border-violet-500/20">
                {t("generator.studentGenerated")}
              </Badge>
            </div>
            {/* "Student Generated" says who asked for the question, not who
                wrote it — `generate-student-questions` did (#936). */}
            <AiDisclaimer variant="compact" className="mt-3" />
            <CardTitle
              className="text-lg mt-4"
              dangerouslySetInnerHTML={{
                __html: processLatexContent(
                  renderQuestionStem(currentQuestion.question, currentQuestion.correct_answers.length > 1),
                ),
              }}
            />
          </CardHeader>
          <CardContent className="space-y-3">
            {currentQuestion.options.map((option, index) => {
              const isSelected = selectedAnswers.includes(index);
              const isCorrect = currentQuestion.correct_answers.includes(index);
              const showCorrect = showResult && isCorrect;
              const showWrong = showResult && isSelected && !isCorrect;

              return (
                <button
                  key={index}
                  type="button"
                  role="checkbox"
                  aria-checked={isSelected}
                  onClick={() => handleAnswerToggle(index)}
                  disabled={showResult}
                  className={`w-full p-4 rounded-lg border text-left transition-all ${
                    showCorrect
                      ? "bg-green-500/10 border-green-500 text-green-700"
                      : showWrong
                      ? "bg-red-500/10 border-red-500 text-red-700"
                      : isSelected
                      ? "bg-primary/10 border-primary"
                      : "hover:bg-muted border-border"
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <span
                      className={`w-6 h-6 rounded-md border-2 flex items-center justify-center flex-shrink-0 ${
                        isSelected ? "bg-primary border-primary text-primary-foreground" : "border-muted-foreground/30"
                      }`}
                      aria-hidden="true"
                    >
                      {isSelected && <CheckCircle className="w-4 h-4" />}
                    </span>
                    <span className="w-8 h-8 rounded-full bg-muted flex items-center justify-center text-sm font-medium">
                      {String.fromCharCode(65 + index)}
                    </span>
                    <span className="flex-1" dangerouslySetInnerHTML={{ __html: processLatexContent(option) }} />
                    {showCorrect && <CheckCircle className="w-5 h-5 text-green-600" />}
                    {showWrong && <XCircle className="w-5 h-5 text-red-600" />}
                  </div>
                </button>
              );
            })}

            {!showResult && (
              <div className="pt-2">
                <Button
                  onClick={handleSubmitAnswer}
                  disabled={selectedAnswers.length === 0}
                  className="w-full"
                >
                  {t("generator.submitAnswer")}
                </Button>
              </div>
            )}

            {showResult && (
              <div className="mt-4 p-4 rounded-lg bg-muted">
                <p className="font-medium mb-2">{t("generator.explanation")}</p>
                <p className="text-muted-foreground" dangerouslySetInnerHTML={{ __html: processLatexContent(currentQuestion.explanation) }} />
              </div>
            )}

            {showResult && (
              <div className="flex gap-2 pt-4">
                <Button onClick={handleNextQuestion} className="flex-1">
                  {currentQuestionIndex < generatedQuestions.length - 1
                    ? t("generator.nextQuestion")
                    : t("generator.doneGenerateMore")}
                </Button>
                <Button variant="outline" onClick={onBack}>
                  {t("generator.exit")}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
};

export default StudentQuestionGenerator;
