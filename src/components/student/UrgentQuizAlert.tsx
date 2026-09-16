import { Clock, AlertTriangle, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { format, formatDistanceToNow, isPast, isToday, isTomorrow } from "date-fns";

interface UrgentQuiz {
  id: string;
  title: string;
  questionCount: number;
  timeLimit: number | null;
  dueDate: string | null;
}

interface UrgentQuizAlertProps {
  quiz: UrgentQuiz;
  onTakeQuiz: () => void;
}

export function UrgentQuizAlert({ quiz, onTakeQuiz }: UrgentQuizAlertProps) {
  const getDueDateText = () => {
    if (!quiz.dueDate) return null;
    const date = new Date(quiz.dueDate);
    if (isPast(date)) return "Overdue";
    if (isToday(date)) return "Due today";
    if (isTomorrow(date)) return "Due tomorrow";
    return `Due ${formatDistanceToNow(date, { addSuffix: true })}`;
  };

  const dueDateText = getDueDateText();
  const isOverdue = quiz.dueDate && isPast(new Date(quiz.dueDate));

  return (
    <div className={`rounded-lg p-4 mb-6 ${isOverdue ? 'bg-destructive/10 border border-destructive/20' : 'bg-orange-500/10 border border-orange-500/20'}`}>
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <div className={`p-2 rounded-full ${isOverdue ? 'bg-destructive/20' : 'bg-orange-500/20'}`}>
            <AlertTriangle className={`h-5 w-5 ${isOverdue ? 'text-destructive' : 'text-orange-500'}`} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className={`text-xs font-medium px-2 py-0.5 rounded ${isOverdue ? 'bg-destructive/20 text-destructive' : 'bg-orange-500/20 text-orange-600'}`}>
                Assigned Quiz
              </span>
              {dueDateText && (
                <span className={`text-xs font-medium ${isOverdue ? 'text-destructive' : 'text-orange-600'}`}>
                  {dueDateText}
                </span>
              )}
            </div>
            <h3 className="font-semibold text-foreground mt-1">{quiz.title}</h3>
            <div className="flex items-center gap-3 text-sm text-muted-foreground mt-0.5">
              <span>{quiz.questionCount} questions</span>
              {quiz.timeLimit && (
                <>
                  <span>•</span>
                  <span className="flex items-center gap-1">
                    <Clock className="h-3.5 w-3.5" />
                    {quiz.timeLimit} min
                  </span>
                </>
              )}
            </div>
          </div>
        </div>
        <Button onClick={onTakeQuiz} className="gap-2">
          Take Quiz
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
