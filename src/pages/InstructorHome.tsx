import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  BookOpen,
  BookOpenCheck,
  Bot,
  FileQuestion,
  LayoutGrid,
  ListChecks,
  Loader2,
  Megaphone,
  School,
  StickyNote,
  Target,
  Upload,
  Users,
} from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { useUserInstitution } from "@/hooks/useUserInstitution";
import { useIsSuperAdmin } from "@/hooks/useIsSuperAdmin";
import { getSelectedInstitutionId } from "@/lib/selected-institution";
import {
  useInstitutionSummary,
  useInstructorContent,
  useInstructorScope,
} from "@/hooks/useInstructorSurface";
import {
  COURSE_LINKS,
  deriveCourseChecklist,
  guideShelfRank,
  guideTilePresentation,
  quizShelfRank,
  quizTilePresentation,
} from "@/lib/instructor-surface";
import { subjectColorByIndex } from "@/lib/subject-colors";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { NotificationBell } from "@/components/NotificationBell";
import { UserActionMenu } from "@/components/UserActionMenu";
import { BugReportDialog } from "@/components/BugReportDialog";
import { SiteFooter } from "@/components/SiteFooter";
import { Shelf } from "@/components/student/surface/Shelf";
import { SurfaceTile } from "@/components/student/surface/SurfaceTile";
import { CourseSetupCard } from "@/components/instructor/home/CourseSetupCard";
import { QuickAction } from "@/components/instructor/home/QuickAction";
import { clearSelectedInstitutionId } from "@/lib/selected-institution";
import { cn } from "@/lib/utils";

/**
 * The instructor's landing page (#redmenta-style): not a menu of admin
 * surfaces but a "what do you want to do today?" — create things, see what
 * each course still needs, and inspect what is already out with students.
 *
 * Nothing is created here. Every action deep-links into the course workspace
 * tab that owns the flow (CoursePage reads ?tab / ?sub), so there is exactly
 * one copy of every dialog and the home page stays a router with opinions.
 */
