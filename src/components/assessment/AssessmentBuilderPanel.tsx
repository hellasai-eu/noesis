import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  X,
  ChevronUp,
  ChevronDown,
  Save,
  Eye,
  FileText,
  Loader2,
  ArrowUp,
  ArrowDown,
  Trash2,
  Pencil,
} from "lucide-react";
import { processLatexContent } from "@/lib/latex-utils";
import { QUESTION_TYPE_LABELS } from "@/lib/unified-question";
import type { QuestionType } from "@/types/question";

export interface AssessmentQuestion {
  id: string;
  // Widened in #653 from `'mcq' | 'open'` to all 5 non-interactive types so the
  // assessment bank / builder can carry fill_gaps / ordering / classification too.
  type: QuestionType;
  question: string;
  difficulty: string;
  points: number;
  competency_id?: string | null;
}

interface AssessmentBuilderPanelProps {
  mode: 'quiz' | 'test';
  title: string;
  onTitleChange: (title: string) => void;
  description: string;
  onDescriptionChange: (description: string) => void;
  customHeader?: string;
  onCustomHeaderChange?: (header: string) => void;
  questions: AssessmentQuestion[];
  onRemoveQuestion: (id: string) => void;
  onUpdatePoints: (id: string, points: number) => void;
  onMoveQuestion: (index: number, direction: 'up' | 'down') => void;
  onPreview: () => void;
  onSave: () => void;
  saving: boolean;
  isEditing?: boolean;
  // Issue #728 — test mode only. When provided, renders an "Edit document"
  // button that opens the rich-text editor over the assembled HTML.
  onEditDocument?: () => void;
  hasEditedDocument?: boolean;
}

export function AssessmentBuilderPanel({
  mode,
  title,
  onTitleChange,
  description,
  onDescriptionChange,
  customHeader,
  onCustomHeaderChange,
  questions,
  onRemoveQuestion,
  onUpdatePoints,
  onMoveQuestion,
  onPreview,
  onSave,
  saving,
  isEditing = false,
  onEditDocument,
  hasEditedDocument = false,
}: AssessmentBuilderPanelProps) {
  const getTotalPoints = () => {
    return questions.reduce((sum, q) => sum + q.points, 0);
  };

  const getDifficultyColor = (difficulty: string) => {
    switch (difficulty) {
      case 'easy': return 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400';
      case 'medium': return 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400';
      case 'hard': return 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400';
      default: return 'bg-muted text-muted-foreground';
    }
  };

  const canSave = title.trim() && questions.length > 0;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between">
          <span className="flex items-center gap-2">
            <FileText className="w-5 h-5" />
            Your {mode === 'quiz' ? 'Quiz' : 'Test'}
          </span>
          <Badge variant="secondary">
            {questions.length} questions
          </Badge>
        </CardTitle>
        <CardDescription>
          Total: {getTotalPoints()} points
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Title */}
        <div className="space-y-2">
          <Label htmlFor="assessment-title">{mode === 'quiz' ? 'Quiz' : 'Test'} Title</Label>
          <Input
            id="assessment-title"
            placeholder={`Enter ${mode} title...`}
            value={title}
            onChange={(e) => onTitleChange(e.target.value)}
          />
        </div>

        {/* Description */}
        <div className="space-y-2">
          <Label htmlFor="assessment-description" className="flex items-center gap-2">
            Description (optional)
            <Badge variant="outline" className="text-[10px] font-normal">
              <Eye className="w-3 h-3 mr-1" />
              Visible to students
            </Badge>
          </Label>
          <Textarea
            id="assessment-description"
            placeholder="Add a description..."
            value={description}
            onChange={(e) => onDescriptionChange(e.target.value)}
            rows={2}
            className="resize-none text-sm"
            aria-describedby="assessment-description-help"
          />
          <p id="assessment-description-help" className="text-xs text-muted-foreground">
            Students see this description when they open the {mode}.
          </p>
        </div>

        {/* Test-specific: Custom header */}
        {mode === 'test' && onCustomHeaderChange && (
          <div className="space-y-2">
            <Label htmlFor="custom-header">Custom Header (optional)</Label>
            <Textarea
              id="custom-header"
              placeholder="Add instructions, date, student name field, etc..."
              value={customHeader || ''}
              onChange={(e) => onCustomHeaderChange(e.target.value)}
              rows={2}
              className="resize-none text-sm"
            />
          </div>
        )}

        {/* Questions List */}
        <ScrollArea className="h-[250px] pr-2">
          {questions.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <FileText className="w-8 h-8 mx-auto mb-2 opacity-50" />
              <p className="text-sm">No questions added yet</p>
              <p className="text-xs mt-1">Select questions from the question bank</p>
            </div>
          ) : (
            <div className="space-y-2">
              {questions.map((q, index) => (
                <div
                  key={q.id}
                  className="p-2 rounded-lg bg-secondary/50 border text-sm"
                >
                  <div className="flex flex-wrap items-center gap-2 mb-1">
                    <span className="font-medium text-xs text-muted-foreground">
                      Q{index + 1}
                    </span>
                    <Badge variant="outline" className="text-xs">
                      {QUESTION_TYPE_LABELS[q.type]}
                    </Badge>
                    <Badge variant="outline" className={`text-xs ${getDifficultyColor(q.difficulty)}`}>
                      {q.difficulty}
                    </Badge>
                  </div>
                  <p className="line-clamp-1 text-xs mb-2" dangerouslySetInnerHTML={{ __html: processLatexContent(q.question) }} />
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1">
                      <Input
                        type="number"
                        value={q.points}
                        onChange={(e) => onUpdatePoints(q.id, parseInt(e.target.value) || 0)}
                        className="w-16 h-7 text-xs"
                        min={0}
                      />
                      <span className="text-xs text-muted-foreground">pts</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => onMoveQuestion(index, 'up')}
                        disabled={index === 0}
                      >
                        <ArrowUp className="w-3 h-3" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => onMoveQuestion(index, 'down')}
                        disabled={index === questions.length - 1}
                      >
                        <ArrowDown className="w-3 h-3" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-destructive hover:text-destructive"
                        onClick={() => onRemoveQuestion(q.id)}
                      >
                        <Trash2 className="w-3 h-3" />
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </ScrollArea>

        {/* Action Buttons — wrap when the panel is narrow (issue #733: with the
            #728 "Edit document" button added, three flex-1 buttons overflowed
            the column and pushed Save off-screen, making it un-clickable). */}
        <div className="flex flex-wrap gap-2 pt-2">
          <Button
            variant="outline"
            className="flex-1 min-w-[120px]"
            onClick={onPreview}
            disabled={questions.length === 0}
          >
            <Eye className="w-4 h-4 mr-2" />
            Preview
          </Button>
          {onEditDocument && (
            <Button
              type="button"
              variant="outline"
              className="flex-1 min-w-[170px]"
              onClick={onEditDocument}
              disabled={questions.length === 0}
              title={
                hasEditedDocument
                  ? "Open the rich-text editor for this test"
                  : "Generate an editable HTML document from these questions"
              }
            >
              <Pencil className="w-4 h-4 mr-2" />
              {hasEditedDocument ? "Edit document" : "Generate document"}
            </Button>
          )}
          <Button
            className="flex-1 min-w-[120px]"
            onClick={onSave}
            disabled={!canSave || saving}
          >
            {saving ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Saving...
              </>
            ) : (
              <>
                <Save className="w-4 h-4 mr-2" />
                {isEditing ? 'Update' : 'Save'}
              </>
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
