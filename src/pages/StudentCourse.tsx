import { ReactNode, useEffect, useRef, useState } from "react";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { isPast } from "date-fns";
import {
  ArrowLeft,
  BookOpenCheck,
  ClipboardList,
  FileText,
  History,
  Layers,
  Loader2,
  MessageCircleQuestion,
  MessagesSquare,
  Sparkles,
  StickyNote,
  Users,
  Wand2,
} from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { useUserInstitution } from "@/hooks/useUserInstitution";
import { useStudentInstitutions } from "@/hooks/useStudentInstitutions";
import { useStudentScope } from "@/hooks/useStudentSurface";
import { useInstitutionGradeLevels } from "@/hooks/useInstitutionGradeLevels";
import { useStudentPracticeQuestions } from "@/hooks/useStudentPracticeQuestions";
import { supabase } from "@/integrations/supabase/client";
import { openAnsweringModeFromPayload } from "@/lib/question-payload";
import { buildCompactClassDisplayName } from "@/lib/greek-school";
import { DAILY_LIMITS, getStartOfToday } from "@/lib/spaced-repetition";
import { compareCode, compareText } from "@/i18n/formatters";
import {
  isDeadDueItem,
  loadStudyGuideCards,
  type DueItem,
  type StudyGuideCard,
} from "@/lib/student-surface";
import { Button } from "@/components/ui/button";
import StudentQuiz from "@/components/StudentQuiz";
import CheatSheetViewer from "@/components/CheatSheetViewer";
import { StudyGuidePlayer } from "@/components/study-guide/StudyGuidePlayer";
import SpacedRepetitionReview from "@/components/SpacedRepetitionReview";
import FlashcardSessionManager from "@/components/FlashcardSessionManager";
import StudentOpenQuestions from "@/components/StudentOpenQuestions";
import StudentQuestionGenerator from "@/components/StudentQuestionGenerator";
import { UnifiedPracticeQuestionsList } from "@/components/student/UnifiedPracticeQuestionsList";
import { StudentStudySession } from "@/components/StudentStudySession";
import { WhatsNewSection, type QuizAssignment } from "@/components/student";
import { AnnouncementsSection } from "@/components/announcements";
import { StudentNotesList } from "@/components/course-notes";
import {
  CourseChips,
  CourseLauncher,
  DueTile,
  SurfaceShell,
  SurfaceSubView,
  type LauncherTile,
} from "@/components/student/surface";

interface PreDefinedQuiz {
  id: string;
  offeringQuizId: string;
  title: string;
  description: string | null;
  question_count: number;
  time_limit_minutes: number | null;
  due_date: string | null;
  completed: boolean;
  expired: boolean;
  inProgress: boolean;
  show_answers: boolean;
  closed_at: string | null;
  score?: { correct: number; total: number };
}

interface CourseMaterial {
  id: string;
  title: string | null;
  file_name: string;
}

interface Course {
  id: string;
  institution_id: string;
  title: string;
  description: string | null;
  theme: string | null;
  leaderboard_enabled: boolean;
  student_questions_enabled: boolean;
  restrict_to_completed_chapters: boolean;
  show_difficulty_to_students: boolean;
}

interface StudySession {
  id: string;
  name: string;
}

