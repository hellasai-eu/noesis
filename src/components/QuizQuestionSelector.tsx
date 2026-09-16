import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Search, EyeOff } from "lucide-react";
import { processLatexContent } from "@/lib/latex-utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface Question {
  id: string;
  question: string;
  options: any;
  // Multi-correct (#592). Legacy `correct_answer` retained as optional for
  // back-compat with call sites still being migrated.
  correct_indices?: number[];
  correct_answer?: number;
  explanation: string | null;
  difficulty: string;
  hidden: boolean;
}

interface QuizQuestionSelectorProps {
  questions: Question[];
  selectedQuestionIds: string[];
  onToggleQuestion: (questionId: string) => void;
  onSelectAll: (ids: string[]) => void;
  getQuizzesForQuestion: (questionId: string) => string[];
}

export function QuizQuestionSelector({
  questions,
  selectedQuestionIds,
  onToggleQuestion,
  onSelectAll,
  getQuizzesForQuestion,
}: QuizQuestionSelectorProps) {
  const [questionSearch, setQuestionSearch] = useState("");
  const [difficultyFilter, setDifficultyFilter] = useState<string>("all");
  const [visibilityFilter, setVisibilityFilter] = useState<string>("all");

  const filteredQuestions = questions.filter((q) => {
    const matchesSearch = q.question.toLowerCase().includes(questionSearch.toLowerCase());
    const matchesDifficulty = difficultyFilter === "all" || q.difficulty === difficultyFilter;
    const matchesVisibility = 
      visibilityFilter === "all" ||
      (visibilityFilter === "visible" && !q.hidden) ||
      (visibilityFilter === "hidden" && q.hidden);
    return matchesSearch && matchesDifficulty && matchesVisibility;
  });

  const allFilteredSelected = filteredQuestions.length > 0 && 
    filteredQuestions.every((q) => selectedQuestionIds.includes(q.id));

  const handleSelectAll = () => {
    const filteredIds = filteredQuestions.map((q) => q.id);
    if (allFilteredSelected) {
      // Deselect all filtered
      onSelectAll(selectedQuestionIds.filter((id) => !filteredIds.includes(id)));
    } else {
      // Select all filtered
      onSelectAll([...new Set([...selectedQuestionIds, ...filteredIds])]);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Label>Select Questions</Label>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleSelectAll}
          type="button"
          disabled={filteredQuestions.length === 0}
        >
          {allFilteredSelected ? "Deselect All" : "Select All"}
        </Button>
      </div>
      
      {/* Search and Filters */}
      <div className="space-y-2">
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search questions..."
            value={questionSearch}
            onChange={(e) => setQuestionSearch(e.target.value)}
            className="pl-8"
          />
        </div>
        <div className="flex gap-2">
          <Select value={difficultyFilter} onValueChange={setDifficultyFilter}>
            <SelectTrigger className="flex-1">
              <SelectValue placeholder="Difficulty" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All difficulties</SelectItem>
              <SelectItem value="easy">Easy</SelectItem>
              <SelectItem value="medium">Medium</SelectItem>
              <SelectItem value="hard">Hard</SelectItem>
            </SelectContent>
          </Select>
          <Select value={visibilityFilter} onValueChange={setVisibilityFilter}>
            <SelectTrigger className="flex-1">
              <SelectValue placeholder="Visibility" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All questions</SelectItem>
              <SelectItem value="visible">Visible only</SelectItem>
              <SelectItem value="hidden">Hidden only</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {questions.length === 0 ? (
        <p className="text-sm text-muted-foreground py-2">
          No questions available. Generate some questions first.
        </p>
      ) : filteredQuestions.length === 0 ? (
        <p className="text-sm text-muted-foreground py-4 text-center">
          No questions match your filters.
        </p>
      ) : (
        <ScrollArea className="h-52 rounded-md border p-3">
          <div className="space-y-2">
            {filteredQuestions.map((question) => (
              <div
                key={question.id}
                className="flex items-start gap-2 p-2 rounded hover:bg-muted/50"
              >
                <Checkbox
                  id={`q-${question.id}`}
                  checked={selectedQuestionIds.includes(question.id)}
                  onCheckedChange={() => onToggleQuestion(question.id)}
                />
                <label
                  htmlFor={`q-${question.id}`}
                  className="flex-1 text-sm cursor-pointer leading-snug"
                >
                  <div className="flex items-center gap-2 mb-1">
                    <Badge
                      variant="outline"
                      className={
                        question.difficulty === "easy"
                          ? "text-green-600 border-green-600"
                          : question.difficulty === "hard"
                          ? "text-red-600 border-red-600"
                          : "text-amber-600 border-amber-600"
                      }
                    >
                      {question.difficulty}
                    </Badge>
                    {question.hidden && (
                      <Badge variant="secondary" className="text-xs">
                        <EyeOff className="w-3 h-3 mr-1" />
                        Hidden
                      </Badge>
                    )}
                    {(() => {
                      const otherQuizzes = getQuizzesForQuestion(question.id);
                      if (otherQuizzes.length > 0) {
                        return (
                          <Badge variant="outline" className="text-xs text-blue-600 border-blue-600">
                            In: {otherQuizzes.length === 1 ? otherQuizzes[0] : `${otherQuizzes.length} quizzes`}
                          </Badge>
                        );
                      }
                      return null;
                    })()}
                  </div>
                  <span dangerouslySetInnerHTML={{ __html: processLatexContent(question.question) }} />
                </label>
              </div>
            ))}
          </div>
        </ScrollArea>
      )}
      <p className="text-xs text-muted-foreground">
        {selectedQuestionIds.length} selected
        {filteredQuestions.length !== questions.length && (
          <span className="ml-1">({filteredQuestions.length} of {questions.length} shown)</span>
        )}
        {selectedQuestionIds.some((id) => questions.find((q) => q.id === id)?.hidden) && (
          <span className="text-amber-600 ml-2">(includes hidden questions)</span>
        )}
      </p>
    </div>
  );
}
