import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { processLatexContent } from "@/lib/latex-utils";
import "katex/dist/katex.min.css";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CheckCircle2, Loader2, Sparkles, ThumbsDown, ThumbsUp, Users, Zap } from "lucide-react";
import {
  mcqOptionsFromPayload,
  mcqIsMultiCorrectFromPayload,
} from "@/lib/question-payload";
import { submitQuizAnswers } from "@/lib/submit-quiz-answers";
import { renderQuestionStem } from "@/lib/question-stem";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { useFormatters } from "@/i18n/formatters";

interface CommunityQuestionsProps {
  courseId: string;
  offeringId?: string | null;
  classId?: string | null;
  showDifficulty: boolean;
  studentQuestionsEnabled: boolean;
  onOpenGenerator: () => void;
}

interface CommunityQuestion {
  id: string;
  question: string;
  options: string[];
  /**
   * Whether more than one option is correct (#592), read from the
   * student-facing `payload` rather than the key (#1011). All the stem hint
   * needs, and all this surface knows about the answer before submitting.
   */
  multiCorrect: boolean;
  /**
   * The key. Empty until the student submits and the server sends it back
   * with the verdict — it is no longer fetched with the question (#1011).
   */
  correct_indices: number[];
  /** Justifies the key, so it is withheld with it. Null until reveal. */
  explanation: string | null;
  difficulty: string;
  created_by: string | null;
  /** Empty when the author is unknown. The display fallback is applied at
   *  render so it follows the active language. */
  authorName: string;
  answered: boolean;
  chapters: { id: string; title: string }[];
  upvotes: number;
  downvotes: number;
}

const DAILY_LIMIT = 10;

const difficultyVariant = (difficulty: string): "secondary" | "outline" | "destructive" => {
  const d = (difficulty || "").toLowerCase();
  if (d === "hard") return "destructive";
  if (d === "easy") return "secondary";
  return "outline";
};

