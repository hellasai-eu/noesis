import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ThumbsUp, ThumbsDown, Loader2, AlertCircle, Target } from "lucide-react";
import { processLatexContent } from "@/lib/latex-utils";

interface QuestionFeedbackProps {
  courseId: string;
  offeringId?: string;
}

interface QuestionWithFeedback {
  id: string;
  question: string;
  difficulty: string;
  upvotes: number;
  downvotes: number;
  netScore: number;
  hidden: boolean;
  successRate: number | null; // null if no attempts
  totalAttempts: number;
}

const QuestionFeedback = ({ courseId, offeringId }: QuestionFeedbackProps) => {
  const [loading, setLoading] = useState(true);
  const [mostUpvoted, setMostUpvoted] = useState<QuestionWithFeedback[]>([]);
  const [mostDownvoted, setMostDownvoted] = useState<QuestionWithFeedback[]>([]);

  useEffect(() => {
    fetchQuestionFeedback();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch on courseId/offeringId change
  }, [courseId, offeringId]);

  const fetchQuestionFeedback = async () => {
    setLoading(true);
    try {
      // Get all questions for this course
      const { data: questions, error: questionsError } = await supabase
        .from("questions")
        .select("id, question, difficulty, hidden")
        .eq("course_id", courseId);

      if (questionsError) throw questionsError;

      if (!questions || questions.length === 0) {
        setMostUpvoted([]);
        setMostDownvoted([]);
        setLoading(false);
        return;
      }

      const questionIds = questions.map(q => q.id);

      // If filtering by class, get the user IDs in that class
      let userIdsInClass: string[] | null = null;
      if (offeringId) {
        const { data: offering } = await supabase
          .from("offerings")
          .select("class_id")
          .eq("id", offeringId)
          .maybeSingle();

        if (offering) {
          const { data: enrollments } = await supabase
            .from("class_enrollments")
            .select("user_id")
            .eq("class_id", offering.class_id);

          userIdsInClass = (enrollments || []).map(e => e.user_id);
        }
      }

      // Fetch votes
      const votesQuery = supabase
        .from("question_votes")
        .select("question_id, vote_type, user_id")
        .in("question_id", questionIds);

      const { data: votes, error: votesError } = await votesQuery;

      if (votesError) throw votesError;

      // Filter votes by class users if needed
      const filteredVotes = userIdsInClass
        ? (votes || []).filter(v => userIdsInClass!.includes(v.user_id))
        : votes || [];

      // Calculate vote counts per question
      const voteCounts: Record<string, { up: number; down: number }> = {};
      filteredVotes.forEach(v => {
        if (!voteCounts[v.question_id]) {
          voteCounts[v.question_id] = { up: 0, down: 0 };
        }
        if (v.vote_type === "up") {
          voteCounts[v.question_id].up++;
        } else {
          voteCounts[v.question_id].down++;
        }
      });

      // Fetch quiz answers to calculate success rate
      const answersQuery = supabase
        .from("quiz_answers")
        .select("question_id, is_correct, user_id")
        .in("question_id", questionIds);

      const { data: answers, error: answersError } = await answersQuery;

      if (answersError) throw answersError;

      // Filter answers by class users if needed
      const filteredAnswers = userIdsInClass
        ? (answers || []).filter(a => userIdsInClass!.includes(a.user_id))
        : answers || [];

      // Calculate success rate per question
      const answerStats: Record<string, { correct: number; total: number }> = {};
      filteredAnswers.forEach(a => {
        if (!answerStats[a.question_id]) {
          answerStats[a.question_id] = { correct: 0, total: 0 };
        }
        answerStats[a.question_id].total++;
        if (a.is_correct) {
          answerStats[a.question_id].correct++;
        }
      });

      // Build question list with feedback
      const questionsWithFeedback: QuestionWithFeedback[] = questions.map(q => {
        const stats = answerStats[q.id];
        return {
          id: q.id,
          question: q.question,
          difficulty: q.difficulty,
          hidden: q.hidden,
          upvotes: voteCounts[q.id]?.up || 0,
          downvotes: voteCounts[q.id]?.down || 0,
          netScore: (voteCounts[q.id]?.up || 0) - (voteCounts[q.id]?.down || 0),
          successRate: stats && stats.total > 0 ? Math.round((stats.correct / stats.total) * 100) : null,
          totalAttempts: stats?.total || 0,
        };
      });

      // Sort for most upvoted (highest net score first)
      const upvotedSorted = [...questionsWithFeedback]
        .filter(q => q.upvotes > 0 || q.downvotes > 0)
        .sort((a, b) => b.netScore - a.netScore)
        .slice(0, 20);

      // Sort for most downvoted (lowest net score first, must have downvotes)
      const downvotedSorted = [...questionsWithFeedback]
        .filter(q => q.downvotes > 0)
        .sort((a, b) => a.netScore - b.netScore)
        .slice(0, 20);

      setMostUpvoted(upvotedSorted);
      setMostDownvoted(downvotedSorted);
    } catch (error) {
      console.error("Error fetching question feedback:", error);
    } finally {
      setLoading(false);
    }
  };

  const renderQuestionList = (questions: QuestionWithFeedback[], emptyMessage: string) => {
    if (questions.length === 0) {
      return (
        <div className="text-center py-8 text-muted-foreground">
          <AlertCircle className="w-8 h-8 mx-auto mb-2 opacity-50" />
          <p>{emptyMessage}</p>
        </div>
      );
    }

    return (
      <div className="space-y-3">
        {questions.map((q, index) => (
          <Card key={q.id} className="overflow-hidden">
            <CardContent className="p-4">
              <div className="flex items-start gap-4">
                <div className="flex flex-col items-center gap-1 min-w-[60px]">
                  <span className="text-sm font-medium text-muted-foreground">#{index + 1}</span>
                  <div className="flex items-center gap-2">
                    <div className="flex items-center gap-1 text-green-600">
                      <ThumbsUp className="w-4 h-4" />
                      <span className="text-sm font-medium">{q.upvotes}</span>
                    </div>
                    <div className="flex items-center gap-1 text-red-600">
                      <ThumbsDown className="w-4 h-4" />
                      <span className="text-sm font-medium">{q.downvotes}</span>
                    </div>
                  </div>
                </div>
                <div className="flex-1 min-w-0">
                  <p 
                    className="text-sm line-clamp-2"
                    dangerouslySetInnerHTML={{ __html: processLatexContent(q.question) }}
                  />
                  <div className="flex items-center gap-2 mt-2 flex-wrap">
                    <Badge variant="outline" className="text-xs capitalize">
                      {q.difficulty}
                    </Badge>
                    <Badge
                      variant="outline"
                      className={`text-xs ${
                        q.hidden
                          ? "bg-amber-500/10 text-amber-600 border-amber-500/20"
                          : "bg-green-500/10 text-green-600 border-green-500/20"
                      }`}
                    >
                      {q.hidden ? "Draft" : "Available"}
                    </Badge>
                    <Badge
                      variant="outline"
                      className={`text-xs ${
                        q.netScore > 0
                          ? "bg-green-500/10 text-green-600 border-green-500/20"
                          : q.netScore < 0
                          ? "bg-red-500/10 text-red-600 border-red-500/20"
                          : "bg-muted"
                      }`}
                    >
                      Net: {q.netScore > 0 ? "+" : ""}{q.netScore}
                    </Badge>
                    {q.successRate !== null && (
                      <Badge
                        variant="outline"
                        className={`text-xs flex items-center gap-1 ${
                          q.successRate >= 70
                            ? "bg-green-500/10 text-green-600 border-green-500/20"
                            : q.successRate >= 40
                            ? "bg-amber-500/10 text-amber-600 border-amber-500/20"
                            : "bg-red-500/10 text-red-600 border-red-500/20"
                        }`}
                      >
                        <Target className="w-3 h-3" />
                        {q.successRate}% ({q.totalAttempts})
                      </Badge>
                    )}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    );
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ThumbsUp className="w-5 h-5" />
          Question Feedback
        </CardTitle>
        <CardDescription>
          See which questions students find helpful or problematic based on their votes
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="upvoted" className="w-full">
          <TabsList className="mb-4">
            <TabsTrigger value="upvoted" className="flex items-center gap-2">
              <ThumbsUp className="w-4 h-4" />
              Most Liked ({mostUpvoted.length})
            </TabsTrigger>
            <TabsTrigger value="downvoted" className="flex items-center gap-2">
              <ThumbsDown className="w-4 h-4" />
              Most Disliked ({mostDownvoted.length})
            </TabsTrigger>
          </TabsList>

          <TabsContent value="upvoted">
            {renderQuestionList(mostUpvoted, "No upvoted questions yet")}
          </TabsContent>

          <TabsContent value="downvoted">
            {renderQuestionList(mostDownvoted, "No downvoted questions yet")}
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
};

export default QuestionFeedback;
