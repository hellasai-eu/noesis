import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import {
  Loader2,
  RotateCcw,
  ChevronLeft,
  Sparkles,
  Clock,
  Trophy,
  Brain,
  CalendarDays,
} from "lucide-react";
import FlashcardCalendarView from "@/components/FlashcardCalendarView";
import { AiDisclaimer } from "@/components/AiDisclaimer";
import { toast } from "sonner";
import { Trans, useTranslation } from "react-i18next";
import {
  Rating,
  processReview,
  isDue,
  sortForReview,
  ratingLabelKey,
  describeNextReview,
  getRatingColor,
  DEFAULT_STATE,
  DAILY_LIMITS,
  getStartOfToday,
  type FlashcardState,
} from "@/lib/spaced-repetition";
import { cn } from "@/lib/utils";

// Daily limits. Shared with the course home, which subtracts today's spend
// from the due count it shows — see `DAILY_LIMITS`.
const { MAX_NEW_CARDS_PER_DAY, MAX_DUE_CARDS_PER_DAY } = DAILY_LIMITS;

interface Flashcard {
  front: string;
  back: string;
}

interface ChapterFlashcard {
  chapterId: string;
  chapterTitle: string;
  flashcardIndex: number;
  flashcard: Flashcard;
  reviewState: FlashcardState | null;
}

interface SpacedRepetitionReviewProps {
  courseId: string;
  chapterIds?: string[];
  onClose: () => void;
}

