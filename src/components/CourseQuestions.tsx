import { useState, useEffect, useMemo, useCallback } from "react";
import { useContentAssignments } from "@/hooks/useContentAssignments";
import { ContentAssignDialog } from "./ContentAssignDialog";
import type { CourseClass } from "@/types/content-assignments";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  HelpCircle,
  Sparkles,
  Loader2,
  Upload,
} from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { fetchAuthorNames } from "@/lib/author-names";
import { QuestionsTable } from "./QuestionsTable";
import { SimilarityCheckDialog } from "./SimilarityCheckDialog";
import { GenerateMcqDialog } from "./GenerateMcqDialog";
import {
  mcqCorrectIndicesFromAnswerKey,
  mcqOptionsFromPayload,
} from "@/lib/question-payload";

interface CourseMaterial {
  id: string;
  file_name: string;
  title: string | null;
}

interface ChapterReference {
  id: string;
  title: string;
  materialId: string;
  materialTitle: string;
}

interface Question {
  id: string;
  question: string;
  options: string[];
  correctIndices: number[];
  explanation: string;
  difficulty: "easy" | "medium" | "hard";
  chapters: ChapterReference[];
  upvotes: number;
  downvotes: number;
  hidden: boolean;
  createdAt?: string;
  totalAnswers?: number;
  correctAnswers?: number;
  incorrectAnswers?: number;
  isUserGenerated?: boolean;
  createdBy?: string | null;
  authorName?: string | null;
  competencies?: { id: string; title: string }[];
  validationStatus?: "CORRECT" | "PARTIALLY_CORRECT" | "INCORRECT" | "INSUFFICIENT_INFORMATION" | null;
  validationConfidence?: number | null;
  validationMessage?: string | null;
  validatedAt?: string | null;
  /**
   * Populated by the mapper below and read by `QuestionsTable`, which declares
   * it on its own `Question`. It was missing here, so the assignment was an
   * excess property the compiler would have rejected had it been running.
   */
  generationRationale?: string | null;
}

interface DbQuestion {
  id: string;
  course_id: string;
  question: string;
  payload: any;
  answer_key: any;
  explanation: string | null;
  difficulty: string;
  upvotes: number;
  downvotes: number;
  hidden: boolean;
  created_at: string;
  is_user_generated: boolean;
  created_by: string | null;
  validation_status: string | null;
  validation_confidence: number | null;
  validation_message: string | null;
  validated_at: string | null;
  generation_rationale: string | null;
}

interface CourseQuestionsProps {
  courseId: string;
  materials: CourseMaterial[];
  isAdmin: boolean;
  classes?: CourseClass[];
}

const mapDbToQuestion = (db: DbQuestion): Question => ({
  id: db.id,
  question: db.question,
  options: mcqOptionsFromPayload(db.payload),
  correctIndices: mcqCorrectIndicesFromAnswerKey(db.answer_key),
  explanation: db.explanation || "",
  difficulty: db.difficulty as "easy" | "medium" | "hard",
  chapters: [],
  upvotes: db.upvotes,
  downvotes: db.downvotes,
  hidden: db.hidden,
  createdAt: db.created_at,
  isUserGenerated: db.is_user_generated,
  createdBy: db.created_by,
  validationStatus: db.validation_status as Question["validationStatus"],
  validationConfidence: db.validation_confidence,
  validationMessage: db.validation_message,
  validatedAt: db.validated_at,
  generationRationale: db.generation_rationale,
});