export function CommunityQuestions({
  courseId,
  offeringId,
  classId: _classId,
  showDifficulty,
  studentQuestionsEnabled,
  onOpenGenerator,
}: CommunityQuestionsProps) {
  const { t } = useTranslation("practice");
  const { compareText } = useFormatters();
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [questions, setQuestions] = useState<CommunityQuestion[]>([]);
  const [selectedQuestionId, setSelectedQuestionId] = useState<string | null>(null);
  /**
   * Bumped on every selection, readable synchronously.
   *
   * `handleSubmitAnswer` reveals after an await, and comparing question ids
   * is not enough: opening a question resets `selectedAnswers`, so a student
   * who submits A, opens B, then reopens A before grading returns would pass
   * an id check and get the result view with no answer of theirs to mark. A
   * token changes on every selection, including a reselection of the same
   * question, so it asks the question that actually matters — is this still
   * the same attempt?
   */
  const selectionTokenRef = useRef(0);
  // Multi-correct (#592). Empty array = no selection.
  const [selectedAnswers, setSelectedAnswers] = useState<number[]>([]);
  const [showResult, setShowResult] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [todayCount, setTodayCount] = useState(0);
  const [hasUnlimitedAccess, setHasUnlimitedAccess] = useState(false);
  const [chapterFilter, setChapterFilter] = useState<string>("all");
  const [difficultyFilter, setDifficultyFilter] = useState<string>("all");
  const [userVotes, setUserVotes] = useState<Record<string, "up" | "down">>({});
  const [votingQuestionId, setVotingQuestionId] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    fetchQuestions();
    fetchTodayCount();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch on props/user change
  }, [courseId, offeringId, user?.id]);

  const fetchQuestions = async () => {
    if (!user) return;
    setLoading(true);
    try {
      let offeringQuestionIds: string[] | null = null;
      if (offeringId) {
        const { data: oqData } = await supabase
          .from("offering_questions")
          .select("question_id")
          .eq("offering_id", offeringId)
          .not("published_at", "is", null)
          .limit(10000);
        offeringQuestionIds = (oqData || []).map((oq) => oq.question_id);
        if (offeringQuestionIds.length === 0) {
          setQuestions([]);
          setLoading(false);
          return;
        }
      }

      // Reads the STUDENT-FACING half of the unified columns (#580): `payload`
      // only. Restrict to MCQ rows so the open-question siblings (#577) don't
      // leak into the community feed. Student-generated content is always
      // MCQ today; the type filter is still cheap insurance.
      //
      // Neither `answer_key` nor `explanation`: this is a whole course's peer
      // questions, so asking for them handed over every answer in the feed
      // before the student opened one (#1011).
      let query = supabase
        .from("questions")
        .select("id, question, payload, difficulty, created_by, created_at")
        .eq("course_id", courseId)
        .eq("type", "mcq")
        .eq("is_user_generated", true)
        .eq("hidden", false)
        .neq("validation_status", "INCORRECT")
        .order("created_at", { ascending: false });

      if (offeringQuestionIds) {
        query = query.in("id", offeringQuestionIds);
      }

      const { data: questionsData, error } = await query;
      if (error) throw error;

      const rows = questionsData || [];
      if (rows.length === 0) {
        setQuestions([]);
        setLoading(false);
        return;
      }

      const creatorIds = Array.from(
        new Set(rows.map((q) => q.created_by).filter((id): id is string => !!id)),
      );

      const questionIds = rows.map((q) => q.id);
      const [profilesResult, answersResult, chaptersResult, votesResult] = await Promise.all([
        creatorIds.length > 0
          ? supabase
              .from("profiles")
              .select("user_id, full_name, email")
              .in("user_id", creatorIds)
          : Promise.resolve({ data: [], error: null } as const),
        supabase
          .from("quiz_answers")
          .select("question_id")
          .eq("user_id", user.id)
          .eq("course_id", courseId)
          .in("question_id", questionIds),
        supabase
          .from("question_chapters")
          .select(`
            question_id,
            material_chapters!inner(id, title)
          `)
          .in("question_id", questionIds),
        supabase
          .from("question_votes")
          .select("question_id, vote_type, user_id")
          .in("question_id", questionIds),
      ]);

      const profileMap = new Map(
        // Annotated as a tuple: without it the callback infers `string[]`, and
        // `new Map` will not take an array of arrays.
        (profilesResult.data || []).map(
          (p: {
            user_id: string;
            full_name: string | null;
            email: string | null;
          }): [string, string] => [p.user_id, p.full_name || p.email || ""],
        ),
      );
      const answeredSet = new Set(
        (answersResult.data || []).map((a: { question_id: string }) => a.question_id),
      );
      const chaptersByQuestion = new Map<string, { id: string; title: string }[]>();
      (chaptersResult.data || []).forEach((qc: any) => {
        const ch = qc.material_chapters;
        if (!ch) return;
        const list = chaptersByQuestion.get(qc.question_id) || [];
        list.push({ id: ch.id, title: ch.title });
        chaptersByQuestion.set(qc.question_id, list);
      });

      const voteCounts = new Map<string, { up: number; down: number }>();
      const nextUserVotes: Record<string, "up" | "down"> = {};
      (votesResult.data || []).forEach((v: { question_id: string; vote_type: string; user_id: string }) => {
        const entry = voteCounts.get(v.question_id) || { up: 0, down: 0 };
        if (v.vote_type === "up") entry.up++;
        else if (v.vote_type === "down") entry.down++;
        voteCounts.set(v.question_id, entry);
        if (v.user_id === user.id && (v.vote_type === "up" || v.vote_type === "down")) {
          nextUserVotes[v.question_id] = v.vote_type;
        }
      });
      setUserVotes(nextUserVotes);

      const mapped: CommunityQuestion[] = rows.map((q: any) => ({
        id: q.id,
        question: q.question,
        options: mcqOptionsFromPayload(q.payload),
        multiCorrect: mcqIsMultiCorrectFromPayload(q.payload),
        correct_indices: [],
        explanation: null,
        difficulty: q.difficulty,
        created_by: q.created_by,
        authorName: (q.created_by ? profileMap.get(q.created_by) : "") || "",
        answered: answeredSet.has(q.id),
        chapters: chaptersByQuestion.get(q.id) || [],
        upvotes: voteCounts.get(q.id)?.up || 0,
        downvotes: voteCounts.get(q.id)?.down || 0,
      }));
      setQuestions(mapped);
    } catch (error) {
      console.error("Error fetching community questions:", error);
    } finally {
      setLoading(false);
    }
  };

  const fetchTodayCount = async () => {
    if (!user) return;

    const [superAdminResult, adminResult] = await Promise.all([
      supabase.rpc("is_super_admin", { _user_id: user.id }),
      supabase.rpc("is_admin", { _user_id: user.id }),
    ]);
    const unlimited = superAdminResult.data === true || adminResult.data === true;
    setHasUnlimitedAccess(unlimited);
    if (unlimited) return;

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const { data } = await supabase
      .from("questions")
      .select("id")
      .eq("created_by", user.id)
      .eq("course_id", courseId)
      .eq("is_user_generated", true)
      .gte("created_at", todayStart.toISOString());

    setTodayCount((data || []).length);
  };

  // Derive chapters for filter
  const chapters = (() => {
    const map = new Map<string, string>();
    questions.forEach((q) => {
      (q.chapters || []).forEach((ref) => {
        map.set(ref.id, ref.title);
      });
    });
    return Array.from(map.entries())
      .map(([id, title]) => ({ id, title }))
      .sort((a, b) => compareText(a.title, b.title));
  })();

  const filteredQuestions = questions.filter((q) => {
    if (chapterFilter !== "all" && !(q.chapters || []).some((ref) => ref.id === chapterFilter)) {
      return false;
    }
    if (difficultyFilter !== "all" && (q.difficulty || "").toLowerCase() !== difficultyFilter) {
      return false;
    }
    return true;
  });

  const selectedQuestion = questions.find((q) => q.id === selectedQuestionId) || null;

  const handleSelectQuestion = (id: string) => {
    selectionTokenRef.current += 1;
    setSelectedQuestionId(id);
    setSelectedAnswers([]);
    setShowResult(false);
  };

  const handleToggleAnswer = (answerIndex: number) => {
    if (showResult) return;
    setSelectedAnswers((prev) => {
      const next = new Set(prev);
      if (next.has(answerIndex)) next.delete(answerIndex);
      else next.add(answerIndex);
      return [...next].sort((a, b) => a - b);
    });
  };

  const handleSubmitAnswer = async () => {
    if (!user || !selectedQuestion || showResult || submitting || selectedAnswers.length === 0) return;

    const questionId = selectedQuestion.id;
    const token = selectionTokenRef.current;
    setSubmitting(true);

    try {
      // Recorded and graded server-side (#1094), and the key comes back with
      // the verdict (#1011). The panel used to render the key it had loaded
      // with the question, and flipped to the result view before this call was
      // even made; it now has nothing to show until the server answers, which
      // is why `showResult` moved below the await.
      const result = await submitQuizAnswers({
        courseId,
        sessionId: crypto.randomUUID(),
        answers: [
          {
            questionId,
            submission: { selected_indices: selectedAnswers },
          },
        ],
      });
      const reveal = result.results[0]?.reveal;

      setQuestions((prev) =>
        prev.map((q) =>
          q.id === questionId
            ? {
                ...q,
                answered: true,
                ...(reveal?.correctIndices ? { correct_indices: reveal.correctIndices } : {}),
                ...(reveal ? { explanation: reveal.explanation } : {}),
              }
            : q,
        ),
      );

      // Only if this is still the same attempt. The reveal lands after an
      // await, and any selection since — another question, or this one
      // reopened — has cleared the answers this result would be describing.
      //
      // The `setQuestions` write above is deliberately NOT gated on this: the
      // answer was recorded, so the row is answered and its key is known
      // regardless of what the student is looking at now.
      if (selectionTokenRef.current === token) setShowResult(true);
    } catch (error) {
      console.error("Error recording community answer:", error);
    } finally {
      setSubmitting(false);
    }
  };

  const handleVote = async (questionId: string, voteType: "up" | "down") => {
    if (!user || votingQuestionId) return;
    setVotingQuestionId(questionId);
    const currentVote = userVotes[questionId];

    try {
      if (currentVote === voteType) {
        const { error } = await supabase
          .from("question_votes")
          .delete()
          .eq("user_id", user.id)
          .eq("question_id", questionId);
        if (error) throw error;

        setUserVotes((prev) => {
          const { [questionId]: _removed, ...rest } = prev;
          return rest;
        });
        setQuestions((prev) =>
          prev.map((q) =>
            q.id === questionId
              ? {
                  ...q,
                  upvotes: voteType === "up" ? Math.max(0, q.upvotes - 1) : q.upvotes,
                  downvotes: voteType === "down" ? Math.max(0, q.downvotes - 1) : q.downvotes,
                }
              : q,
          ),
        );
        toast.success(t("community.voteRemoved"));
      } else {
        const { error } = await supabase
          .from("question_votes")
          .upsert(
            {
              user_id: user.id,
              question_id: questionId,
              vote_type: voteType,
            },
            { onConflict: "user_id,question_id" },
          );
        if (error) throw error;

        setUserVotes((prev) => ({ ...prev, [questionId]: voteType }));
        setQuestions((prev) =>
          prev.map((q) => {
            if (q.id !== questionId) return q;
            let { upvotes, downvotes } = q;
            if (currentVote === "up") upvotes = Math.max(0, upvotes - 1);
            if (currentVote === "down") downvotes = Math.max(0, downvotes - 1);
            if (voteType === "up") upvotes += 1;
            else downvotes += 1;
            return { ...q, upvotes, downvotes };
          }),
        );
        toast.success(t("community.voteThanks"));
      }
    } catch (error) {
      console.error("Error voting on community question:", error);
      toast.error(t("community.voteFailed"));
    } finally {
      setVotingQuestionId(null);
    }
  };

  if (!studentQuestionsEnabled) {
    return null;
  }

  const remainingToday = DAILY_LIMIT - todayCount;

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div className="flex items-center gap-2">
          {chapters.length > 0 && (
            <Select value={chapterFilter} onValueChange={setChapterFilter}>
              <SelectTrigger className="w-[200px] h-9">
                <SelectValue placeholder={t("community.filterByChapter")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("community.allChapters")}</SelectItem>
                {chapters.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.title.length > 30 ? c.title.slice(0, 27) + "…" : c.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {showDifficulty && (
            <Select value={difficultyFilter} onValueChange={setDifficultyFilter}>
              <SelectTrigger className="w-[140px] h-9">
                <SelectValue placeholder={t("community.difficultyPlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("community.allLevels")}</SelectItem>
                <SelectItem value="easy">{t("common:difficulty.easy")}</SelectItem>
                <SelectItem value="medium">{t("common:difficulty.medium")}</SelectItem>
                <SelectItem value="hard">{t("common:difficulty.hard")}</SelectItem>
              </SelectContent>
            </Select>
          )}
        </div>
        <div className="flex items-center gap-2">
          {hasUnlimitedAccess ? (
            <Badge variant="secondary" className="text-xs">
              <Zap className="w-3 h-3 mr-1" />
              {t("community.unlimited")}
            </Badge>
          ) : (
            <Badge
              variant={remainingToday > 3 ? "secondary" : "destructive"}
              className="text-xs"
            >
              <Zap className="w-3 h-3 mr-1" />
              {t("community.dailyQuota", {
                used: Math.max(0, remainingToday),
                limit: DAILY_LIMIT,
              })}
            </Badge>
          )}
          <Button size="sm" onClick={onOpenGenerator}>
            <Sparkles className="w-4 h-4 mr-2" />
            {t("community.createYourOwn")}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card className="order-2 lg:order-1">
          <CardContent className="p-0">
            {loading ? (
              <div className="flex items-center justify-center py-10">
                <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
              </div>
            ) : questions.length === 0 ? (
              <div className="text-center py-10 px-4 space-y-3">
                <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center mx-auto">
                  <Users className="w-5 h-5 text-muted-foreground" />
                </div>
                <p className="text-sm text-muted-foreground">
                  {t("community.empty")}
                </p>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("community.colQuestion")}</TableHead>
                    {showDifficulty && (
                      <TableHead className="w-24">{t("community.colDifficulty")}</TableHead>
                    )}
                    <TableHead className="w-16 text-right">{t("community.colVotes")}</TableHead>
                    <TableHead className="w-24 text-right">{t("community.colStatus")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredQuestions.map((q) => {
                    const isSelected = q.id === selectedQuestionId;
                    return (
                      <TableRow
                        key={q.id}
                        data-testid={`community-question-row-${q.id}`}
                        aria-selected={isSelected}
                        data-answered={q.answered ? "true" : "false"}
                        className={`cursor-pointer ${
                          q.answered ? "opacity-60" : ""
                        } ${isSelected ? "bg-muted/60" : ""}`}
                        onClick={() => handleSelectQuestion(q.id)}
                      >
                        <TableCell className="max-w-[18rem]">
                          <span
                            className="text-sm line-clamp-2"
                            dangerouslySetInnerHTML={{ __html: processLatexContent(q.question) }}
                          />
                        </TableCell>
                        {showDifficulty && (
                          <TableCell>
                            <Badge
                              variant={difficultyVariant(q.difficulty)}
                              className="capitalize text-xs"
                            >
                              {q.difficulty
                                ? t(`common:difficulty.${q.difficulty}`, {
                                    defaultValue: q.difficulty,
                                  })
                                : t("community.difficultyMixed")}
                            </Badge>
                          </TableCell>
                        )}
                        <TableCell className="text-right">
                          {q.upvotes > 0 || q.downvotes > 0 ? (
                            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                              {q.upvotes - q.downvotes >= 0 ? (
                                <ThumbsUp className="w-3 h-3" />
                              ) : (
                                <ThumbsDown className="w-3 h-3" />
                              )}
                              {q.upvotes - q.downvotes}
                            </span>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          {q.answered ? (
                            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                              <CheckCircle2 className="w-3.5 h-3.5" />
                              {t("community.answered")}
                            </span>
                          ) : (
                            <Badge
                              variant="secondary"
                              className="text-[10px] uppercase tracking-wide"
                            >
                              {t("community.new")}
                            </Badge>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card className="order-1 lg:order-2 border-violet-500/20">
          <CardContent className="p-4 sm:p-6">
            {!selectedQuestion ? (
              <div className="flex flex-col items-center justify-center text-center py-10 space-y-3">
                <div className="w-12 h-12 rounded-full bg-violet-500/10 flex items-center justify-center">
                  <Users className="w-5 h-5 text-violet-500" />
                </div>
                <p className="text-sm text-muted-foreground max-w-xs">
                  {t("community.selectPrompt")}
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="flex items-center gap-2 flex-wrap">
                  {showDifficulty && (
                    <Badge
                      variant={difficultyVariant(selectedQuestion.difficulty)}
                      className="capitalize text-xs"
                    >
                      {selectedQuestion.difficulty
                        ? t(`common:difficulty.${selectedQuestion.difficulty}`, {
                            defaultValue: selectedQuestion.difficulty,
                          })
                        : t("community.difficultyMixed")}
                    </Badge>
                  )}
                  <Badge
                    variant="secondary"
                    className="bg-violet-500/10 text-violet-600 border-violet-500/20 text-xs"
                  >
                    {t("community.communityBadge")}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {t("community.byAuthor", {
                      author:
                        selectedQuestion.authorName ||
                        t("community.anonymous"),
                    })}
                  </span>
                </div>
                <h3
                  className="text-base sm:text-lg font-semibold"
                  dangerouslySetInnerHTML={{
                    __html: processLatexContent(
                      renderQuestionStem(selectedQuestion.question, selectedQuestion.multiCorrect),
                    ),
                  }}
                />
                <div className="space-y-2">
                  {selectedQuestion.options.map((option, index) => {
                    const isSelected = selectedAnswers.includes(index);
                    const isCorrect = selectedQuestion.correct_indices.includes(index);
                    const showCorrect = showResult && isCorrect;
                    const showWrong = showResult && isSelected && !isCorrect;
                    return (
                      <button
                        key={index}
                        type="button"
                        role="checkbox"
                        aria-checked={isSelected}
                        onClick={() => handleToggleAnswer(index)}
                        disabled={showResult}
                        className={`w-full p-3 rounded-lg border text-left transition-all ${
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
                            className={`w-5 h-5 rounded-md border-2 flex items-center justify-center flex-shrink-0 ${
                              isSelected ? "bg-primary border-primary text-primary-foreground" : "border-muted-foreground/30"
                            }`}
                            aria-hidden="true"
                          >
                            {isSelected && <CheckCircle2 className="w-3 h-3" />}
                          </span>
                          <span className="w-7 h-7 rounded-full bg-muted flex items-center justify-center text-xs font-medium">
                            {String.fromCharCode(65 + index)}
                          </span>
                          <span
                            className="flex-1 text-sm"
                            dangerouslySetInnerHTML={{
                              __html: processLatexContent(option),
                            }}
                          />
                        </div>
                      </button>
                    );
                  })}
                </div>
                {!showResult && (
                  <Button
                    onClick={handleSubmitAnswer}
                    disabled={selectedAnswers.length === 0 || submitting}
                    className="w-full"
                  >
                    {t("community.submitAnswer")}
                  </Button>
                )}
                {showResult && selectedQuestion.explanation && (
                  <div className="p-3 rounded-lg bg-muted">
                    <p className="text-sm font-medium mb-1">{t("community.explanation")}</p>
                    <p
                      className="text-sm text-muted-foreground"
                      dangerouslySetInnerHTML={{
                        __html: processLatexContent(selectedQuestion.explanation),
                      }}
                    />
                  </div>
                )}
                {showResult && (
                  <div
                    className="flex items-center justify-between p-3 rounded-lg bg-muted/30 border"
                    data-testid={`community-vote-bar-${selectedQuestion.id}`}
                  >
                    <span className="text-sm text-muted-foreground">
                      {t("community.helpfulPrompt")}
                    </span>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleVote(selectedQuestion.id, "up")}
                        disabled={votingQuestionId === selectedQuestion.id}
                        aria-pressed={userVotes[selectedQuestion.id] === "up"}
                        aria-label={t("community.thumbsUp")}
                        data-testid={`community-vote-up-${selectedQuestion.id}`}
                        className={`gap-1 ${
                          userVotes[selectedQuestion.id] === "up"
                            ? "text-green-600 bg-green-500/10"
                            : ""
                        }`}
                      >
                        <ThumbsUp
                          className={`w-4 h-4 ${
                            userVotes[selectedQuestion.id] === "up" ? "fill-current" : ""
                          }`}
                        />
                        <span className="text-xs">{selectedQuestion.upvotes}</span>
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleVote(selectedQuestion.id, "down")}
                        disabled={votingQuestionId === selectedQuestion.id}
                        aria-pressed={userVotes[selectedQuestion.id] === "down"}
                        aria-label={t("community.thumbsDown")}
                        data-testid={`community-vote-down-${selectedQuestion.id}`}
                        className={`gap-1 ${
                          userVotes[selectedQuestion.id] === "down"
                            ? "text-red-600 bg-red-500/10"
                            : ""
                        }`}
                      >
                        <ThumbsDown
                          className={`w-4 h-4 ${
                            userVotes[selectedQuestion.id] === "down" ? "fill-current" : ""
                          }`}
                        />
                        <span className="text-xs">{selectedQuestion.downvotes}</span>
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

export default CommunityQuestions;