const StudentCourse = () => {
  const { t } = useTranslation("student");
  const { courseId } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user, profile, loading: authLoading, signOut } = useAuth();
  const { isAdmin } = useUserInstitution(user?.id);
  // The shell's chrome — the institution switcher, the account menu — is the
  // same on every student page, so it needs the same list the surface builds.
  const {
    institutions,
    currentInstitution,
    loaded: institutionsLoaded,
    select: selectInstitution,
  } = useStudentInstitutions(user?.id);
  // The chips name every course this student is taking, not just this one.
  // Shared React Query cache with `/student`, so arriving from the surface
  // costs no extra round trip.
  const scopeQuery = useStudentScope(user?.id, currentInstitution?.id ?? null);
  const scope = scopeQuery.data;
  const institutionGradeLevels = useInstitutionGradeLevels(currentInstitution?.id ?? null);
  const uniqueGradeIds = [
    ...new Set((scope?.classes ?? []).map((c) => c.grade_level_id).filter(Boolean)),
  ];
  const gradeLevelLabel =
    uniqueGradeIds.length === 1
      ? institutionGradeLevels.getLabelById(uniqueGradeIds[0] as string, "el")
      : null;
  const [course, setCourse] = useState<Course | null>(null);
  const [loading, setLoading] = useState(true);
  const [showQuiz, setShowQuiz] = useState(false);
  const [showUnifiedPractice, setShowUnifiedPractice] = useState(false);
  // The launcher's quiz and guide lists — sub-views like the rest, so a quiz
  // opened from the list lands back on the list when its runner closes.
  const [showQuizList, setShowQuizList] = useState(false);
  const [showGuideList, setShowGuideList] = useState(false);
  const [showMaterials, setShowMaterials] = useState(false);
  const [showNotes, setShowNotes] = useState(false);
  const [showLeaderboard, setShowLeaderboard] = useState(false);
  const [showInteractiveQuestions, setShowInteractiveQuestions] = useState(false);
  const [showQuestionGenerator, setShowQuestionGenerator] = useState(false);
  const [showStudySessions, setShowStudySessions] = useState(false);
  // The tutor session a dashboard card asked to open directly (#desktop),
  // and the offering it was published through (the session list is
  // offering-scoped, so the preferred offering may not contain it).
  const [deepLinkSessionId, setDeepLinkSessionId] = useState<string | null>(null);
  const [deepLinkOfferingId, setDeepLinkOfferingId] = useState<string | null>(null);
  const [showSpacedRepetition, setShowSpacedRepetition] = useState(false);
  const [activeSessionConfig, setActiveSessionConfig] = useState<{
    chapterIds: string[];
  } | null>(null);
  const [materials, setMaterials] = useState<CourseMaterial[]>([]);
  // Socratic-chat open questions (LEARN section). Single-answer open +
  // deterministic types all flow through the unified practice list (#757);
  // only the interactive badge survives.
  const [interactiveOpenCount, setInteractiveOpenCount] = useState(0);
  const [preDefinedQuizzes, setPreDefinedQuizzes] = useState<PreDefinedQuiz[]>([]);
  const [selectedQuiz, setSelectedQuiz] = useState<PreDefinedQuiz | null>(null);
  const [offeringId, setOfferingId] = useState<string | null>(null);
  // Which course the loaded state actually describes. On a course→course
  // navigation the component survives with `loading` false and the previous
  // course's data in state; anything keyed to "data is ready" must check this,
  // not just `loading`.
  const [loadedCourseId, setLoadedCourseId] = useState<string | null>(null);
  const [allOfferingIds, setAllOfferingIds] = useState<string[]>([]);
  const [classId, setClassId] = useState<string | null>(null);
  // The student's classes that actually offer this course — a subset of the
  // classes they attend, and the only ones this page may name.
  const [courseClassIds, setCourseClassIds] = useState<string[]>([]);
  const [studySessions, setStudySessions] = useState<StudySession[]>([]);
  const [hasCheatSheets, setHasCheatSheets] = useState(false);
  const [notesCount, setNotesCount] = useState(0);
  const [studyGuides, setStudyGuides] = useState<StudyGuideCard[]>([]);
  const [activeStudyGuide, setActiveStudyGuide] = useState<StudyGuideCard | null>(null);
  const [mistakesCount, setMistakesCount] = useState(0);
  const [flashcardsDueCount, setFlashcardsDueCount] = useState(0);

  // The practice list's own loader, reused here for a count: "12 left to
  // answer" is what makes the practice row (and the Next-up fallback) worth
  // reading. `null` while it loads, so the copy never claims a wrong number.
  const { questions: practiceQuestions, loading: practiceLoading } =
    useStudentPracticeQuestions(courseId ?? "");
  const practiceTotal = practiceQuestions.length;
  const practiceRemaining = practiceLoading
    ? null
    : practiceQuestions.filter((q) => q.status !== "completed").length;

  // Check if admin is viewing as student
  const isViewingAsStudent = searchParams.get("view") === "student";

  useEffect(() => {
    if (!authLoading && !user) {
      navigate("/auth");
    }
  }, [user, authLoading, navigate]);

  useEffect(() => {
    if (courseId && user) {
      fetchCourseData();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch on courseId/user change
  }, [courseId, user]);

  // Deep links from the student desktop (#desktop): `?quiz=`, `?guide=` and
  // `?session=` open the named activity directly instead of landing on the
  // course overview. Applied once, after the data the sub-views need has
  // loaded, and then stripped from the URL so back-navigation out of the
  // activity lands on a clean course page.
  const deepLinkApplied = useRef(false);
  useEffect(() => {
    // The component instance survives a course→course param change; a fresh
    // courseId means any deep link in the new URL has not been applied yet.
    deepLinkApplied.current = false;
  }, [courseId]);
  useEffect(() => {
    // `loadedCourseId` and not just `loading`: on a course→course navigation
    // the previous course's data is still in state with `loading` false, and
    // consuming the new URL's params against it would both fail to open the
    // activity and strip the link before the right data arrives.
    if (loading || loadedCourseId !== courseId || deepLinkApplied.current) return;
    const quizParam = searchParams.get("quiz");
    const guideParam = searchParams.get("guide");
    const sessionParam = searchParams.get("session");
    const interactiveParam = searchParams.get("interactive");
    // `?practice=` and `?cards=` replace the `?tab=` the shelves used to link
    // to: with the tabs gone, a tile on `/student` opens the activity itself.
    const practiceParam = searchParams.get("practice");
    const cardsParam = searchParams.get("cards");
    if (
      !quizParam &&
      !guideParam &&
      !sessionParam &&
      !interactiveParam &&
      !practiceParam &&
      !cardsParam
    ) {
      return;
    }
    deepLinkApplied.current = true;

    if (quizParam) {
      // One entry per offering assignment, so the same quiz id can appear
      // with different deadlines and closure states — the link is honored
      // through any assignment the student could start from this page.
      // The gate must be at least as strict as the UI it bypasses: a
      // completed or closed assignment has no runner to open, and an
      // untouched past-due one is disabled on this page's own rows — a
      // hand-edited or stale URL must not start it. (A started attempt
      // stays resumable.)
      const quiz = preDefinedQuizzes.find((q) => {
        if (q.id !== quizParam) return false;
        const overdue = !!q.due_date && isPast(new Date(q.due_date)) && !q.inProgress;
        return !q.completed && !q.closed_at && !overdue;
      });
      if (quiz) {
        setSelectedQuiz(quiz);
        setShowQuiz(true);
      }
    } else if (guideParam) {
      const guide = studyGuides.find((g) => g.studyGuideId === guideParam);
      if (guide) setActiveStudyGuide(guide);
    } else if (sessionParam) {
      // The dashboard names the offering the session was published through,
      // because the session list below is offering-scoped. Trust it only if
      // the student actually sits in that offering.
      const offeringParam = searchParams.get("offering");
      setDeepLinkOfferingId(
        offeringParam && allOfferingIds.includes(offeringParam) ? offeringParam : null,
      );
      setDeepLinkSessionId(sessionParam);
      setShowStudySessions(true);
    } else if (interactiveParam) {
      setShowInteractiveQuestions(true);
    } else if (practiceParam) {
      setShowUnifiedPractice(true);
    } else if (cardsParam) {
      setShowSpacedRepetition(true);
    }

    const next = new URLSearchParams(searchParams);
    next.delete("quiz");
    next.delete("guide");
    next.delete("session");
    next.delete("offering");
    next.delete("interactive");
    next.delete("practice");
    next.delete("cards");
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- apply once when data is ready
  }, [loading, loadedCourseId, courseId, preDefinedQuizzes, studyGuides, allOfferingIds, searchParams]);

  // A bookmarked course can belong to an institution other than the one the
  // session has selected — enrolment is resolved from `class_enrollments`,
  // which is institution-wide, so the course itself loads either way. The
  // chrome would not: the shell's switcher, the course chips and the grade
  // label would all name the school the student happened to leave selected.
  // So follow the course, provided they are actually a member of its
  // institution; if they are not, leave the selection alone and let the chips
  // stay away (below) rather than inventing a membership.
  //
  // Once per loaded course, and no more — this is a correction on arrival, not
  // a standing invariant. Re-running it would undo a deliberate switch: the
  // shell's institution menu changes the selection and then navigates away,
  // and an effect still watching would set it straight back on the render in
  // between.
  const institutionFollowedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!course || !institutionsLoaded || !currentInstitution) return;
    if (institutionFollowedFor.current === course.id) return;
    institutionFollowedFor.current = course.id;
    if (currentInstitution.id === course.institution_id) return;
    // An active membership, specifically. A suspended one still appears in the
    // switcher — that is what it has always done, and RLS is the real boundary
    // — but moving a student into it is a choice, and this is the one place
    // that choice is made for them.
    const membership = institutions.find((i) => i.id === course.institution_id);
    if (!membership || membership.is_suspended) return;
    selectInstitution(course.institution_id);
  }, [course, institutions, institutionsLoaded, currentInstitution, selectInstitution]);

  const fetchCourseData = async () => {
    if (!courseId || !user) return;

    try {
      // Fetch course
      const { data: courseData, error: courseError } = await supabase
        .from("courses")
        .select("id, institution_id, title, description, theme, leaderboard_enabled, student_questions_enabled, restrict_to_completed_chapters, show_difficulty_to_students")
        .eq("id", courseId)
        .maybeSingle();

      if (courseError) throw courseError;
      if (!courseData) {
        navigate("/student");
        return;
      }

      setCourse(courseData);

      // Resolve ALL offering IDs for this student and course.
      // IMPORTANT: avoid inner-joins here because students may not have read access
      // to the related tables (which would cause the join to return 0 rows).
      const { data: enrollmentRows, error: enrollmentError } = await supabase
        .from("class_enrollments")
        .select("class_id")
        .eq("user_id", user.id);

      if (enrollmentError) throw enrollmentError;

      const classIds = (enrollmentRows || []).map((r) => r.class_id);
      let allOfferingIds: string[] = [];
      let preferredOfferingId: string | null = null;

      console.log("[StudentCourse] classIds for user:", classIds);

      if (classIds.length > 0) {
        const { data: offeringRows, error: offeringError } = await supabase
          .from("offerings")
          .select("id, class_id, course_id")
          .eq("course_id", courseId)
          .in("class_id", classIds);

        if (offeringError) throw offeringError;

        allOfferingIds = (offeringRows || []).map((o) => o.id);
        console.log("[StudentCourse] allOfferingIds:", allOfferingIds);
        setAllOfferingIds(allOfferingIds);
        setCourseClassIds([...new Set((offeringRows || []).map((o) => o.class_id))]);

        // Pick the first one as preferred (used for study sessions, etc.)
        const preferredOffering = offeringRows?.[0];
        preferredOfferingId = preferredOffering?.id ?? null;
        if (preferredOfferingId) {
          setOfferingId(preferredOfferingId);
        }
        if (preferredOffering?.class_id) {
          setClassId(preferredOffering.class_id);
        }
      }

      // Fetch study sessions
      if (preferredOfferingId) {
        const { data: sessionsData } = await supabase
          .from("offering_study_sessions")
          .select(`
            study_sessions!inner (
              id,
              title
            )
          `)
          .eq("offering_id", preferredOfferingId)
          .not("published_at", "is", null);
        
        const sessions = (sessionsData || []).map((s: any) => ({
          id: s.study_sessions.id,
          name: s.study_sessions.title || 'Tutoring Session',
        }));
        setStudySessions(sessions);
      } else {
        const { data: sessionsData } = await supabase
          .from("study_sessions")
          .select("id, title")
          .eq("course_id", courseId as string)
          .eq("status", "ready");
        setStudySessions((sessionsData || []).map((s: any) => ({ id: s.id, name: s.title || 'Tutoring Session' })));
      }

      // Fetch all questions (unified: instructor + student-generated)
      const { data: allQuestionsData } = await supabase
        .from("questions")
        .select("id")
        .eq("course_id", courseId)
        .eq("hidden", false);

      // Fetch user's answers
      const { data: answersData } = await supabase
        .from("quiz_answers")
        .select("question_id, is_correct")
        .eq("course_id", courseId)
        .eq("user_id", user.id);

      // Count mistakes
      const wrongAnswers = answersData?.filter(a => !a.is_correct) || [];
      setMistakesCount(wrongAnswers.length);

      // Fetch materials
      const { data: materialsData } = await supabase
        .from("course_materials")
        .select("id, title, file_name, material_type")
        .eq("course_id", courseId);

      setMaterials((materialsData || []).map(m => ({
        id: m.id,
        title: m.title,
        file_name: m.file_name,
      })));

      // Check for cheat sheets
      const { data: chaptersData } = await supabase
        .from("material_chapters")
        .select("id, cheat_sheet, material_id")
        .in("material_id", (materialsData || []).map(m => m.id))
        .not("cheat_sheet", "is", null);
      
      setHasCheatSheets((chaptersData || []).length > 0);

      // Notes shared by the instructor. RLS on course_notes already limits the
      // rows to notes targeted at a section this student is enrolled in, so a
      // plain count over the course is the whole answer.
      const { count: notesTotal } = await supabase
        .from("course_notes")
        .select("id", { count: "exact", head: true })
        .eq("course_id", courseId);

      setNotesCount(notesTotal ?? 0);

      // Assigned study guides (#980), through the shared student-surface
      // loader so this page and the dashboard read assignments — including
      // the open-beats-closed dedupe rule — from one place.
      setStudyGuides(
        await loadStudyGuideCards(supabase, {
          userId: user.id,
          offeringIds: allOfferingIds,
        }),
      );

      // Count flashcards due for review (a review record due now or earlier),
      // scoped exactly the way `FlashcardSessionManager` scopes what it will
      // show: chapters published to this offering, and still visible. A review
      // can outlive both — an assignment withdrawn, a chapter's flashcards
      // hidden, or a card first seen through another offering of the same
      // course — and a count that ignores that puts a number on a session
      // opening at "No flashcards available". Next up promotes this to the
      // page's primary action, so the count has to mean what it says.
      let scopeChapterIds: string[] | null = null;
      // Chapter id → how many cards its deck currently holds.
      const deckLengths = new Map<string, number>();
      if (preferredOfferingId) {
        const { data: assignedRows } = await supabase
          .from("offering_chapter_flashcards")
          .select("chapter_id")
          .eq("offering_id", preferredOfferingId)
          .not("published_at", "is", null);
        const assignedIds = (assignedRows || []).map((r) => r.chapter_id);
        if (assignedIds.length > 0) {
          // The deck itself is the third condition the manager applies: a
          // chapter whose flashcards were cleared or regenerated away is
          // dropped there, while its review rows survive (they key on
          // chapter + index). Reading `flashcards` costs the deck payload for
          // the assigned chapters — the same rows the manager fetches when it
          // opens — which is the price of a badge that cannot lie.
          const { data: visibleRows } = await supabase
            .from("material_chapters")
            .select("id, flashcards")
            .in("id", assignedIds)
            .eq("flashcards_visible", true);
          for (const row of visibleRows || []) {
            if (Array.isArray(row.flashcards) && row.flashcards.length > 0) {
              deckLengths.set(row.id, row.flashcards.length);
            }
          }
          scopeChapterIds = Array.from(deckLengths.keys());
        } else {
          scopeChapterIds = [];
        }
      }
      // `null` means no offering resolved (the admin/instructor preview path),
      // where the manager itself shows every chapter — so count course-wide.
      let dueCount = 0;
      if (scopeChapterIds === null) {
        const { count } = await supabase
          .from("flashcard_reviews")
          .select("id", { count: "exact", head: true })
          .eq("user_id", user.id)
          .eq("course_id", courseId)
          .lte("due_date", new Date().toISOString());
        dueCount = count || 0;
      } else if (scopeChapterIds.length > 0) {
        // Reviews key on chapter plus card index, so a deck regenerated
        // shorter leaves rows pointing past its end. The session builds cards
        // from the deck and never reaches them, so they are counted here only
        // if the index still exists — which is why this reads rows rather than
        // asking the database for a count it cannot qualify.
        const { data: dueRows } = await supabase
          .from("flashcard_reviews")
          .select("chapter_id, flashcard_index")
          .eq("user_id", user.id)
          .eq("course_id", courseId)
          .lte("due_date", new Date().toISOString())
          .in("chapter_id", scopeChapterIds);
        dueCount = (dueRows || []).filter(
          (r) => r.flashcard_index < (deckLengths.get(r.chapter_id) ?? 0),
        ).length;
      }

      // The session hands out at most `MAX_DUE_CARDS_PER_DAY` due cards per
      // course per day, so what is due and what is reviewable today are not
      // the same number once a student has been working. A card counts against
      // the day's due quota when it was reviewed today and has been seen
      // before — `repetitions > 1` — which is the rule `SpacedRepetitionReview`
      // applies to decide it has nothing left to hand out.
      if (dueCount > 0) {
        // The day boundary comes from the shared helper: the session measures
        // its quota from UTC midnight of the local date, and a page measuring
        // from local midnight would disagree with it by the viewer's offset.
        const startOfToday = getStartOfToday();
        const { count: dueReviewedToday } = await supabase
          .from("flashcard_reviews")
          .select("id", { count: "exact", head: true })
          .eq("user_id", user.id)
          .eq("course_id", courseId)
          .gte("last_reviewed", startOfToday.toISOString())
          .gt("repetitions", 1);
        const remainingDueQuota = Math.max(
          0,
          DAILY_LIMITS.MAX_DUE_CARDS_PER_DAY - (dueReviewedToday || 0),
        );
        dueCount = Math.min(dueCount, remainingDueQuota);
      }
      setFlashcardsDueCount(dueCount);

      // Interactive (Socratic) open-question count for the LEARN-section
      // badge. The unified practice list (#754) owns all other type counts.
      let openQuestionsData: { payload: any }[] = [];

      if (preferredOfferingId) {
        const { data: assignments } = await supabase
          .from("offering_questions")
          .select("question_id")
          .eq("offering_id", preferredOfferingId)
          .not("published_at", "is", null);

        const assignedIds = (assignments || []).map((a: any) => a.question_id);
        if (assignedIds.length > 0) {
          const { data } = await supabase
            .from("questions")
            .select("id, payload")
            .eq("type", "open")
            .in("id", assignedIds)
            .eq("hidden", false);
          openQuestionsData = data || [];
        }
      } else {
        const { data } = await supabase
          .from("questions")
          .select("id, payload")
          .eq("course_id", courseId)
          .eq("type", "open")
          .eq("hidden", false);
        openQuestionsData = data || [];
      }

      let interactiveCount = 0;
      for (const row of openQuestionsData) {
        if (openAnsweringModeFromPayload(row.payload ?? null) !== "single") {
          interactiveCount += 1;
        }
      }
      setInteractiveOpenCount(interactiveCount);

      // Fetch pre-defined quizzes from offering_quizzes (class assignments)
      // Fetch quizzes for ALL offerings the student has access to
      let quizzesData: any[] = [];

      if (allOfferingIds.length > 0) {
        // Student is enrolled in classes with offerings for this course
        const { data: offeringQuizzes, error: offeringQuizzesError } = await supabase
          .from("offering_quizzes")
          .select(`
            id,
            offering_id,
            quiz_id,
            due_date,
            time_limit_override,
            published_at,
            answers_released,
            closed_at,
            quizzes!inner (
              id,
              course_id,
              title,
              description,
              time_limit_minutes,
              show_answers,
              quiz_questions(count)
            )
          `)
          .in("offering_id", allOfferingIds)
          .not("published_at", "is", null);

        if (offeringQuizzesError) {
          console.error("[StudentCourse] Error fetching offering_quizzes:", offeringQuizzesError);
        }

        console.log("[StudentCourse] offering_quizzes count:", offeringQuizzes?.length ?? 0);

        // Filter to only quizzes for this course and map to our format
        // Each offering_quizzes row is a separate assignment (same quiz can appear multiple times)
        quizzesData = (offeringQuizzes || [])
          .filter((oq: any) => oq.quizzes?.course_id === courseId)
          .map((oq: any) => ({
            id: oq.quizzes.id,
            offeringQuizId: oq.id, // unique assignment ID
            title: oq.quizzes.title,
            description: oq.quizzes.description,
            time_limit_minutes: oq.time_limit_override || oq.quizzes.time_limit_minutes,
            due_date: oq.due_date,
            // Per-assignment release overrides the global flag: answers are visible
            // when either the quiz's global show_answers or this assignment's
            // answers_released is true.
            show_answers: Boolean(oq.answers_released) || Boolean(oq.quizzes.show_answers),
            closed_at: oq.closed_at ?? null,
            quiz_questions: oq.quizzes.quiz_questions,
          }));
      }
      // Note: Quizzes are only visible when assigned to a class the student is enrolled in

      // Fetch quiz completion data
      const quizIds = (quizzesData || []).map((q: any) => q.id);
      const quizCompletionMap: Record<string, { correct: number; total: number }> = {};
      const quizSessionMap: Record<string, { status: string; expired_at: string | null; started_at: string }> = {};
      
      if (quizIds.length > 0) {
        const { data: completedAnswers } = await supabase
          .from("quiz_answers")
          .select("quiz_id, is_correct")
          .eq("user_id", user.id)
          .in("quiz_id", quizIds);

        const { data: quizSessions } = await supabase
          .from("quiz_sessions")
          .select("quiz_id, status, expired_at, started_at")
          .eq("user_id", user.id)
          .in("quiz_id", quizIds);

        // When a quiz has multiple sessions for the same user (allowed by the
        // schema), prefer the most "advanced" status so a finished attempt is
        // not hidden by a stale or fresh in-progress row.
        const statusRank = (s: string) =>
          s === "completed" ? 4 : s === "expired" ? 3 : s === "in_progress" ? 2 : 1;
        (quizSessions || []).forEach((session: any) => {
          const existing = quizSessionMap[session.quiz_id];
          if (!existing || statusRank(session.status) > statusRank(existing.status)) {
            quizSessionMap[session.quiz_id] = {
              status: session.status,
              expired_at: session.expired_at,
              started_at: session.started_at,
            };
          }
        });

        (completedAnswers || []).forEach((answer: any) => {
          if (!quizCompletionMap[answer.quiz_id]) {
            quizCompletionMap[answer.quiz_id] = { correct: 0, total: 0 };
          }
          quizCompletionMap[answer.quiz_id].total++;
          if (answer.is_correct) {
            quizCompletionMap[answer.quiz_id].correct++;
          }
        });
      }

      const quizzesWithCount = (quizzesData || []).map((q: any) => {
        const questionCount = q.quiz_questions?.[0]?.count || 0;
        const completion = quizCompletionMap[q.id];
        const session = quizSessionMap[q.id];
        // Source of truth is quiz_sessions.status. Answers without a session
        // (legacy rows) still count as in-progress so they aren't lost.
        const isCompleted = session?.status === 'completed' || session?.status === 'expired';
        const isInProgress = !isCompleted && (
          session?.status === 'in_progress' ||
          (!session && !!completion && completion.total > 0)
        );
        
        return {
          id: q.id,
          offeringQuizId: q.offeringQuizId,
          title: q.title,
          description: q.description,
          time_limit_minutes: q.time_limit_minutes,
          due_date: q.due_date,
          question_count: questionCount,
          completed: isCompleted,
          expired: false, // Expired quizzes are now auto-submitted and treated as completed
          inProgress: isInProgress,
          show_answers: q.show_answers ?? false,
          closed_at: q.closed_at ?? null,
          score: completion,
        };
      });

      setPreDefinedQuizzes(quizzesWithCount);
      setLoadedCourseId(courseId);

    } catch (error: any) {
      console.error("Error fetching course:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleQuizComplete = () => {
    setShowQuiz(false);
    fetchCourseData();
  };

  // Convert quizzes to AssessTab format
  const quizAssignments: QuizAssignment[] = preDefinedQuizzes.map(q => ({
    id: q.offeringQuizId,
    quizId: q.id,
    title: q.title,
    questionCount: q.question_count,
    timeLimit: q.time_limit_minutes,
    dueDate: q.due_date,
    publishedAt: null,
    status: q.completed ? 'completed' : q.inProgress ? 'in_progress' : q.expired ? 'not_started' : 'not_started',
    score: q.score?.correct,
    totalPoints: q.score?.total,
    showAnswers: q.show_answers,
    closedAt: q.closed_at,
  }));

  const handleSignOut = async () => {
    await signOut();
    navigate("/auth");
  };

  // Where "up" goes from a course, and how a sibling course is reached. Both
  // keep the admin's `?view=student` preview flag, which is the only reason
  // these are not plain string literals.
  const studentHref = isViewingAsStudent ? "/student?view=student" : "/student";
  const courseHref = (id: string) =>
    `/student/course/${id}${isViewingAsStudent ? "?view=student" : ""}`;

  /**
   * The course surface wears the same chrome as `/student`, and so does every
   * sub-view it opens.
   *
   * Before this, each activity brought its own sticky bar and its own gradient
   * background, so opening a quiz's sibling — the notes, the flashcards — moved
   * the page out from under the student. One shell around all of them means the
   * institution switcher, the notification bell and the account menu stay where
   * they were on the surface behind.
   */
  const shell = (body: ReactNode) => (
    <SurfaceShell
      institutions={institutions}
      currentInstitution={currentInstitution}
      onSwitchInstitution={(institution) => {
        selectInstitution(institution.id);
        // The institution decides which courses exist; this one is very likely
        // not among the new one's, so land on the surface rather than a 404.
        navigate(studentHref);
      }}
      profileName={profile?.full_name ?? null}
      gradeLevelLabel={gradeLevelLabel}
      isViewingAsStudent={isViewingAsStudent}
      isAdmin={isAdmin}
      onSignOut={handleSignOut}
    >
      {body}
    </SurfaceShell>
  );

  if (authLoading || loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!course) {
    return shell(
      <p className="rounded-xl border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
        {t("course.notFound")}
      </p>,
    );
  }

  // Three activities take the whole window: they are answering surfaces with
  // their own progress chrome, and a nav bar above them is one more thing to
  // mis-tap mid-question.
  if (showUnifiedPractice) {
    return (
      <UnifiedPracticeQuestionsList
        courseId={course.id}
        courseTitle={course.title}
        onBack={() => setShowUnifiedPractice(false)}
      />
    );
  }

  if (showQuiz) {
    return (
      <StudentQuiz
        courseId={course.id}
        courseTitle={course.title}
        quizId={selectedQuiz?.id}
        quizTitle={selectedQuiz?.title}
        timeLimitMinutes={selectedQuiz?.time_limit_minutes}
        showAnswersEnabled={selectedQuiz?.show_answers ?? true}
        showDifficulty={course.show_difficulty_to_students !== false}
        studentQuestionsEnabled={course.student_questions_enabled}
        offeringId={offeringId}
        assignmentClosedAt={selectedQuiz?.closed_at ?? null}
        onBack={() => {
          setShowQuiz(false);
          setSelectedQuiz(null);
          // Refetch so the Due shelf reflects a just-finished attempt. The quiz
          // completion screen's "Back to Course" button routes here (not
          // onComplete), so without this the tile shows a stale
          // "Available / Start" state until a manual reload.
          fetchCourseData();
        }}
        onComplete={() => {
          handleQuizComplete();
          setSelectedQuiz(null);
        }}
        onNavigateToGenerator={() => {
          setShowQuiz(false);
          setSelectedQuiz(null);
          setShowQuestionGenerator(true);
        }}
      />
    );
  }

  if (showQuestionGenerator) {
    return (
      <StudentQuestionGenerator
        courseId={course.id}
        classId={classId}
        restrictToCompletedChapters={course.restrict_to_completed_chapters}
        onBack={() => {
          setShowQuestionGenerator(false);
          fetchCourseData();
        }}
      />
    );
  }

  if (showMaterials) {
    return shell(
      <SurfaceSubView
        title={t("course.cheatSheets.title")}
        backLabel={t("surface.course.back")}
        onBack={() => setShowMaterials(false)}
      >
        <CheatSheetViewer
          courseId={course.id}
          onlyVisible={true}
          offeringId={offeringId || undefined}
        />
      </SurfaceSubView>,
    );
  }

  if (showNotes) {
    return shell(
      <SurfaceSubView
        title={t("course.notes.heading")}
        backLabel={t("surface.course.back")}
        onBack={() => setShowNotes(false)}
        width="narrow"
      >
        <StudentNotesList courseId={course.id} />
      </SurfaceSubView>,
    );
  }

  if (activeStudyGuide) {
    // No back control here: the player owns the way out, because leaving
    // mid-piece is a decision it has to record before it happens.
    return shell(
      <SurfaceSubView title={activeStudyGuide.title} backLabel={t("surface.course.back")}>
        <StudyGuidePlayer
          studyGuideId={activeStudyGuide.studyGuideId}
          offeringId={activeStudyGuide.offeringId}
          courseId={course.id}
          onBack={() => {
            setActiveStudyGuide(null);
            // Refresh so the tile's progress reflects a just-completed piece.
            fetchCourseData();
          }}
        />
      </SurfaceSubView>,
    );
  }

  if (showInteractiveQuestions) {
    return shell(
      <SurfaceSubView
        title={t("course.interactive.title")}
        backLabel={t("surface.course.back")}
        width="narrow"
      >
        <StudentOpenQuestions
          courseId={course.id}
          offeringId={offeringId}
          mode="interactive"
          onBack={() => setShowInteractiveQuestions(false)}
        />
      </SurfaceSubView>,
    );
  }

  if (showStudySessions) {
    return shell(
      <SurfaceSubView
        title={t("course.tutoring.title")}
        backLabel={t("surface.course.back")}
        width="narrow"
      >
        <StudentStudySession
          courseId={course.id}
          onBack={() => {
            setShowStudySessions(false);
            setDeepLinkSessionId(null);
            setDeepLinkOfferingId(null);
          }}
          offeringId={(deepLinkOfferingId ?? offeringId) || undefined}
          initialSessionId={deepLinkSessionId || undefined}
        />
      </SurfaceSubView>,
    );
  }

  if (showSpacedRepetition) {
    if (activeSessionConfig) {
      return shell(
        <SurfaceSubView
          title={t("course.flashcards.title")}
          backLabel={t("surface.course.back")}
          width="full"
        >
          <SpacedRepetitionReview
            courseId={course.id}
            chapterIds={activeSessionConfig.chapterIds}
            onClose={() => {
              setShowSpacedRepetition(false);
              setActiveSessionConfig(null);
            }}
          />
        </SurfaceSubView>,
      );
    }

    return shell(
      <SurfaceSubView
        title={t("course.flashcards.title")}
        backLabel={t("surface.course.back")}
        onBack={() => setShowSpacedRepetition(false)}
      >
        <FlashcardSessionManager
          courseId={course.id}
          offeringId={offeringId || undefined}
          onStartSession={(chapterIds) => {
            setActiveSessionConfig({ chapterIds });
          }}
        />
      </SurfaceSubView>,
    );
  }

  // ── Assigned work, shared by the launcher's counts and its two lists ─────
  const dueItems: DueItem[] = [
    ...quizAssignments.map(
      (quiz): DueItem => ({
        kind: "quiz",
        // The assignment, not the quiz: the same quiz can be published to two
        // of a student's offerings with different deadlines.
        id: quiz.id,
        courseId: course.id,
        courseTitle: course.title,
        title: quiz.title,
        dueDate: quiz.dueDate,
        status: quiz.status,
        quizId: quiz.quizId,
        questionCount: quiz.questionCount,
        timeLimit: quiz.timeLimit,
        closedAt: quiz.closedAt ?? null,
      }),
    ),
    ...studyGuides.map(
      (guide): DueItem => ({
        kind: "guide",
        id: guide.studyGuideId,
        courseId: course.id,
        courseTitle: course.title,
        title: guide.title,
        dueDate: guide.dueDate,
        status: guide.completedAt
          ? "completed"
          : guide.completedCount > 0
            ? "in_progress"
            : "not_started",
        studyGuideId: guide.studyGuideId,
        pieceCount: guide.pieceCount,
        completedCount: guide.completedCount,
        closedAt: guide.closedAt,
      }),
    ),
  ];

  // Open work first, finished work after it, still reachable — the course
  // page is where completed attempts stay browsable. Within each group the
  // nearest deadline leads, matching the dashboard's loader: this page's own
  // fetch carries no ordering, so the list must impose one.
  const byDueDate = (a: DueItem, b: DueItem) => {
    if (a.dueDate && b.dueDate) return compareCode(a.dueDate, b.dueDate);
    if (a.dueDate) return -1;
    if (b.dueDate) return 1;
    return compareText(a.title, b.title);
  };
  const openFirst = (items: DueItem[]) => [
    ...items.filter((i) => i.status !== "completed").sort(byDueDate),
    ...items.filter((i) => i.status === "completed").sort(byDueDate),
  ];
  const quizItems = openFirst(dueItems.filter((i) => i.kind === "quiz"));
  const guideItems = openFirst(dueItems.filter((i) => i.kind === "guide"));

  const openDueItem = (item: DueItem) => {
    if (item.kind === "guide") {
      const guide = studyGuides.find((g) => g.studyGuideId === item.studyGuideId);
      if (guide) setActiveStudyGuide(guide);
      return;
    }
    // Finished or closed attempts live in quiz history, not the runner.
    if (item.status === "completed" || item.closedAt) {
      navigate(`/student/course/${course.id}/quiz-history`);
      return;
    }
    const quiz = preDefinedQuizzes.find((q) => q.offeringQuizId === item.id);
    if (quiz) {
      setSelectedQuiz(quiz);
      setShowQuiz(true);
    }
  };

  // The launcher's two lists. They sit after the full-window views in the
  // return chain on purpose: a quiz opened from the list renders its runner
  // (`showQuiz` returns first), and closing it lands back here.
  if (showQuizList) {
    return shell(
      <SurfaceSubView
        title={t("surface.quizzes.title")}
        backLabel={t("surface.course.back")}
        onBack={() => setShowQuizList(false)}
      >
        {quizItems.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
            {t("surface.quizzes.empty")}
          </p>
        ) : (
          <div className="flex flex-wrap gap-3" data-testid="quiz-list">
            {quizItems.map((item) => (
              <DueTile key={item.id} item={item} onOpen={openDueItem} />
            ))}
          </div>
        )}
      </SurfaceSubView>,
    );
  }

  if (showGuideList) {
    return shell(
      <SurfaceSubView
        title={t("surface.guides.title")}
        backLabel={t("surface.course.back")}
        onBack={() => setShowGuideList(false)}
      >
        {guideItems.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
            {t("surface.guides.empty")}
          </p>
        ) : (
          <div className="flex flex-wrap gap-3" data-testid="guide-list">
            {guideItems.map((item) => (
              <DueTile key={item.id} item={item} onOpen={openDueItem} />
            ))}
          </div>
        )}
      </SurfaceSubView>,
    );
  }

  // Actionable work only, the same rule the launcher's counts apply — a
  // closed or missed assignment still renders (locked) but is not "due".
  const openDue = dueItems.filter(
    (i) => i.status !== "completed" && !isDeadDueItem(i),
  ).length;
  const summaryParts: string[] = [];
  if (openDue > 0) summaryParts.push(t("surface.summary.due", { count: openDue }));
  if (flashcardsDueCount > 0) {
    summaryParts.push(t("surface.summary.cards", { count: flashcardsDueCount }));
  }
  const summary = summaryParts.length > 0 ? summaryParts.join(" · ") : t("surface.summary.clear");

  // The chips are the surface's navigation, and they stay that here — except
  // that selecting another course is a route change rather than a filter.
  //
  // They only mean anything when this course is one of the ones they list. A
  // course the enrolment scope does not know about — an admin previewing a
  // course they are not enrolled in, or one in an institution the student is
  // not a member of — gets no chip row at all, rather than a row that offers
  // to navigate away from a course it does not show as selected.
  const scopeCourses = scope?.courses ?? [];
  const chipCourses = scopeCourses.some((c) => c.id === course.id) ? scopeCourses : [];

  // Only the classes that carry this course. `scope.classes` is every class
  // the student attends, which is the right list on the dashboard and a
  // misleading one in a course header.
  const classLine = (scope?.classes ?? [])
    .filter((c) => courseClassIds.includes(c.id))
    .map((c) => buildCompactClassDisplayName(c))
    .filter(Boolean)
    .join(", ");

  // Counts on the launcher mean "you can act on this now": completed and
  // dead (closed / past-due-not-started) items are excluded, the same rule
  // the dashboard's course cards apply.
  const actionable = (items: DueItem[]) =>
    items.filter((i) => i.status !== "completed" && !isDeadDueItem(i)).length;
  const openQuizCount = actionable(quizItems);
  const openGuideCount = actionable(guideItems);

  // One tile per option. Options the course does not offer are left out;
  // options that are merely empty render muted rather than disappearing, so
  // the page keeps a learnable shape.
  const launcherTiles: LauncherTile[] = [
    {
      key: "quizzes",
      title: t("surface.quizzes.title"),
      icon: ClipboardList,
      meta:
        openQuizCount > 0
          ? t("surface.courses.quizzesDue", { count: openQuizCount })
          : t("surface.courses.clear"),
      muted: openQuizCount === 0,
      onOpen: () => setShowQuizList(true),
      testId: "launcher-quizzes",
    },
    {
      key: "guides",
      title: t("surface.guides.title"),
      icon: BookOpenCheck,
      meta:
        openGuideCount > 0
          ? t("surface.courses.guidesDue", { count: openGuideCount })
          : t("surface.courses.clear"),
      muted: openGuideCount === 0,
      onOpen: () => setShowGuideList(true),
      testId: "launcher-guides",
    },
    {
      key: "practice",
      title: t("surface.launcher.practiceTitle"),
      icon: Sparkles,
      meta:
        practiceRemaining === null
          ? undefined
          : practiceTotal === 0
            ? t("surface.practise.empty")
            : practiceRemaining > 0
              ? t("surface.practise.remaining", { count: practiceRemaining })
              : t("surface.practise.allDone"),
      muted: !practiceLoading && practiceTotal === 0,
      onOpen: () => setShowUnifiedPractice(true),
      testId: "launcher-practice",
    },
    {
      key: "flashcards",
      title: t("course.flashcards.title"),
      icon: Layers,
      meta:
        flashcardsDueCount > 0
          ? t("course.flashcards.badgeDue", { count: flashcardsDueCount })
          : t("surface.cards.clear"),
      muted: flashcardsDueCount === 0,
      onOpen: () => setShowSpacedRepetition(true),
      testId: "launcher-flashcards",
    },
    {
      key: "tutoring",
      title: t("course.tutoring.title"),
      icon: MessagesSquare,
      meta:
        studySessions.length > 0
          ? t("surface.launcher.sessions", { count: studySessions.length })
          : t("surface.tutor.empty"),
      muted: studySessions.length === 0,
      onOpen: () => setShowStudySessions(true),
      testId: "launcher-tutoring",
    },
    {
      key: "interactive",
      title: t("course.interactive.title"),
      icon: MessageCircleQuestion,
      meta:
        interactiveOpenCount > 0
          ? t("course.interactive.badgeWaiting", { count: interactiveOpenCount })
          : t("course.interactive.meta"),
      muted: interactiveOpenCount === 0,
      onOpen: () => setShowInteractiveQuestions(true),
      testId: "launcher-interactive",
    },
    ...(hasCheatSheets
      ? [
          {
            key: "materials",
            title: t("course.cheatSheets.title"),
            icon: FileText,
            meta: t("course.cheatSheets.meta"),
            onOpen: () => setShowMaterials(true),
            testId: "launcher-materials",
          },
        ]
      : []),
    ...(notesCount > 0
      ? [
          {
            key: "notes",
            title: t("course.notes.title"),
            icon: StickyNote,
            meta: t("course.notes.meta", { count: notesCount }),
            onOpen: () => setShowNotes(true),
            testId: "launcher-notes",
          },
        ]
      : []),
    ...(course.student_questions_enabled
      ? [
          {
            key: "community",
            title: t("course.community.title"),
            icon: Users,
            meta: t("course.community.meta"),
            onOpen: () => navigate(`/student/course/${course.id}/community-questions`),
            testId: "launcher-community",
          },
          {
            key: "create-own",
            title: t("course.createOwn.title"),
            icon: Wand2,
            meta: t("course.createOwn.meta"),
            onOpen: () => setShowQuestionGenerator(true),
            testId: "launcher-create-own",
          },
        ]
      : []),
    {
      key: "quiz-history",
      title: t("course.quizHistory"),
      icon: History,
      meta: t("surface.launcher.historyMeta"),
      onOpen: () => navigate(`/student/course/${course.id}/quiz-history`),
      testId: "launcher-quiz-history",
    },
  ];

  return shell(
    <>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <button
            type="button"
            onClick={() => navigate(studentHref)}
            aria-label={t("surface.course.allCourses")}
            className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full border border-border text-muted-foreground transition-colors hover:bg-muted"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          </button>
          <div className="min-w-0">
            <h1 className="truncate font-display text-2xl font-bold text-foreground sm:text-3xl">
              {course.title}
            </h1>
            <p className="mt-1.5 text-sm text-muted-foreground sm:text-base">{summary}</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <p className="text-sm text-muted-foreground">
            {[course.theme, classLine, currentInstitution?.name].filter(Boolean).join(" · ")}
          </p>
          {/* The shell already offers "Back to Admin" for the dashboard; this
              one is course-scoped, so it says so rather than wearing the same
              label twice on one page. */}
          {isViewingAsStudent && isAdmin && (
            <Button
              variant="outline"
              size="sm"
              className="hidden sm:flex"
              onClick={() => navigate(`/course/${courseId}`)}
            >
              {t("course.manageCourse")}
            </Button>
          )}
        </div>
      </div>

      <CourseChips
        courses={chipCourses}
        selectedCourseId={course.id}
        onSelect={(id) => navigate(id ? courseHref(id) : studentHref)}
      />

      {/* What's New, above Announcements (#1192): it reports what has changed
          since the student was last here, which is the thing most likely to be
          worth acting on and the thing that goes stale. Announcements persist
          until they expire, and collapse once read. */}
      {user && <WhatsNewSection courseId={course.id} userId={user.id} offeringId={offeringId} />}

      {user && (
        <AnnouncementsSection
          courseId={course.id}
          allOfferingIds={allOfferingIds}
          userId={user.id}
        />
      )}

      <CourseLauncher courseId={course.id} tiles={launcherTiles} />
    </>,
  );
};

export default StudentCourse;