const CourseQuestions = ({ courseId, materials, isAdmin, classes = [] }: CourseQuestionsProps) => {
  const [questions, setQuestions] = useState<Question[]>([]);
  const [loading, setLoading] = useState(true);
  const [generateDialogOpen, setGenerateDialogOpen] = useState(false);

  // Content assignment state
  const questionIds = useMemo(() => questions.map(q => q.id), [questions]);
  const contentAssignments = useContentAssignments('mcq_question', questionIds, classes);
  const [assignDialogOpen, setAssignDialogOpen] = useState(false);
  const [assignTargetIds, setAssignTargetIds] = useState<string[]>([]);
  const [assignIsBulk, setAssignIsBulk] = useState(false);

  const handleOpenAssignDialog = useCallback((questionId: string) => {
    setAssignTargetIds([questionId]);
    setAssignIsBulk(false);
    setAssignDialogOpen(true);
  }, []);

  const handleBulkAssign = useCallback((questionIds: string[]) => {
    setAssignTargetIds(questionIds);
    setAssignIsBulk(true);
    setAssignDialogOpen(true);
  }, []);

  const handleSaveAssign = useCallback(async (selection: Set<string> | import("@/types/content-assignments").AssignSelection) => {
    await contentAssignments.saveAssignments(assignTargetIds, selection, assignIsBulk);
    setAssignDialogOpen(false);
  }, [contentAssignments, assignTargetIds, assignIsBulk]);

  useEffect(() => {
    fetchQuestions();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch on courseId change
  }, [courseId]);

  const fetchQuestions = async () => {
    try {
      const { data, error } = await supabase
        .from("questions")
        .select("*")
        .eq("course_id", courseId)
        .order("created_at", { ascending: false });

      if (error) throw error;

      // Fetch vote counts for all questions
      const questionIds = (data || []).map((q: any) => q.id);
      const voteCounts: Record<string, { up: number; down: number }> = {};
      const answerStats: Record<string, { total: number; correct: number; incorrect: number }> = {};
      const competencyMap: Record<string, { id: string; title: string }[]> = {};

      if (questionIds.length > 0) {
        // Fetch votes
        const { data: votes } = await supabase
          .from("question_votes")
          .select("question_id, vote_type")
          .in("question_id", questionIds);

        (votes || []).forEach((v: any) => {
          if (!voteCounts[v.question_id]) {
            voteCounts[v.question_id] = { up: 0, down: 0 };
          }
          if (v.vote_type === 'up') {
            voteCounts[v.question_id].up++;
          } else {
            voteCounts[v.question_id].down++;
          }
        });

        // Fetch answer statistics
        const { data: answers } = await supabase
          .from("quiz_answers")
          .select("question_id, is_correct")
          .in("question_id", questionIds);

        (answers || []).forEach((a: any) => {
          if (!answerStats[a.question_id]) {
            answerStats[a.question_id] = { total: 0, correct: 0, incorrect: 0 };
          }
          answerStats[a.question_id].total++;
          if (a.is_correct) {
            answerStats[a.question_id].correct++;
          } else {
            answerStats[a.question_id].incorrect++;
          }
        });

        // Fetch competencies from junction table
        const { data: questionCompetencies } = await supabase
          .from("question_competencies")
          .select(`
            question_id,
            competency_id,
            course_competencies!inner(id, title)
          `)
          .in("question_id", questionIds);

        (questionCompetencies || []).forEach((qc: any) => {
          if (!competencyMap[qc.question_id]) {
            competencyMap[qc.question_id] = [];
          }
          competencyMap[qc.question_id].push({
            id: qc.course_competencies.id,
            title: qc.course_competencies.title,
          });
        });
      }

      // Fetch chapters from junction table (with material info for book filter + display)
      const chapterMap: Record<string, ChapterReference[]> = {};

      if (questionIds.length > 0) {
        const { data: questionChapters } = await supabase
          .from("question_chapters")
          .select(`
            question_id,
            chapter_id,
            material_chapters!inner(
              id,
              title,
              material_id,
              course_materials!inner(id, title, file_name)
            )
          `)
          .in("question_id", questionIds);

        (questionChapters || []).forEach((qc: any) => {
          const ch = qc.material_chapters;
          const mat = ch?.course_materials;
          if (!ch || !mat) return;
          if (!chapterMap[qc.question_id]) {
            chapterMap[qc.question_id] = [];
          }
          chapterMap[qc.question_id].push({
            id: ch.id,
            title: ch.title,
            materialId: mat.id,
            materialTitle: mat.title || mat.file_name || "Unknown",
          });
        });
      }

      // Resolve author names from created_by UUIDs
      const typedData = data as unknown as DbQuestion[];
      const creatorIds = [...new Set(typedData.filter(q => q.created_by).map(q => q.created_by as string))];
      let authorMap: Record<string, string> = {};

      if (creatorIds.length > 0) {
        authorMap = await fetchAuthorNames(creatorIds);
      }

      // Merge vote counts + answer stats + competencies + chapters + author names
      setQuestions(typedData.map(q => ({
        ...mapDbToQuestion(q),
        upvotes: voteCounts[q.id]?.up || 0,
        downvotes: voteCounts[q.id]?.down || 0,
        totalAnswers: answerStats[q.id]?.total || 0,
        correctAnswers: answerStats[q.id]?.correct || 0,
        incorrectAnswers: answerStats[q.id]?.incorrect || 0,
        competencies: competencyMap[q.id] || [],
        chapters: chapterMap[q.id] || [],
        authorName: q.created_by ? (authorMap[q.created_by] || "Unknown") : null,
      })));
    } catch (error: any) {
      console.error("Error fetching questions:", error);
      toast.error("Failed to load questions");
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="py-12">
          <div className="flex items-center justify-center">
            <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <>
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <HelpCircle className="w-5 h-5" />
            Questions
            {questions.length > 0 && (
              <span className="text-sm font-normal text-muted-foreground">
                ({questions.length} total)
              </span>
            )}
          </CardTitle>
          <div className="flex items-center gap-2">
            {isAdmin && questions.length >= 2 && (
              <SimilarityCheckDialog
                courseId={courseId}
                onQuestionAction={(questionId, action) => {
                  if (action === "delete") {
                    setQuestions(prev => prev.filter(q => q.id !== questionId));
                  } else if (action === "hide") {
                    setQuestions(prev => prev.map(q =>
                      q.id === questionId ? { ...q, hidden: true } : q
                    ));
                  }
                }}
              />
            )}
            {isAdmin && (
              <Button onClick={() => setGenerateDialogOpen(true)}>
                <Sparkles className="w-4 h-4 mr-2" />
                Generate Questions
              </Button>
            )}
            {isAdmin && (
              <Button variant="outline" disabled className="opacity-60 h-auto py-2 flex-col items-center">
                <span className="flex items-center">
                  <Upload className="w-4 h-4 mr-2" />
                  Import from PDF
                </span>
                <Badge variant="secondary" className="text-[10px] mt-1">Coming Soon</Badge>
              </Button>
            )}
          </div>
        </div>
        <CardDescription>
          Practice questions based on course materials
        </CardDescription>
      </CardHeader>
      <CardContent>
        {questions.length === 0 ? (
          <div className="py-12 text-center">
            <HelpCircle className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
            <p className="text-muted-foreground mb-2">No questions generated yet</p>
            {isAdmin && (
              <p className="text-sm text-muted-foreground">
                Click "Generate Questions" to create practice questions
              </p>
            )}
          </div>
        ) : (
          <QuestionsTable
            questions={questions}
            onQuestionsChange={setQuestions}
            isAdmin={isAdmin}
            courseId={courseId}
            classes={classes.length > 0 ? classes : undefined}
            assignmentsByQuestionId={classes.length > 0 ? contentAssignments.assignments : undefined}
            groupsByOffering={classes.length > 0 ? contentAssignments.groupsByOffering : undefined}
            onOpenAssignDialog={classes.length > 0 ? handleOpenAssignDialog : undefined}
            onBulkAssign={classes.length > 0 ? handleBulkAssign : undefined}
          />
        )}
      </CardContent>
    </Card>

    {isAdmin && (
      <GenerateMcqDialog
        open={generateDialogOpen}
        onOpenChange={setGenerateDialogOpen}
        courseId={courseId}
        classes={classes}
        groupsByOffering={contentAssignments.groupsByOffering}
        onGenerated={fetchQuestions}
      />
    )}

    {classes.length > 0 && (
      <ContentAssignDialog
        open={assignDialogOpen}
        onOpenChange={setAssignDialogOpen}
        classes={classes}
        currentAssignedTargets={
          !assignIsBulk && assignTargetIds.length === 1
            ? contentAssignments.getAssignedTargets(assignTargetIds[0])
            : []
        }
        groupsByOffering={contentAssignments.groupsByOffering}
        onSave={handleSaveAssign}
        saving={contentAssignments.saving}
        title={assignIsBulk ? `Assign ${assignTargetIds.length} Questions to Classes` : "Assign to Classes"}
      />
    )}
    </>
  );
};

export default CourseQuestions;
