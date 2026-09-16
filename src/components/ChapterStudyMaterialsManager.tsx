import { Badge } from "@/components/ui/badge";
import {
  FileText,
  Check,
  Layers,
} from "lucide-react";

interface ChapterStudyMaterialsManagerProps {
  chapterId: string;
  chapterTitle: string;
  hasCheatSheet: boolean;
  hasFlashcards?: boolean;
  flashcardCount?: number;
  materialType: string;
  onUpdate?: () => void;
}

export function ChapterStudyMaterialsManager({
  hasCheatSheet,
  hasFlashcards = false,
  flashcardCount = 0,
  materialType,
}: ChapterStudyMaterialsManagerProps) {
  const isTextbook = materialType === "textbook";

  if (!isTextbook) {
    return null;
  }

  // Only show status badges if there's something to display
  if (!hasCheatSheet && !hasFlashcards) {
    return null;
  }

  return (
    <div className="flex flex-wrap gap-1">
      {hasCheatSheet && (
        <Badge variant="secondary" className="gap-1 text-xs">
          <FileText className="w-3 h-3" />
          <Check className="w-3 h-3 text-green-600" />
          Cheat Sheet
        </Badge>
      )}
      {hasFlashcards && flashcardCount > 0 && (
        <Badge variant="secondary" className="gap-1 text-xs">
          <Layers className="w-3 h-3" />
          {flashcardCount} flashcards
        </Badge>
      )}
    </div>
  );
}
