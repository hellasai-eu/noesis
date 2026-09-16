/**
 * CourseEvaluationsReport (#669) — top-level instructor/admin report surface
 * that reads `question_evaluations` + `question_evaluation_sessions` for a
 * course and renders the per-question + per-session views.
 *
 * Read-only by construction: every Supabase call here is `.select(...)`, and
 * the report makes no reference to `questions.validation_status` (the AI
 * validation layer is fully decoupled per epic #663).
 *
 * RLS already lets course instructors/admins SELECT both tables; if the
 * caller is not authorized, the queries simply return empty arrays.
 */
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent } from "@/components/ui/card";
import { Loader2, ListChecks, History } from "lucide-react";
import { useUnifiedQuestions } from "@/hooks/useUnifiedQuestions";
import {
  aggregateByQuestion,
  type EvaluationRow,
} from "./aggregate";
import { CourseEvaluationsQuestionsTab } from "./CourseEvaluationsQuestionsTab";
import {
  CourseEvaluationsSessionsTab,
  type SessionRow,
} from "./CourseEvaluationsSessionsTab";
import { useFormatters } from "@/i18n/formatters";

interface CourseEvaluationsReportProps {
  courseId: string;
}

export function CourseEvaluationsReport({ courseId }: CourseEvaluationsReportProps) {
  const { compareText } = useFormatters();
  const { questions, loading: questionsLoading } = useUnifiedQuestions(courseId);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [evaluations, setEvaluations] = useState<EvaluationRow[]>([]);
  const [evaluatorNameById, setEvaluatorNameById] = useState<Map<string, string>>(
    new Map(),
  );
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      try {
        const { data: sessionRows, error: sessionsErr } = await supabase
          .from("question_evaluation_sessions")
          .select("*")
          .eq("course_id", courseId)
          .order("started_at", { ascending: false });
        if (sessionsErr) throw sessionsErr;

        const sessionIds = (sessionRows ?? []).map((s) => s.id);
        let evalRows: EvaluationRow[] = [];
        if (sessionIds.length > 0) {
          const { data: evals, error: evalsErr } = await supabase
            .from("question_evaluations")
            .select("*")
            .in("session_id", sessionIds);
          if (evalsErr) throw evalsErr;
          evalRows = (evals ?? []) as EvaluationRow[];
        }

        // Resolve evaluator display names in one round-trip across the union
        // of session evaluators + evaluation evaluators (a session may exist
        // with zero evaluations, and vice versa once the data is wide).
        const evaluatorIds = Array.from(
          new Set([
            ...((sessionRows ?? []).map((s) => s.evaluator_id) as string[]),
            ...evalRows.map((e) => e.evaluator_id),
          ]),
        );
        const nameMap = new Map<string, string>();
        if (evaluatorIds.length > 0) {
          const { data: profiles } = await supabase
            .from("profiles")
            .select("user_id, full_name")
            .in("user_id", evaluatorIds);
          for (const p of profiles ?? []) {
            const row = p as { user_id: string; full_name: string | null };
            nameMap.set(row.user_id, row.full_name || "Unknown");
          }
        }

        if (cancelled) return;
        setSessions((sessionRows ?? []) as SessionRow[]);
        setEvaluations(evalRows);
        setEvaluatorNameById(nameMap);
      } catch (err) {
        console.error("Failed to load course evaluations report", err);
        if (!cancelled) toast.error("Failed to load evaluations");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [courseId]);

  const aggregatesByQuestionId = useMemo(
    () => aggregateByQuestion(evaluations),
    [evaluations],
  );

  const rowsByQuestionId = useMemo(() => {
    const m = new Map<string, EvaluationRow[]>();
    for (const r of evaluations) {
      const list = m.get(r.question_id) ?? [];
      list.push(r);
      m.set(r.question_id, list);
    }
    // Stable order: newest evaluation first per question.
    for (const [k, list] of m) {
      list.sort((a, b) => compareText(b.created_at, a.created_at));
      m.set(k, list);
    }
    return m;
  }, [evaluations, compareText]);

  const evaluationsCountBySession = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of evaluations) {
      m.set(r.session_id, (m.get(r.session_id) ?? 0) + 1);
    }
    return m;
  }, [evaluations]);

  if (loading || questionsLoading) {
    return (
      <Card className="py-10">
        <CardContent className="flex justify-center">
          <Loader2 className="w-6 h-6 animate-spin text-primary" />
        </CardContent>
      </Card>
    );
  }

  const hasAny = sessions.length > 0 || evaluations.length > 0;
  if (!hasAny) {
    return (
      <Card className="py-12">
        <CardContent className="text-center text-sm text-muted-foreground">
          Δεν υπάρχουν αξιολογήσεις ακόμη για αυτό το μάθημα.
        </CardContent>
      </Card>
    );
  }

  return (
    <Tabs defaultValue="questions" className="w-full">
      <TabsList className="mb-4">
        <TabsTrigger value="questions" className="flex items-center gap-2">
          <ListChecks className="w-4 h-4" />
          Questions
        </TabsTrigger>
        <TabsTrigger value="sessions" className="flex items-center gap-2">
          <History className="w-4 h-4" />
          Sessions
        </TabsTrigger>
      </TabsList>
      <TabsContent value="questions">
        <CourseEvaluationsQuestionsTab
          questions={questions}
          rowsByQuestionId={rowsByQuestionId}
          aggregatesByQuestionId={aggregatesByQuestionId}
          evaluatorNameById={evaluatorNameById}
        />
      </TabsContent>
      <TabsContent value="sessions">
        <CourseEvaluationsSessionsTab
          sessions={sessions}
          evaluatorNameById={evaluatorNameById}
          evaluationsCountBySession={evaluationsCountBySession}
        />
      </TabsContent>
    </Tabs>
  );
}