const InstructorHome = () => {
  const navigate = useNavigate();
  const { user, profile, loading: authLoading, signOut } = useAuth();
  const {
    institutionId,
    role,
    loading: institutionLoading,
  } = useUserInstitution(user?.id);
  const [bugReportOpen, setBugReportOpen] = useState(false);
  const [classFilter, setClassFilter] = useState<string | null>(null);

  // Super admins typically have no user_institutions row, so membership-based
  // institutionId is null for them; fall back to the session-selected
  // institution (same source Dashboard reads) once the RPC confirms the role.
  const superAdminQuery = useIsSuperAdmin(user?.id);
  const isSuperAdmin = superAdminQuery.data === true;
  const effectiveInstitutionId =
    institutionId ?? (isSuperAdmin ? getSelectedInstitutionId() : null);

  const scopeQuery = useInstructorScope(user?.id, effectiveInstitutionId);
  const contentQuery = useInstructorContent(scopeQuery.data);

  useEffect(() => {
    if (!authLoading && !user) navigate("/auth");
  }, [authLoading, user, navigate]);

  // Same bounce rules as Dashboard, with the roles swapped: students and
  // evaluators have their own surfaces; admins and super admins may look
  // around. Wait for the super-admin RPC before deciding "no institution" —
  // bouncing earlier would kick out every super admin, whose membership-based
  // institutionId is always null.
  useEffect(() => {
    if (authLoading || institutionLoading || superAdminQuery.isLoading || !user) return;
    if (!effectiveInstitutionId) navigate("/select-institution");
    else if (role === "student") navigate("/student");
    else if (role === "evaluator") navigate("/evaluator");
  }, [
    authLoading,
    institutionLoading,
    superAdminQuery.isLoading,
    user,
    effectiveInstitutionId,
    role,
    navigate,
  ]);

  const institutionQuery = useInstitutionSummary(effectiveInstitutionId);

  if (authLoading || institutionLoading || (!institutionId && superAdminQuery.isLoading)) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  const courses = scopeQuery.data?.courses ?? [];
  const content = contentQuery.data;
  const loading = scopeQuery.isLoading || contentQuery.isLoading;
  const loadError = scopeQuery.isError || contentQuery.isError;

  // Class filter: scopes the setup cards and both shelves to the courses
  // offered in one class-section. Content is filtered by its course rather
  // than by where it is assigned, so unassigned work still shows up under
  // the class it could be assigned to.
  const classes = scopeQuery.data?.classes ?? [];
  const classIdsByCourse = scopeQuery.data?.classIdsByCourse ?? {};
  const courseInFilter = (courseId: string) =>
    !classFilter || (classIdsByCourse[courseId] ?? []).includes(classFilter);
  const visibleCourses = courses.filter((c) => courseInFilter(c.id));
  // Shelf order: live assigned work, then done work, then unassigned — with
  // incomplete guides (not assignable until finished) last. The loader
  // returns newest-first and Array#sort is stable, so within each bucket the
  // newest guide/quiz still leads.
  const visibleGuides = (content?.guides ?? [])
    .filter((g) => courseInFilter(g.courseId))
    .sort((a, b) => guideShelfRank(a) - guideShelfRank(b));
  const visibleQuizzes = (content?.quizzes ?? [])
    .filter((q) => courseInFilter(q.courseId))
    .sort((a, b) => quizShelfRank(a) - quizShelfRank(b));
  const firstName = profile?.full_name?.trim().split(/\s+/)[0] || "there";

  const goTo = (courseId: string, link: string) => navigate(`/course/${courseId}${link}`);

  const handleSignOut = async () => {
    clearSelectedInstitutionId();
    await signOut();
    navigate("/");
  };

  const guideAccent = subjectColorByIndex(2);
  const quizAccent = subjectColorByIndex(4);

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <nav className="sticky top-0 z-50 border-b border-border bg-card/80 backdrop-blur-sm">
        <div className="container mx-auto flex items-center justify-between gap-2 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary">
              <BookOpen className="h-6 w-6 text-primary-foreground" />
            </div>
            <div>
              <span className="font-display text-xl font-bold text-foreground">Noesis</span>
              {institutionQuery.data && (
                <p className="text-xs text-muted-foreground">{institutionQuery.data.name}</p>
              )}
            </div>
            <span className="ml-1 rounded-full bg-blue-500/20 px-2 py-0.5 text-xs text-blue-600 dark:text-blue-400">
              Instructor
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => navigate("/dashboard")}>
              <LayoutGrid className="mr-1 h-4 w-4" />
              <span className="hidden sm:inline">All courses</span>
            </Button>
            <Button variant="outline" size="sm" onClick={() => navigate("/select-institution")}>
              <School className="mr-1 h-4 w-4" />
              <span className="hidden sm:inline">Institutions</span>
            </Button>
            <NotificationBell includeAdminFeed />
            <UserActionMenu
              onSignOut={handleSignOut}
              onReportBug={() => setBugReportOpen(true)}
              roleLabel="Instructor"
            />
          </div>
        </div>
      </nav>
      <BugReportDialog open={bugReportOpen} onOpenChange={setBugReportOpen} />

      <main className="container mx-auto flex-1 px-4 py-7 sm:px-6">
        <header className="mb-7">
          <h1 className="font-display text-2xl font-bold text-foreground sm:text-3xl">
            Hi {firstName}, what do you want to <span className="text-primary">create</span>{" "}
            today?
          </h1>
          <div className="mt-4 flex flex-wrap gap-2.5">
            <QuickAction
              label="Study guide"
              icon={BookOpenCheck}
              accent={guideAccent}
              courses={courses}
              onPick={(id) => goTo(id, COURSE_LINKS.studyGuides)}
            />
            <QuickAction
              label="Quiz"
              icon={ListChecks}
              accent={quizAccent}
              courses={courses}
              onPick={(id) => goTo(id, COURSE_LINKS.quizzes)}
            />
            <QuickAction
              label="Practice questions"
              icon={FileQuestion}
              accent={subjectColorByIndex(1)}
              courses={courses}
              onPick={(id) => goTo(id, COURSE_LINKS.practiceQuestions)}
            />
            <QuickAction
              label="Upload material"
              icon={Upload}
              accent={subjectColorByIndex(3)}
              courses={courses}
              onPick={(id) => goTo(id, COURSE_LINKS.materials)}
            />
            <QuickAction
              label="Extract competencies"
              icon={Target}
              accent={subjectColorByIndex(5)}
              courses={courses}
              onPick={(id) => goTo(id, COURSE_LINKS.competencies)}
            />
            <QuickAction
              label="Announcements"
              icon={Megaphone}
              accent={subjectColorByIndex(6)}
              courses={courses}
              onPick={(id) => goTo(id, COURSE_LINKS.announcements)}
            />
            <QuickAction
              label="AI Chatbots"
              icon={Bot}
              accent={subjectColorByIndex(1)}
              courses={courses}
              onPick={(id) => goTo(id, COURSE_LINKS.aiChatbots)}
            />
            <QuickAction
              label="Distribute notes"
              icon={StickyNote}
              accent={subjectColorByIndex(3)}
              courses={courses}
              onPick={(id) => goTo(id, COURSE_LINKS.notes)}
            />
            <QuickAction
              label="My Class"
              icon={Users}
              accent={subjectColorByIndex(5)}
              courses={courses}
              onPick={(id) => goTo(id, COURSE_LINKS.myClass)}
            />
          </div>
          {classes.length > 1 && (
            <div className="mt-6 flex flex-wrap items-center gap-1.5" aria-label="Filter by class">
              <span className="mr-1 text-xs font-bold uppercase tracking-[0.07em] text-muted-foreground">
                Class
              </span>
              <button
                type="button"
                className={cn(
                  "rounded-full border px-3 py-1 text-xs font-semibold transition-colors",
                  classFilter === null
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-card text-muted-foreground hover:bg-muted",
                )}
                onClick={() => setClassFilter(null)}
              >
                All
              </button>
              {classes.map((cls) => (
                <button
                  key={cls.id}
                  type="button"
                  className={cn(
                    "rounded-full border px-3 py-1 text-xs font-semibold transition-colors",
                    classFilter === cls.id
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-card text-muted-foreground hover:bg-muted",
                  )}
                  onClick={() => setClassFilter(classFilter === cls.id ? null : cls.id)}
                >
                  {cls.name}
                </button>
              ))}
            </div>
          )}
        </header>

        {loadError ? (
          <div className="rounded-2xl border border-dashed border-border px-6 py-14 text-center">
            <p className="font-semibold text-foreground">Couldn't load your courses</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Something went wrong talking to the server. Your work is safe — try again.
            </p>
            <Button
              variant="outline"
              size="sm"
              className="mt-4"
              onClick={() => {
                scopeQuery.refetch();
                contentQuery.refetch();
              }}
            >
              Retry
            </Button>
          </div>
        ) : !loading && courses.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border px-6 py-14 text-center">
            <School className="mx-auto mb-3 h-10 w-10 text-muted-foreground" />
            <p className="font-semibold text-foreground">You're not teaching any courses yet</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Ask your institution's administrator to add you to a course — everything here
              starts from one.
            </p>
          </div>
        ) : (
          <>
            <section className="mb-8" aria-label="Course setup">
              <h2 className="mb-3 text-base font-bold tracking-tight">Get your courses ready</h2>
              {loading || !content ? (
                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                  <Skeleton className="h-[260px] rounded-2xl" />
                  <Skeleton className="h-[260px] rounded-2xl" />
                </div>
              ) : (
                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                  {visibleCourses.map((course) => (
                    <CourseSetupCard
                      key={course.id}
                      course={course}
                      checklist={deriveCourseChecklist(course.id, content)}
                      onGo={(link) => goTo(course.id, link)}
                    />
                  ))}
                </div>
              )}
            </section>

            <Shelf
              title="Study guides"
              icon={BookOpenCheck}
              accent={{ ink: guideAccent.ink, tint: guideAccent.tint }}
              count={visibleGuides.length}
              loading={loading}
              empty="No study guides yet — upload a material, then create your first one."
              testId="instructor-guides-shelf"
            >
              {visibleGuides.map((guide) => {
                const course = courses.find((c) => c.id === guide.courseId);
                const tile = guideTilePresentation(guide);
                const secondary = tile.secondaryAction;
                return (
                  <SurfaceTile
                    key={guide.id}
                    courseId={guide.courseId}
                    kicker={course?.title ?? ""}
                    title={guide.title}
                    meta={tile.meta}
                    badge={tile.badge}
                    actionLabel={tile.actionLabel}
                    onAction={() => goTo(guide.courseId, tile.link)}
                    secondaryActionLabel={secondary?.label}
                    onSecondaryAction={
                      secondary ? () => goTo(guide.courseId, secondary.link) : undefined
                    }
                    width="wide"
                    testId={`guide-tile-${guide.id}`}
                  />
                );
              })}
            </Shelf>

            <Shelf
              title="Quizzes"
              icon={ListChecks}
              accent={{ ink: quizAccent.ink, tint: quizAccent.tint }}
              count={visibleQuizzes.length}
              loading={loading}
              empty="No quizzes yet — build one from your question bank."
              testId="instructor-quizzes-shelf"
            >
              {visibleQuizzes.map((quiz) => {
                const course = courses.find((c) => c.id === quiz.courseId);
                const tile = quizTilePresentation(quiz);
                return (
                  <SurfaceTile
                    key={quiz.id}
                    courseId={quiz.courseId}
                    kicker={course?.title ?? ""}
                    title={quiz.title}
                    meta={tile.meta}
                    badge={tile.badge}
                    actionLabel={tile.actionLabel}
                    onAction={() => goTo(quiz.courseId, tile.link)}
                    width="wide"
                    testId={`quiz-tile-${quiz.id}`}
                  />
                );
              })}
            </Shelf>
          </>
        )}
      </main>

      <SiteFooter />
    </div>
  );
};

export default InstructorHome;
