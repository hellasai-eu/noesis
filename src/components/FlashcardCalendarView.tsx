import { useState, useMemo } from "react";
import { Calendar } from "@/components/ui/calendar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CalendarDays, Clock, Sparkles } from "lucide-react";
import { format, isSameDay, startOfDay, addDays, isToday, isBefore } from "date-fns";
import { cn } from "@/lib/utils";

interface FlashcardState {
  repetitions: number;
  intervalDays: number;
  easeFactor: number;
  dueDate: Date;
  lastReviewed: Date | null;
}

interface ChapterFlashcard {
  chapterId: string;
  chapterTitle: string;
  flashcardIndex: number;
  flashcard: {
    front: string;
    back: string;
  };
  reviewState: FlashcardState | null;
}

interface FlashcardCalendarViewProps {
  allCards: ChapterFlashcard[];
  maxNewPerDay?: number;
  maxDuePerDay?: number;
}

export default function FlashcardCalendarView({
  allCards,
  maxNewPerDay = 10,
  maxDuePerDay = 15,
}: FlashcardCalendarViewProps) {
  const [selectedDate, setSelectedDate] = useState<Date | undefined>(new Date());

  // Calculate cards due on each date
  const cardsByDate = useMemo(() => {
    const dateMap = new Map<string, { due: ChapterFlashcard[]; new: number }>();
    
    // Count total new cards (never reviewed)
    const totalNewCards = allCards.filter(c => !c.reviewState).length;
    
    // Group reviewed cards by due date
    allCards.forEach(card => {
      if (card.reviewState) {
        const dateKey = startOfDay(card.reviewState.dueDate).toISOString();
        const existing = dateMap.get(dateKey) || { due: [], new: 0 };
        existing.due.push(card);
        dateMap.set(dateKey, existing);
      }
    });

    // Distribute new cards across future dates based on daily limit
    // Assuming new cards will be introduced gradually
    let remainingNew = totalNewCards;
    let currentDate = startOfDay(new Date());
    
    while (remainingNew > 0) {
      const dateKey = currentDate.toISOString();
      const existing = dateMap.get(dateKey) || { due: [], new: 0 };
      
      // How many new cards can we add today?
      const newToAdd = Math.min(maxNewPerDay, remainingNew);
      existing.new = newToAdd;
      dateMap.set(dateKey, existing);
      
      remainingNew -= newToAdd;
      currentDate = addDays(currentDate, 1);
    }

    return dateMap;
  }, [allCards, maxNewPerDay]);

  // Get cards for selected date
  const selectedDateCards = useMemo(() => {
    if (!selectedDate) return { due: [], new: 0 };
    const dateKey = startOfDay(selectedDate).toISOString();
    return cardsByDate.get(dateKey) || { due: [], new: 0 };
  }, [selectedDate, cardsByDate]);

  // Calculate overdue cards (due before today)
  const overdueCards = useMemo(() => {
    const today = startOfDay(new Date());
    return allCards.filter(
      c => c.reviewState && isBefore(c.reviewState.dueDate, today)
    );
  }, [allCards]);

  // Custom day render to show card counts
  const modifiers = useMemo(() => {
    const hasDue: Date[] = [];
    const hasNew: Date[] = [];
    const hasMany: Date[] = [];
    
    cardsByDate.forEach((cards, dateKey) => {
      const date = new Date(dateKey);
      const total = cards.due.length + cards.new;
      
      if (cards.due.length > 0) hasDue.push(date);
      if (cards.new > 0) hasNew.push(date);
      if (total > 10) hasMany.push(date);
    });

    return { hasDue, hasNew, hasMany };
  }, [cardsByDate]);

  const modifiersStyles = {
    hasDue: {
      backgroundColor: "hsl(var(--primary) / 0.1)",
      borderRadius: "50%",
    },
    hasNew: {
      border: "2px solid hsl(var(--primary) / 0.3)",
      borderRadius: "50%",
    },
    hasMany: {
      fontWeight: "bold" as const,
    },
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-lg flex items-center gap-2">
          <CalendarDays className="w-5 h-5" />
          Upcoming Reviews
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Overdue alert */}
        {overdueCards.length > 0 && (
          <div className="bg-destructive/10 border border-destructive/20 rounded-lg p-3">
            <p className="text-sm font-medium text-destructive">
              {overdueCards.length} overdue card{overdueCards.length !== 1 ? "s" : ""}
            </p>
            <p className="text-xs text-muted-foreground">
              These cards need review today
            </p>
          </div>
        )}

        {/* Calendar */}
        <Calendar
          mode="single"
          selected={selectedDate}
          onSelect={setSelectedDate}
          modifiers={modifiers}
          modifiersStyles={modifiersStyles}
          className="rounded-md border w-full"
          disabled={(date) => isBefore(date, startOfDay(new Date()))}
        />

        {/* Legend */}
        <div className="flex flex-wrap gap-3 text-xs text-muted-foreground justify-center">
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-3 rounded-full bg-primary/10" />
            <span>Due cards</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-3 rounded-full border-2 border-primary/30" />
            <span>New cards</span>
          </div>
        </div>

        {/* Selected date details */}
        {selectedDate && (
          <div className="border-t pt-4 space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="font-medium">
                {isToday(selectedDate) ? "Today" : format(selectedDate, "EEEE, MMM d")}
              </h4>
              <div className="flex gap-2">
                {selectedDateCards.due.length > 0 && (
                  <Badge variant="secondary" className="gap-1">
                    <Clock className="w-3 h-3" />
                    {selectedDateCards.due.length} due
                  </Badge>
                )}
                {selectedDateCards.new > 0 && (
                  <Badge variant="outline" className="gap-1">
                    <Sparkles className="w-3 h-3" />
                    {selectedDateCards.new} new
                  </Badge>
                )}
              </div>
            </div>

            {selectedDateCards.due.length === 0 && selectedDateCards.new === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">
                No cards scheduled for this day
              </p>
            ) : (
              <div className="space-y-2 max-h-48 overflow-y-auto">
                {selectedDateCards.due.slice(0, 5).map((card, idx) => (
                  <div
                    key={`${card.chapterId}-${card.flashcardIndex}`}
                    className="text-sm p-2 rounded bg-muted/50 flex items-start gap-2"
                  >
                    <Clock className="w-3.5 h-3.5 text-muted-foreground mt-0.5 shrink-0" />
                    <div className="min-w-0">
                      <p className="truncate">{card.flashcard.front}</p>
                      <p className="text-xs text-muted-foreground truncate">
                        {card.chapterTitle}
                      </p>
                    </div>
                  </div>
                ))}
                {selectedDateCards.due.length > 5 && (
                  <p className="text-xs text-muted-foreground text-center">
                    +{selectedDateCards.due.length - 5} more due cards
                  </p>
                )}
                {selectedDateCards.new > 0 && (
                  <div className="text-sm p-2 rounded bg-primary/5 border border-primary/10 flex items-center gap-2">
                    <Sparkles className="w-3.5 h-3.5 text-primary shrink-0" />
                    <span className="text-muted-foreground">
                      {selectedDateCards.new} new card{selectedDateCards.new !== 1 ? "s" : ""} to learn
                    </span>
                  </div>
                )}
              </div>
            )}

            {/* Daily limit info */}
            <div className="text-xs text-muted-foreground text-center pt-2 border-t">
              Daily limits: {maxNewPerDay} new • {maxDuePerDay} due
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