export default function SpacedRepetitionReview({
  courseId,
  chapterIds,
  onClose,
}: SpacedRepetitionReviewProps) {
  const { t } = useTranslation("study");
  // `t` changes identity when the language changes, but these callbacks
  // outlive the render that created them — a subscription handler or a
  // memoised action. Reading the latest one through a ref keeps their
  // notifications in the current language without re-running the effect
  // (which would resubscribe the channel or refetch the data).
  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  }, [t]);
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [allCards, setAllCards] = useState<ChapterFlashcard[]>([]);
  const [sessionCards, setSessionCards] = useState<ChapterFlashcard[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isFlipped, setIsFlipped] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [sessionComplete, setSessionComplete] = useState(false);
  const [alreadyReviewedToday, setAlreadyReviewedToday] = useState(false);
  const [todayStats, setTodayStats] = useState({ newReviewed: 0, dueReviewed: 0 });
  const [sessionStats, setSessionStats] = useState({
    reviewed: 0,
    correct: 0,
    again: 0,
  });

  // Load flashcards and their review states
  useEffect(() => {
    if (!user || !courseId) return;
    loadFlashcards();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch on user/courseId/chapterIds change
  }, [user, courseId, chapterIds]);

  const loadFlashcards = async () => {
    setLoading(true);
    try {
      const startOfToday = getStartOfToday();

      // Check how many cards were reviewed today
      const { data: todayReviews, error: todayError } = await supabase
        .from("flashcard_reviews")
        .select("*")
        .eq("user_id", user!.id)
        .eq("course_id", courseId)
        .gte("last_reviewed", startOfToday.toISOString());

      if (todayError) throw todayError;

      // Count new vs due cards reviewed today
      // A "new" card reviewed today = one where repetitions is 1 (first review happened today)
      // A "due" card = repetitions > 1
      const newReviewedToday = todayReviews?.filter(r => r.repetitions === 1).length || 0;
      const dueReviewedToday = todayReviews?.filter(r => r.repetitions > 1).length || 0;
      
      setTodayStats({ newReviewed: newReviewedToday, dueReviewed: dueReviewedToday });

      // Calculate remaining quota
      const remainingNewQuota = Math.max(0, MAX_NEW_CARDS_PER_DAY - newReviewedToday);
      const remainingDueQuota = Math.max(0, MAX_DUE_CARDS_PER_DAY - dueReviewedToday);

      // Check if session is already done for today
      if (remainingNewQuota === 0 && remainingDueQuota === 0) {
        setAlreadyReviewedToday(true);
        setLoading(false);
        return;
      }

      let chapterQuery;

      if (chapterIds && chapterIds.length > 0) {
        // Fetch specific chapters for the session
        chapterQuery = supabase
          .from("material_chapters")
          .select("id, title, flashcards, flashcards_visible, chapter_number")
          .in("id", chapterIds)
          .eq("flashcards_visible", true)
          .order("chapter_number", { ascending: true }).order("id");
      } else {
        // Fetch all chapters with visible flashcards for the course
        const { data: materialsData, error: materialsError } = await supabase
          .from("course_materials")
          .select("id")
          .eq("course_id", courseId);

        if (materialsError) throw materialsError;
        if (!materialsData || materialsData.length === 0) {
          setAllCards([]);
          setLoading(false);
          return;
        }

        const materialIds = materialsData.map((m) => m.id);

        chapterQuery = supabase
          .from("material_chapters")
          .select("id, title, flashcards, flashcards_visible, chapter_number")
          .in("material_id", materialIds)
          .eq("flashcards_visible", true)
          .order("chapter_number", { ascending: true }).order("id");
      }

      const { data: chaptersData, error: chaptersError } = await chapterQuery;

      if (chaptersError) throw chaptersError;

      // Fetch existing review states for this user
      const { data: reviewsData, error: reviewsError } = await supabase
        .from("flashcard_reviews")
        .select("*")
        .eq("user_id", user!.id)
        .eq("course_id", courseId);

      if (reviewsError) throw reviewsError;

      // Create a map of review states
      const reviewMap = new Map<string, any>();
      reviewsData?.forEach((review) => {
        const key = `${review.chapter_id}-${review.flashcard_index}`;
        reviewMap.set(key, review);
      });

      // Build flashcard list with states
      const cards: ChapterFlashcard[] = [];
      chaptersData?.forEach((chapter) => {
        const flashcards = (chapter.flashcards as unknown as Flashcard[]) || [];
        flashcards.forEach((flashcard, index) => {
          const key = `${chapter.id}-${index}`;
          const review = reviewMap.get(key);
          
          cards.push({
            chapterId: chapter.id,
            chapterTitle: chapter.title,
            flashcardIndex: index,
            flashcard,
            reviewState: review
              ? {
                  repetitions: review.repetitions,
                  intervalDays: Number(review.interval_days),
                  easeFactor: Number(review.ease_factor),
                  dueDate: new Date(review.due_date),
                  lastReviewed: review.last_reviewed
                    ? new Date(review.last_reviewed)
                    : null,
                }
              : null,
          });
        });
      });

      setAllCards(cards);

      // Build session - due cards + new cards with daily limits
      // Due cards: cards that have been reviewed before and are due now
      const dueCards = cards.filter(
        (c) => c.reviewState && isDue(c.reviewState.dueDate)
      );
      // New cards: cards never reviewed
      const newCards = cards.filter((c) => !c.reviewState);

      // Sort due cards for optimal review order
      const sortedDue = sortForReview(
        dueCards.map((c) => ({
          ...c,
          dueDate: c.reviewState!.dueDate,
          repetitions: c.reviewState!.repetitions,
        }))
      );

      // Apply daily limits
      const limitedDue = sortedDue.slice(0, remainingDueQuota);
      const limitedNew = newCards.slice(0, remainingNewQuota);

      // Combine: due cards first, then new cards
      const session = [...limitedDue, ...limitedNew];
      
      if (session.length === 0) {
        setAlreadyReviewedToday(true);
      }
      
      setSessionCards(session);
    } catch (error: any) {
      console.error("Error loading flashcards:", error);
      toast.error(tRef.current("spacedRepetition.loadFailed"));
    } finally {
      setLoading(false);
    }
  };

  const handleFlip = () => {
    setIsFlipped((prev) => !prev);
  };

  const handleRating = useCallback(async (rating: Rating) => {
    if (!user || submitting || currentIndex >= sessionCards.length) return;

    const currentCard = sessionCards[currentIndex];
    setSubmitting(true);

    try {
      // Get current state or default
      const currentState: FlashcardState = currentCard.reviewState || {
        ...DEFAULT_STATE,
        dueDate: new Date(),
        lastReviewed: null,
      };

      // Calculate new state
      const newState = processReview(currentState, rating);

      // Upsert to database
      const { error } = await supabase.from("flashcard_reviews").upsert(
        {
          user_id: user.id,
          chapter_id: currentCard.chapterId,
          flashcard_index: currentCard.flashcardIndex,
          course_id: courseId,
          repetitions: newState.repetitions,
          interval_days: newState.intervalDays,
          ease_factor: newState.easeFactor,
          due_date: newState.dueDate.toISOString(),
          last_reviewed: newState.lastReviewed.toISOString(),
        },
        {
          onConflict: "user_id,chapter_id,flashcard_index",
        }
      );

      if (error) throw error;

      // Update stats
      setSessionStats((prev) => ({
        reviewed: prev.reviewed + 1,
        correct: rating >= Rating.HARD ? prev.correct + 1 : prev.correct,
        again: rating === Rating.AGAIN ? prev.again + 1 : prev.again,
      }));

      // Move to next card
      if (currentIndex + 1 >= sessionCards.length) {
        setSessionComplete(true);
      } else {
        setCurrentIndex((prev) => prev + 1);
        setIsFlipped(false);
      }
    } catch (error: any) {
      console.error("Error saving review:", error);
      toast.error(tRef.current("spacedRepetition.saveFailed"));
    } finally {
      setSubmitting(false);
    }
  }, [user, submitting, currentIndex, sessionCards, courseId]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore if we're in an input or textarea
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      // Space to flip
      if (e.key === " " || e.code === "Space") {
        e.preventDefault();
        setIsFlipped((prev) => !prev);
        return;
      }

      // 1-4 to rate (only when flipped)
      if (isFlipped && !submitting && !sessionComplete) {
        const ratingMap: Record<string, Rating> = {
          "1": Rating.EASY,
          "2": Rating.GOOD,
          "3": Rating.HARD,
          "4": Rating.AGAIN,
        };
        
        if (ratingMap[e.key] !== undefined) {
          e.preventDefault();
          handleRating(ratingMap[e.key]);
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isFlipped, submitting, sessionComplete, handleRating]);

  const currentCard = sessionCards[currentIndex];
  const progress =
    sessionCards.length > 0
      ? ((currentIndex + (sessionComplete ? 1 : 0)) / sessionCards.length) * 100
      : 0;

  const currentState: FlashcardState = currentCard?.reviewState || {
    ...DEFAULT_STATE,
    dueDate: new Date(),
    lastReviewed: null,
  };

  // Count new vs due in current session
  const newInSession = sessionCards.filter(c => !c.reviewState).length;
  const dueInSession = sessionCards.filter(c => c.reviewState).length;

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (alreadyReviewedToday || sessionCards.length === 0) {
    return (
      <div className="max-w-2xl mx-auto space-y-6">
        <Card className="text-center p-8">
          <div className="w-20 h-20 mx-auto mb-6 rounded-full bg-gradient-to-br from-green-100 to-green-200 flex items-center justify-center">
            <Trophy className="w-10 h-10 text-green-600" />
          </div>
          <h2 className="text-2xl font-bold mb-2">{t("spacedRepetition.allDoneTitle")}</h2>
          <p className="text-muted-foreground mb-6">
            {t("spacedRepetition.allDoneBody")}
          </p>
          <div className="text-sm text-muted-foreground mb-6 space-y-1">
            <p>
              <Trans
                i18nKey="study:spacedRepetition.newReviewedToday"
                values={{ reviewed: todayStats.newReviewed, max: MAX_NEW_CARDS_PER_DAY }}
                components={{ 1: <strong /> }}
              />
            </p>
            <p>
              <Trans
                i18nKey="study:spacedRepetition.dueReviewedToday"
                values={{ reviewed: todayStats.dueReviewed, max: MAX_DUE_CARDS_PER_DAY }}
                components={{ 1: <strong /> }}
              />
            </p>
            <p className="mt-3">
              <Trans
                i18nKey="study:spacedRepetition.totalLearned"
                values={{ count: allCards.filter((c) => c.reviewState).length }}
                components={{ 1: <strong /> }}
              />
            </p>
          </div>
          <Button onClick={onClose}>{t("spacedRepetition.backToCourse")}</Button>
        </Card>
        
        {/* Calendar view for upcoming reviews */}
        {allCards.length > 0 && (
          <FlashcardCalendarView
            allCards={allCards}
            maxNewPerDay={MAX_NEW_CARDS_PER_DAY}
            maxDuePerDay={MAX_DUE_CARDS_PER_DAY}
          />
        )}
      </div>
    );
  }

  if (sessionComplete) {
    const accuracy =
      sessionStats.reviewed > 0
        ? Math.round((sessionStats.correct / sessionStats.reviewed) * 100)
        : 0;

    return (
      <div className="max-w-2xl mx-auto space-y-6">
        <Card className="text-center p-8">
          <div className="w-20 h-20 mx-auto mb-6 rounded-full bg-gradient-to-br from-primary/20 to-secondary/20 flex items-center justify-center">
            <Sparkles className="w-10 h-10 text-primary" />
          </div>
          <h2 className="text-2xl font-bold mb-2">{t("spacedRepetition.sessionCompleteTitle")}</h2>
          <p className="text-muted-foreground mb-6">{t("spacedRepetition.sessionCompleteBody")}</p>

          <div className="grid grid-cols-3 gap-4 mb-8">
            <div className="p-4 rounded-lg bg-muted/50">
              <p className="text-2xl font-bold text-primary">
                {sessionStats.reviewed}
              </p>
              <p className="text-xs text-muted-foreground">{t("spacedRepetition.statCardsReviewed")}</p>
            </div>
            <div className="p-4 rounded-lg bg-muted/50">
              <p className="text-2xl font-bold text-green-600">{accuracy}%</p>
              <p className="text-xs text-muted-foreground">{t("spacedRepetition.statAccuracy")}</p>
            </div>
            <div className="p-4 rounded-lg bg-muted/50">
              <p className="text-2xl font-bold text-orange-600">
                {sessionStats.again}
              </p>
              <p className="text-xs text-muted-foreground">{t("spacedRepetition.statToRelearn")}</p>
            </div>
          </div>

          <Button onClick={onClose}>{t("spacedRepetition.done")}</Button>
        </Card>

        {/* Calendar view for upcoming reviews */}
        {allCards.length > 0 && (
          <FlashcardCalendarView
            allCards={allCards}
            maxNewPerDay={MAX_NEW_CARDS_PER_DAY}
            maxDuePerDay={MAX_DUE_CARDS_PER_DAY}
          />
        )}
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      {/* Header with progress */}
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={onClose}>
          <ChevronLeft className="w-4 h-4 mr-1" />
          {t("spacedRepetition.exit")}
        </Button>
        <div className="flex items-center gap-3">
          <Badge variant="outline" className="gap-1">
            <Clock className="w-3 h-3" />
            {t("spacedRepetition.left", { count: sessionCards.length - currentIndex })}
          </Badge>
          <Badge variant="secondary" className="gap-1">
            <Brain className="w-3 h-3" />
            {currentCard?.reviewState
              ? t("spacedRepetition.badgeReview")
              : t("spacedRepetition.badgeNew")}
          </Badge>
        </div>
      </div>

      {/* Progress bar */}
      <Progress value={progress} className="h-2" />

      {/* Flashcards are written by `generate-flashcards` (#936). */}
      <AiDisclaimer variant="compact" className="justify-center" />

      {/* Session info */}
      <div className="flex justify-center gap-4 text-xs text-muted-foreground">
        <span>{t("spacedRepetition.dueCards", { count: dueInSession })}</span>
        <span>•</span>
        <span>{t("spacedRepetition.newCards", { count: newInSession })}</span>
      </div>

      {/* Chapter title */}
      <p className="text-sm text-muted-foreground text-center">
        {currentCard?.chapterTitle}
      </p>

      {/* Flashcard */}
      <div
        className="perspective-1000 cursor-pointer"
        onClick={handleFlip}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === " " && handleFlip()}
      >
        <div
          className={cn(
            "relative w-full min-h-[300px] transition-transform duration-500 transform-style-preserve-3d",
            isFlipped && "rotate-y-180"
          )}
        >
          {/* Front */}
          <Card
            className={cn(
              "absolute inset-0 backface-hidden p-8 flex items-center justify-center",
              isFlipped && "invisible"
            )}
          >
            <CardContent className="text-center p-0">
              <p className="text-xl font-medium">{currentCard?.flashcard.front}</p>
              {!isFlipped && (
                <p className="text-sm text-muted-foreground mt-6">
                  {t("spacedRepetition.tapToReveal")}
                </p>
              )}
            </CardContent>
          </Card>

          {/* Back */}
          <Card
            className={cn(
              "absolute inset-0 backface-hidden p-8 flex items-center justify-center rotate-y-180 bg-primary/5",
              !isFlipped && "invisible"
            )}
          >
            <CardContent className="text-center p-0">
              <p className="text-xl">{currentCard?.flashcard.back}</p>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Rating buttons */}
      {isFlipped && (
        <div className="space-y-4">
          <p className="text-center text-sm text-muted-foreground">
            {t("spacedRepetition.howWell")}
          </p>
          
          {/* Next review time indicators */}
          <div className="bg-muted/30 rounded-lg p-3 border border-border/50">
            <p className="text-xs text-muted-foreground text-center mb-3 flex items-center justify-center gap-1.5">
              <Clock className="w-3 h-3" />
              {t("spacedRepetition.nextReviewIn")}
            </p>
            <div className="grid grid-cols-4 gap-2 text-center">
              {[Rating.EASY, Rating.GOOD, Rating.HARD, Rating.AGAIN].map(
                (rating) => (
                  <div key={rating} className="space-y-1">
                    <div className={cn(
                      "text-sm font-semibold px-2 py-1 rounded",
                      rating === Rating.EASY && "text-blue-600 bg-blue-500/10",
                      rating === Rating.GOOD && "text-green-600 bg-green-500/10",
                      rating === Rating.HARD && "text-orange-600 bg-orange-500/10",
                      rating === Rating.AGAIN && "text-red-600 bg-red-500/10"
                    )}>
                      {t(
                        `spacedRepetition.interval.${describeNextReview(currentState, rating).unit}`,
                        { count: describeNextReview(currentState, rating).count },
                      )}
                    </div>
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wide">
                      {t(ratingLabelKey(rating))}
                    </p>
                  </div>
                )
              )}
            </div>
          </div>

          <div className="grid grid-cols-4 gap-2">
            {[Rating.EASY, Rating.GOOD, Rating.HARD, Rating.AGAIN].map(
              (rating) => (
                <Button
                  key={rating}
                  onClick={() => handleRating(rating)}
                  disabled={submitting}
                  className={cn("flex-col h-auto py-3", getRatingColor(rating))}
                >
                  <span className="font-semibold">{t(ratingLabelKey(rating))}</span>
                  <span className="text-xs opacity-80">
                    {t(
                      `spacedRepetition.interval.${describeNextReview(currentState, rating).unit}`,
                      { count: describeNextReview(currentState, rating).count },
                    )}
                  </span>
                </Button>
              )
            )}
          </div>
        </div>
      )}

      {/* Keyboard shortcuts hint */}
      <p className="text-center text-xs text-muted-foreground">
        <Trans
          i18nKey="study:spacedRepetition.keyboardHint"
          components={{
            1: <kbd className="px-1 py-0.5 bg-muted rounded" />,
            2: <kbd className="px-1 py-0.5 bg-muted rounded" />,
          }}
        />
      </p>
    </div>
  );
}
