import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, Layers, Play } from "lucide-react";
import { useTranslation } from "react-i18next";

interface Chapter {
  id: string;
  title: string;
  chapter_number: number;
  flashcard_count: number;
  material_id: string;
  material_title: string;
}

interface FlashcardSessionManagerProps {
  courseId: string;
  offeringId?: string;
  onStartSession: (chapterIds: string[]) => void;
}

export default function FlashcardSessionManager({
  courseId,
  offeringId,
  onStartSession,
}: FlashcardSessionManagerProps) {
  const { t } = useTranslation("study");
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [chapters, setChapters] = useState<Chapter[]>([]);

  useEffect(() => {
    if (user && courseId) {
      loadData();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch on user/courseId/offeringId change
  }, [user, courseId, offeringId]);

  const loadData = async () => {
    setLoading(true);
    try {
      // If offeringId is provided, check offering_chapter_flashcards for assigned chapters
      let assignedChapterIds: string[] | null = null;
      
      if (offeringId) {
        const { data: assignedData, error: assignedError } = await supabase
          .from("offering_chapter_flashcards")
          .select("chapter_id")
          .eq("offering_id", offeringId)
          .not("published_at", "is", null);
        
        if (assignedError) throw assignedError;
        
        if (assignedData && assignedData.length > 0) {
          assignedChapterIds = assignedData.map((a: any) => a.chapter_id);
        } else {
          // No flashcards assigned to this offering
          setChapters([]);
          setLoading(false);
          return;
        }
      }

      // Load chapters with flashcards
      const { data: materialsData, error: materialsError } = await supabase
        .from("course_materials")
        .select("id, title")
        .eq("course_id", courseId);

      if (materialsError) throw materialsError;

      if (materialsData && materialsData.length > 0) {
        const materialIds = materialsData.map((m) => m.id);
        const materialTitles = new Map(
          materialsData.map((m) => [m.id, m.title || t("flashcardSessions.untitledMaterial")])
        );

        let query = supabase
          .from("material_chapters")
          .select("id, title, chapter_number, flashcards, flashcards_visible, material_id")
          .in("material_id", materialIds)
          .eq("flashcards_visible", true)
          .order("chapter_number", { ascending: true }).order("id");
        
        // If we have assigned chapter IDs, filter by them
        if (assignedChapterIds) {
          query = query.in("id", assignedChapterIds);
        }

        const { data: chaptersData, error: chaptersError } = await query;

        if (chaptersError) throw chaptersError;

        const chaptersWithFlashcards = (chaptersData || [])
          .filter((ch: any) => Array.isArray(ch.flashcards) && ch.flashcards.length > 0)
          .map((ch: any) => ({
            id: ch.id,
            title: ch.title,
            chapter_number: ch.chapter_number,
            flashcard_count: ch.flashcards.length,
            material_id: ch.material_id,
            material_title: materialTitles.get(ch.material_id) || t("flashcardSessions.untitled"),
          }));

        setChapters(chaptersWithFlashcards);
      } else {
        setChapters([]);
      }
    } catch (error: any) {
      console.error("Error loading data:", error);
    } finally {
      setLoading(false);
    }
  };

  const totalFlashcards = chapters.reduce((sum, c) => sum + c.flashcard_count, 0);
  const allChapterIds = chapters.map((c) => c.id);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (chapters.length === 0) {
    return (
      <Card>
        <CardContent className="py-12 text-center">
          <Layers className="w-12 h-12 mx-auto text-muted-foreground mb-3" />
          <p className="text-muted-foreground">
            {t("flashcardSessions.empty")}
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="py-8">
        <div className="flex flex-col items-center text-center space-y-4">
          <Layers className="w-12 h-12 text-primary" />
          <div>
            <h3 className="text-lg font-semibold">{t("flashcardSessions.title")}</h3>
            <div className="flex items-center justify-center gap-2 mt-2">
              <Badge variant="outline">{t("flashcardSessions.chapters", { count: chapters.length })}</Badge>
              <Badge variant="secondary">{t("flashcardSessions.cards", { count: totalFlashcards })}</Badge>
            </div>
          </div>
          <Button size="lg" onClick={() => onStartSession(allChapterIds)}>
            <Play className="w-4 h-4 mr-2" />
            {t("flashcardSessions.start")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
