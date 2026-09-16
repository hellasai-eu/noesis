import { useState, useEffect, type ReactNode } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Users, GraduationCap, BarChart2, History, MessageSquareText, ThumbsUp, MessagesSquare } from "lucide-react";
import StudentEvaluations from "./StudentEvaluations";
import QuizHistory from "./QuizHistory";
import OpenQuestionChatHistory from "./OpenQuestionChatHistory";
import QuestionFeedback from "./QuestionFeedback";
import { ClassCompetencyAnalytics } from "./ClassCompetencyAnalytics";
import { buildClassDisplayName } from "@/lib/greek-school";
import { useFormatters } from "@/i18n/formatters";

export type Student360Panel = "evaluations" | "interactions" | "competencies";

/** Canonical order — a caller's `panels` prop is filtered through this, not read in its own order. */
const ALL_PANELS: Student360Panel[] = ["evaluations", "interactions", "competencies"];

const PANEL_LABELS: Record<Student360Panel, string> = {
  evaluations: "Student Evaluations",
  interactions: "Interactions",
  competencies: "Class Competencies",
};

const PANEL_ICONS: Record<Student360Panel, typeof Users> = {
  evaluations: Users,
  interactions: MessagesSquare,
  competencies: BarChart2,
};

interface Student360Props {
  courseId: string;
  /**
   * Which panels to render. CoursePage splits them across two top-level tabs —
   * My Class takes evaluations + competencies, Data Bank takes interactions — so
   * each mount there asks for a subset. ClassDetailPanel still shows all three
   * as one tabbed panel, which is the default.
   */
  panels?: Student360Panel[];
}

interface ClassOption {
  id: string;
  name: string;
  grade_level_id: string | null;
  section_name: string | null;
  offeringId: string;
  isActive: boolean;
}

const Student360 = ({ courseId, panels = ALL_PANELS }: Student360Props) => {
  const { compareText } = useFormatters();
  const [classes, setClasses] = useState<ClassOption[]>([]);
  const [selectedClassId, setSelectedClassId] = useState<string>("all");

  useEffect(() => {
    fetchClasses();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch on courseId change
  }, [courseId]);

  const fetchClasses = async () => {
    try {
      const { data, error } = await supabase
        .from("offerings")
        .select(`
          id,
          class_id,
          classes (
            id,
            name,
            grade_level_id,
            section_name,
            is_active
          )
        `)
        .eq("course_id", courseId);

      if (error) throw error;

      const classOptions: ClassOption[] = (data || [])
        .filter((o: any) => o.classes)
        .map((o: any) => ({
          id: o.class_id,
          name: o.classes.name,
          grade_level_id: o.classes.grade_level_id,
          section_name: o.classes.section_name,
          offeringId: o.id,
          isActive: o.classes.is_active ?? true,
        }))
        // Sort active classes first, then alphabetically by name
        .sort((a, b) => {
          if (a.isActive !== b.isActive) {
            return a.isActive ? -1 : 1;
          }
          return compareText(a.name, b.name);
        });

      setClasses(classOptions);
    } catch (error) {
      console.error("Error fetching classes:", error);
    }
  };

  const selectedOfferingId = selectedClassId !== "all"
    ? classes.find(c => c.id === selectedClassId)?.offeringId
    : undefined;

  const visiblePanels = ALL_PANELS.filter(panel => panels.includes(panel));

  const classFilter = classes.length > 0 ? (
    <div className="flex items-center gap-2">
      <GraduationCap className="w-4 h-4 text-muted-foreground" />
      <Select value={selectedClassId} onValueChange={setSelectedClassId}>
        <SelectTrigger className="w-[180px]">
          <SelectValue placeholder="Filter by class" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All Classes</SelectItem>
          {classes.map(cls => (
            <SelectItem key={cls.id} value={cls.id}>
              {buildClassDisplayName(cls)}{!cls.isActive && " (inactive)"}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  ) : null;

  /**
   * `filter` is the class selector, and only the single-panel layout passes it:
   * there it belongs *below* the panel's own tab strip, so the strip sits
   * directly under the tab that opened it and the selector reads as scoping the
   * table it stands over. The tabbed layout keeps the selector up in its header
   * row instead, where it scopes all three panels at once.
   */
  const renderPanel = (panel: Student360Panel, filter: ReactNode = null) => {
    const filterRow = filter ? (
      <div className="flex items-center justify-end mb-4">{filter}</div>
    ) : null;

    switch (panel) {
      case "evaluations":
        return (
          <>
            {filterRow}
            <StudentEvaluations courseId={courseId} offeringId={selectedOfferingId} canEdit />
          </>
        );

      case "interactions":
        return (
          <Tabs defaultValue="mcq-answers" className="w-full">
            <TabsList>
              <TabsTrigger value="mcq-answers" className="flex items-center gap-2">
                <History className="w-4 h-4" />
                Question Answers
              </TabsTrigger>
              <TabsTrigger value="student-chats" className="flex items-center gap-2">
                <MessageSquareText className="w-4 h-4" />
                Student Chats
              </TabsTrigger>
              <TabsTrigger value="question-feedback" className="flex items-center gap-2">
                <ThumbsUp className="w-4 h-4" />
                Question Feedback
              </TabsTrigger>
            </TabsList>

            {filter && (
              <div className="flex items-center justify-end mt-4 mb-4">{filter}</div>
            )}

            <TabsContent value="mcq-answers">
              <QuizHistory courseId={courseId} offeringId={selectedOfferingId} />
            </TabsContent>

            <TabsContent value="student-chats">
              <OpenQuestionChatHistory courseId={courseId} offeringId={selectedOfferingId} />
            </TabsContent>

            <TabsContent value="question-feedback">
              <QuestionFeedback courseId={courseId} offeringId={selectedOfferingId} />
            </TabsContent>
          </Tabs>
        );

      case "competencies":
        return (
          <>
            {filterRow}
            <div className="space-y-4">
              <ClassCompetencyAnalytics
                courseId={courseId}
                classes={classes.map((c) => ({
                  id: c.id,
                  name: c.name,
                  grade_level_id: c.grade_level_id,
                  section_name: c.section_name,
                  is_active: c.isActive,
                }))}
                selectedClassId={selectedClassId === "all" ? null : selectedClassId}
                showSelector={false}
              />
            </div>
          </>
        );
    }
  };

  // A lone panel needs no tab strip of its own — the caller's tab already names
  // it — so the panel takes the class selector and places it itself.
  if (visiblePanels.length === 1) {
    return <div className="w-full">{renderPanel(visiblePanels[0], classFilter)}</div>;
  }

  return (
    <Tabs defaultValue={visiblePanels[0]} className="w-full">
      <div className="flex items-center justify-between mb-4">
        <TabsList>
          {visiblePanels.map(panel => {
            const Icon = PANEL_ICONS[panel];
            return (
              <TabsTrigger key={panel} value={panel} className="flex items-center gap-2">
                <Icon className="w-4 h-4" />
                {PANEL_LABELS[panel]}
              </TabsTrigger>
            );
          })}
        </TabsList>

        {classFilter}
      </div>

      {visiblePanels.map(panel => (
        <TabsContent key={panel} value={panel}>
          {renderPanel(panel)}
        </TabsContent>
      ))}
    </Tabs>
  );
};

export default Student360;
