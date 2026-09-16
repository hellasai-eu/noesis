import { ClipboardCheck, Clock, CheckCircle, AlertCircle, Play, Lock, XCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatDistanceToNow, isPast, isFuture } from "date-fns";
import { useDateFnsLocale } from "@/i18n/formatters";

export interface QuizAssignment {
  id: string;
  quizId: string;
  title: string;
  questionCount: number;
  timeLimit: number | null;
  dueDate: string | null;
  publishedAt: string | null;
  status: 'not_started' | 'in_progress' | 'completed';
  score?: number;
  totalPoints?: number;
  submittedAt?: string;
  showAnswers?: boolean;
  closedAt?: string | null;
}

interface AssessTabProps {
  quizzes: QuizAssignment[];
  onTakeQuiz: (quizId: string) => void;
  onViewResults: (quizId: string) => void;
}

export function AssessTab({ quizzes, onTakeQuiz, onViewResults }: AssessTabProps) {
  const { t } = useTranslation("student");
  const dateLocale = useDateFnsLocale();

  const upcomingQuizzes = quizzes.filter(q =>
    !q.closedAt && q.status === 'not_started' && q.dueDate && isFuture(new Date(q.dueDate))
  );
  const availableQuizzes = quizzes.filter(q =>
    !q.closedAt && (q.status === 'not_started' || q.status === 'in_progress')
  );
  const completedQuizzes = quizzes.filter(q => q.status === 'completed');
  const closedQuizzes = quizzes.filter(q => !!q.closedAt && q.status !== 'completed');

  const getStatusBadge = (quiz: QuizAssignment) => {
    if (quiz.closedAt && quiz.status !== 'completed') {
      return (
        <Badge variant="secondary" className="bg-muted text-muted-foreground">
          <Lock className="h-3 w-3 mr-1" />
          {t("course.assess.badgeClosed")}
        </Badge>
      );
    }
    switch (quiz.status) {
      case 'completed':
        return (
          <Badge variant="secondary" className="bg-green-500/20 text-green-600">
            <CheckCircle className="h-3 w-3 mr-1" />
            {t("course.assess.badgeSubmitted")}
          </Badge>
        );
      case 'in_progress':
        return (
          <Badge variant="secondary" className="bg-amber-500/20 text-amber-600">
            <Play className="h-3 w-3 mr-1" />
            {t("course.assess.badgeInProgress")}
          </Badge>
        );
      default:
        if (quiz.dueDate && isPast(new Date(quiz.dueDate))) {
          return (
            <Badge variant="secondary" className="bg-red-500/20 text-red-600">
              <AlertCircle className="h-3 w-3 mr-1" />
              {t("course.assess.badgeOverdue")}
            </Badge>
          );
        }
        return (
          <Badge variant="secondary" className="bg-blue-500/20 text-blue-600">
            {t("course.assess.badgeNotStarted")}
          </Badge>
        );
    }
  };

  const getDueText = (dueDate: string | null) => {
    if (!dueDate) return null;
    const date = new Date(dueDate);
    // The distance is formatted by date-fns in the active locale and handed to
    // the catalog as a placeholder, so Greek can put it where it belongs in the
    // sentence rather than having it concatenated onto an English frame.
    const distance = formatDistanceToNow(date, { locale: dateLocale });
    if (isPast(date)) return t("course.assess.overdueBy", { distance });
    return t("course.assess.dueIn", {
      distance: formatDistanceToNow(date, { addSuffix: true, locale: dateLocale }),
    });
  };

  const QuizCard = ({ quiz }: { quiz: QuizAssignment }) => (
    <Card className="hover:border-primary/30 transition-colors">
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-2">
              {getStatusBadge(quiz)}
              {quiz.dueDate && quiz.status !== 'completed' && (
                <span className={`text-xs ${isPast(new Date(quiz.dueDate)) ? 'text-red-500' : 'text-muted-foreground'}`}>
                  {getDueText(quiz.dueDate)}
                </span>
              )}
            </div>
            <h4 className="font-semibold">{quiz.title}</h4>
            <div className="flex items-center gap-3 text-sm text-muted-foreground mt-1">
              <span>{t("course.assess.questions", { count: quiz.questionCount })}</span>
              {quiz.timeLimit && (
                <>
                  <span>•</span>
                  <span className="flex items-center gap-1">
                    <Clock className="h-3.5 w-3.5" />
                    {t("course.assess.minutes", { count: quiz.timeLimit })}
                  </span>
                </>
              )}
            </div>
            {quiz.status === 'completed' && quiz.score !== undefined && (
              <div className="mt-2">
                <span className="text-lg font-bold text-primary">
                  {quiz.score}/{quiz.totalPoints}
                </span>
                <span className="text-sm text-muted-foreground ml-2">
                  {t("course.assess.percent", {
                    percent: Math.round((quiz.score / (quiz.totalPoints || 1)) * 100),
                  })}
                </span>
              </div>
            )}
          </div>
          <div>
            {quiz.status === 'completed' ? (
              <Button variant="outline" size="sm" onClick={() => onViewResults(quiz.quizId)}>
                {quiz.closedAt
                  ? t("course.assess.actionReviewAnswers")
                  : t("course.assess.actionViewResults")}
              </Button>
            ) : quiz.closedAt ? (
              <Button variant="outline" size="sm" disabled>
                <Lock className="h-3 w-3 mr-1" />
                {t("course.assess.actionClosed")}
              </Button>
            ) : (
              <Button
                size="sm"
                onClick={() => onTakeQuiz(quiz.quizId)}
                disabled={quiz.dueDate ? isPast(new Date(quiz.dueDate)) : false}
              >
                {quiz.status === 'in_progress'
                  ? t("course.assess.actionContinue")
                  : t("course.assess.actionStart")}
              </Button>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );

  return (
    <div className="space-y-6">
      {/* Available Quizzes */}
      {availableQuizzes.length > 0 && (
        <div>
          <h3 className="text-lg font-semibold mb-3 flex items-center gap-2">
            <ClipboardCheck className="h-5 w-5 text-primary" />
            {t("course.assess.headingAvailable")}
          </h3>
          <div className="space-y-3">
            {availableQuizzes.map(quiz => (
              <QuizCard key={quiz.id} quiz={quiz} />
            ))}
          </div>
        </div>
      )}

      {/* Completed Quizzes */}
      {completedQuizzes.length > 0 && (
        <div>
          <h3 className="text-lg font-semibold mb-3 flex items-center gap-2">
            <CheckCircle className="h-5 w-5 text-green-500" />
            {t("course.assess.headingCompleted")}
          </h3>
          <div className="space-y-3">
            {completedQuizzes.map(quiz => (
              <QuizCard key={quiz.id} quiz={quiz} />
            ))}
          </div>
        </div>
      )}

      {/* Closed Quizzes (not submitted before closing) */}
      {closedQuizzes.length > 0 && (
        <div>
          <h3 className="text-lg font-semibold mb-3 flex items-center gap-2">
            <XCircle className="h-5 w-5 text-muted-foreground" />
            {t("course.assess.headingClosed")}
          </h3>
          <div className="space-y-3">
            {closedQuizzes.map(quiz => (
              <QuizCard key={quiz.id} quiz={quiz} />
            ))}
          </div>
        </div>
      )}

      {/* Empty State */}
      {quizzes.length === 0 && (
        <Card className="border-dashed">
          <CardContent className="p-8 text-center">
            <ClipboardCheck className="h-12 w-12 text-muted-foreground/50 mx-auto mb-4" />
            <h4 className="font-medium mb-2">{t("course.assess.emptyTitle")}</h4>
            <p className="text-sm text-muted-foreground">
              {t("course.assess.emptyBody")}
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
