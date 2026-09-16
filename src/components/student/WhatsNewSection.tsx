import { useState, useEffect } from "react";
import { Sparkles, BookOpen, FileText, Layers, MessageSquare, ClipboardList, X, ChevronDown, ChevronUp } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { formatDistanceToNow } from "date-fns";
import { useTranslation } from "react-i18next";
import { useDateFnsLocale } from "@/i18n/formatters";

interface NewItem {
  id: string;
  type: 'study_session' | 'material' | 'flashcard' | 'question' | 'quiz' | 'open_question';
  /** A name taken from the data — a quiz or session title. */
  title?: string;
  /**
   * A counted row instead of a named one ("3 new practice questions"). Held as
   * a key and a count rather than a built sentence: the plural rule belongs in
   * the catalog, and this fetch has no locale.
   */
  titleKey?: string;
  count?: number;
  createdAt: string;
}

interface WhatsNewSectionProps {
  courseId: string;
  userId: string;
  offeringId?: string | null;
}

export function WhatsNewSection({ courseId, userId, offeringId }: WhatsNewSectionProps) {
  const { t } = useTranslation("student");
  const dateFnsLocale = useDateFnsLocale();
  const [newItems, setNewItems] = useState<NewItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [isDismissed, setIsDismissed] = useState(false);
  const [isCollapsed, setIsCollapsed] = useState(true);
  const [lastLoginAt, setLastLoginAt] = useState<string | null>(null);

  useEffect(() => {
    fetchNewContent();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch on courseId/userId/offeringId change
  }, [courseId, userId, offeringId]);

  const fetchNewContent = async () => {
    try {
      // Get the user's second-to-last login (before current session)
      const { data: loginHistory } = await supabase
        .from("login_history")
        .select("login_at")
        .eq("user_id", userId)
        .order("login_at", { ascending: false })
        .limit(2);

      // Use second-to-last login, or fall back to 7 days ago if no history
      let lastLogin: string;
      if (loginHistory && loginHistory.length >= 2) {
        lastLogin = loginHistory[1].login_at;
      } else if (loginHistory && loginHistory.length === 1) {
        // First login ever - show content from last 7 days
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
        lastLogin = sevenDaysAgo.toISOString();
      } else {
        // No login history - show content from last 7 days
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
        lastLogin = sevenDaysAgo.toISOString();
      }

      setLastLoginAt(lastLogin);

      const items: NewItem[] = [];

      // Fetch new study sessions
      if (offeringId) {
        const { data: studySessions } = await supabase
          .from("offering_study_sessions")
          .select(`
            published_at,
            study_sessions!inner (
              id,
              title
            )
          `)
          .eq("offering_id", offeringId)
          .not("published_at", "is", null)
          .gt("published_at", lastLogin);

        if (studySessions) {
          studySessions.forEach((s: any) => {
            items.push({
              id: s.study_sessions.id,
              type: 'study_session',
              title: s.study_sessions.title || 'Tutoring Session',
              createdAt: s.published_at,
            });
          });
        }
      } else {
        const { data: studySessions } = await supabase
          .from("study_sessions")
          .select("id, title, created_at")
          .eq("course_id", courseId)
          .eq("status", "ready")
          .gt("created_at", lastLogin);

        if (studySessions) {
          studySessions.forEach((s) => {
            items.push({
              id: s.id,
              type: 'study_session',
              title: s.title || t('whatsNew.fallbackTutoringSession'),
              createdAt: s.created_at,
            });
          });
        }
      }

      // Fetch new quizzes.
      //
      // Only ever through the offering: a quiz reaches a student by being
      // assigned and published to their offering, so with no offering there
      // is no new quiz to report. The old fallback listed every quiz in the
      // course with `is_published` set — which is course-wide, not a grant to
      // this student — and so announced titles of sets assigned to nobody, to
      // another cluster, or still awaiting release.
      if (offeringId) {
        const { data: quizzes } = await supabase
          .from("offering_quizzes")
          .select(`
            published_at,
            quizzes!inner (
              id,
              title
            )
          `)
          .eq("offering_id", offeringId)
          .not("published_at", "is", null)
          .gt("published_at", lastLogin);

        if (quizzes) {
          quizzes.forEach((q: any) => {
            items.push({
              id: q.quizzes.id,
              type: 'quiz',
              title: q.quizzes.title || t('whatsNew.fallbackQuiz'),
              createdAt: q.published_at,
            });
          });
        }
      }

      // Fetch new questions (practice)
      if (offeringId) {
        // After #582 open + MCQ questions share `offering_questions`. Filter
        // by joined `questions.type='mcq'` so the practice/AI counts stay
        // separate in the feed.
        const { data: questions } = await supabase
          .from("offering_questions")
          .select("published_at, question_id, questions!inner(type)")
          .eq("offering_id", offeringId)
          .eq("questions.type", "mcq")
          .not("published_at", "is", null)
          .gt("published_at", lastLogin);

        if (questions && questions.length > 0) {
          items.push({
            id: 'new-questions',
            type: 'question',
            titleKey: 'whatsNew.newPracticeQuestions',
            count: questions.length,
            createdAt: questions[0].published_at!,
          });
        }
      } else {
        const { data: questions } = await supabase
          .from("questions")
          .select("id, created_at")
          .eq("course_id", courseId)
          .eq("hidden", false)
          .eq("is_user_generated", false)
          .gt("created_at", lastLogin);

        if (questions && questions.length > 0) {
          items.push({
            id: 'new-questions',
            type: 'question',
            titleKey: 'whatsNew.newPracticeQuestions',
            count: questions.length,
            createdAt: questions[0].created_at,
          });
        }
      }

      // Fetch new open questions (AI practice) — after #582 they share the
      // `offering_questions` table with MCQ; filter by joined type.
      if (offeringId) {
        const { data: openQuestions } = await supabase
          .from("offering_questions")
          .select("published_at, question_id, questions!inner(type)")
          .eq("offering_id", offeringId)
          .eq("questions.type", "open")
          .not("published_at", "is", null)
          .gt("published_at", lastLogin);

        if (openQuestions && openQuestions.length > 0) {
          items.push({
            id: 'new-open-questions',
            type: 'open_question',
            titleKey: 'whatsNew.newAiQuestions',
            count: openQuestions.length,
            createdAt: openQuestions[0].published_at!,
          });
        }
      } else {
        // Fallback (no offering): read open questions from the unified
        // `questions` table filtered by `type='open'` (#580).
        const { data: openQuestions } = await supabase
          .from("questions")
          .select("id, created_at")
          .eq("course_id", courseId)
          .eq("type", "open")
          .eq("hidden", false)
          .gt("created_at", lastLogin);

        if (openQuestions && openQuestions.length > 0) {
          items.push({
            id: 'new-open-questions',
            type: 'open_question',
            titleKey: 'whatsNew.newAiQuestions',
            count: openQuestions.length,
            createdAt: openQuestions[0].created_at,
          });
        }
      }

      // Sort by creation date, newest first
      items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

      setNewItems(items);
    } catch (error) {
      console.error("Error fetching new content:", error);
    } finally {
      setLoading(false);
    }
  };

  const getItemIcon = (type: NewItem['type']) => {
    switch (type) {
      case 'study_session':
        return <BookOpen className="h-4 w-4" />;
      case 'material':
        return <FileText className="h-4 w-4" />;
      case 'flashcard':
        return <Layers className="h-4 w-4" />;
      case 'question':
        return <ClipboardList className="h-4 w-4" />;
      case 'quiz':
        return <ClipboardList className="h-4 w-4" />;
      case 'open_question':
        return <MessageSquare className="h-4 w-4" />;
      default:
        return <Sparkles className="h-4 w-4" />;
    }
  };

  const getItemBadge = (type: NewItem['type']) => t(`whatsNew.badge.${type}`);

  /** A named row renders its name; a counted one is translated here. */
  const itemTitle = (item: NewItem) =>
    item.titleKey ? t(item.titleKey, { count: item.count ?? 0 }) : (item.title ?? '');

  if (loading || isDismissed || newItems.length === 0) {
    return null;
  }

  return (
    <Card className="bg-gradient-to-r from-primary/5 to-secondary/5 border-primary/20 mb-6">
      <CardHeader className={isCollapsed ? "pb-4" : "pb-2"}>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <Sparkles className="h-5 w-5 text-primary" />
            {t('whatsNew.title')}
            <Badge variant="secondary" className="ml-1">
              {newItems.length}
            </Badge>
          </CardTitle>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => setIsCollapsed(!isCollapsed)}
            >
              {isCollapsed ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronUp className="h-4 w-4" />
              )}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => setIsDismissed(true)}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>
        {lastLoginAt && !isCollapsed && (
          <p className="text-xs text-muted-foreground">
            {t('whatsNew.since', {
              distance: formatDistanceToNow(new Date(lastLoginAt), {
                addSuffix: true,
                locale: dateFnsLocale,
              }),
            })}
          </p>
        )}
      </CardHeader>
      {!isCollapsed && (
        <CardContent className="pt-0">
          <div className="space-y-2">
            {newItems.slice(0, 5).map((item) => (
              <div
                key={item.id}
                className="flex items-center gap-3 p-2 rounded-md bg-background/50 hover:bg-background/80 transition-colors"
              >
                <div className="p-1.5 rounded bg-primary/10 text-primary">
                  {getItemIcon(item.type)}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{itemTitle(item)}</p>
                  <p className="text-xs text-muted-foreground">
                    {formatDistanceToNow(new Date(item.createdAt), {
                      addSuffix: true,
                      locale: dateFnsLocale,
                    })}
                  </p>
                </div>
                <Badge variant="outline" className="text-xs shrink-0">
                  {getItemBadge(item.type)}
                </Badge>
              </div>
            ))}
            {newItems.length > 5 && (
              <p className="text-xs text-muted-foreground text-center pt-1">
                {t('whatsNew.more', { count: newItems.length - 5 })}
              </p>
            )}
          </div>
        </CardContent>
      )}
    </Card>
  );
}
