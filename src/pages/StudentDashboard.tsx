import { useEffect, useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Loader2, RefreshCw, BookOpen, BookOpenCheck, ClipboardList } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { useUserInstitution } from "@/hooks/useUserInstitution";
import { useStudentInstitutions } from "@/hooks/useStudentInstitutions";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { BrowseClasses } from "@/components/student/BrowseClasses";
import { BrowsePublicInstitutions } from "@/components/student/BrowsePublicInstitutions";
import { CourseGrid, DueShelf, SurfaceShell } from "@/components/student/surface";
import type { CourseDueCounts } from "@/components/student/surface/CourseGrid";
import { useDueItems, useStudentScope } from "@/hooks/useStudentSurface";
import { buildCompactClassDisplayName } from "@/lib/greek-school";
import { useInstitutionGradeLevels } from "@/hooks/useInstitutionGradeLevels";
import { useFormatters } from "@/i18n/formatters";
import { isDeadDueItem, type DueItem } from "@/lib/student-surface";

/**
 * The student dashboard: what is assigned and still open, then the timetable.
 *
 * Three sections, in the order a student triages them — quizzes that are not
 * finished, study guides that are not finished (both across every course),
 * and a card per course for everything else. Completed work does not appear
 * here at all; it stays reachable on the course page, which is also where the
 * self-paced activities (practice, flashcards, tutoring) live, as tiles on
 * its launcher. That keeps this page to one question — "what do I owe?" — and
 * keeps its data down to the enrolment scope and the assignment rows.
 *
 * Tiles deep-link straight into the activity they name — `?quiz=` / `?guide=`
 * are applied by `StudentCourse`, which opens the matching runner instead of
 * its overview.
 */
const StudentDashboard = () => {
  const { t } = useTranslation(["student", "common"]);
  const { formatDate } = useFormatters();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { user, profile, loading: authLoading, signOut } = useAuth();
  const { isAdmin, isEvaluator, loading: institutionLoading } = useUserInstitution(user?.id);

  const {
    institutions,
    currentInstitution,
    loaded: institutionsLoaded,
    refetch: fetchInstitutions,
    select: selectInstitution,
  } = useStudentInstitutions(user?.id);

  const isViewingAsStudent = searchParams.get("view") === "student";

  const scopeQuery = useStudentScope(user?.id, currentInstitution?.id ?? null);
  const scope = scopeQuery.data;
  const dueQuery = useDueItems(user?.id, scope);

  const institutionGradeLevels = useInstitutionGradeLevels(currentInstitution?.id ?? null);
  const uniqueGradeIds = [
    ...new Set((scope?.classes ?? []).map((c) => c.grade_level_id).filter(Boolean)),
  ];
  const gradeLevelLabel =
    uniqueGradeIds.length === 1
      ? institutionGradeLevels.getLabelById(uniqueGradeIds[0] as string, "el")
      : null;

  useEffect(() => {
    if (!authLoading && !user) {
      navigate("/auth");
      return;
    }
    // Admins land on their own dashboard unless they asked to preview the
    // student surface; evaluators (#667) have a separate workspace. Both waits
    // on the membership so nobody is bounced mid-fetch.
    if (!authLoading && !institutionLoading && isAdmin && !isViewingAsStudent) {
      navigate("/dashboard");
      return;
    }
    if (!authLoading && !institutionLoading && isEvaluator) {
      navigate("/evaluator");
      return;
    }
    if (
      !authLoading &&
      !institutionLoading &&
      user &&
      !sessionStorage.getItem("selectedInstitutionId")
    ) {
      navigate("/select-institution");
    }
  }, [user, isAdmin, isEvaluator, authLoading, institutionLoading, navigate, isViewingAsStudent]);

  // Every link out of a tile names the activity, not a section of the course
  // page: `StudentCourse` reads these and opens it directly.
  const courseHref = (courseId: string, deepLink?: Record<string, string>) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(deepLink ?? {})) params.set(key, value);
    if (isViewingAsStudent) params.set("view", "student");
    const query = params.toString();
    return `/student/course/${courseId}${query ? `?${query}` : ""}`;
  };

  const courses = scope?.courses ?? [];
  const dueItems = dueQuery.data ?? [];

  // The dashboard only shows what is still open; finished work lives on the
  // course page. Locked items (closed, or past-due and never started) still
  // render — inert — so a student can see what they missed.
  const openQuizzes = dueItems.filter((i) => i.kind === "quiz" && i.status !== "completed");
  const openGuides = dueItems.filter((i) => i.kind === "guide" && i.status !== "completed");

  /** Per-course actionable counts for the course cards — dead items excluded,
      so "2 quizzes due" never counts something the student cannot open. */
  const courseCounts = useMemo(() => {
    const counts = new Map<string, CourseDueCounts>();
    for (const item of [...openQuizzes, ...openGuides]) {
      if (isDeadDueItem(item)) continue;
      const entry = counts.get(item.courseId) ?? { quizzes: 0, guides: 0 };
      if (item.kind === "quiz") entry.quizzes += 1;
      else entry.guides += 1;
      counts.set(item.courseId, entry);
    }
    return counts;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- derived from dueItems
  }, [dueItems]);

  // A tile opens the activity it names. Only open work reaches this page, so
  // there is no completed branch: finished attempts are on the course page.
  const openDueItem = (item: DueItem) => {
    if (item.kind === "quiz" && item.quizId) {
      navigate(courseHref(item.courseId, { quiz: item.quizId }));
      return;
    }
    if (item.kind === "guide" && item.studyGuideId) {
      navigate(courseHref(item.courseId, { guide: item.studyGuideId }));
      return;
    }
    navigate(courseHref(item.courseId));
  };

  const greeting = useMemo(() => {
    const hour = new Date().getHours();
    const slot = hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
    return profile?.full_name
      ? t(`surface.greeting.${slot}`, { name: profile.full_name })
      : t("surface.greeting.anonymous");
  }, [profile?.full_name, t]);

  // Actionable work only, so the headline agrees with the course cards below
  // it — a closed assignment still renders (locked) but is not "due".
  const openDue = [...openQuizzes, ...openGuides].filter((i) => !isDeadDueItem(i)).length;
  const summary =
    openDue > 0 ? t("surface.summary.due", { count: openDue }) : t("surface.summary.clear");

  const classLine = (scope?.classes ?? [])
    .map((c) => buildCompactClassDisplayName(c))
    .filter(Boolean)
    .join(", ");

  if (authLoading || !institutionsLoaded) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  const handleSwitchInstitution = (institution: { id: string; name: string }) => {
    selectInstitution(institution.id);
  };

  const handleSignOut = async () => {
    await signOut();
    navigate("/auth");
  };

  const shelvesLoading = scopeQuery.isLoading || dueQuery.isLoading;

  return (
    <SurfaceShell
      institutions={institutions}
      currentInstitution={currentInstitution}
      onSwitchInstitution={handleSwitchInstitution}
      profileName={profile?.full_name ?? null}
      gradeLevelLabel={gradeLevelLabel}
      isViewingAsStudent={isViewingAsStudent}
      isAdmin={isAdmin}
      onSignOut={handleSignOut}
    >
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold text-foreground sm:text-3xl">
            {greeting}
          </h1>
          <p className="mt-1.5 text-sm text-muted-foreground sm:text-base">{summary}</p>
        </div>
        {(classLine || currentInstitution) && (
          <p className="text-sm text-muted-foreground">
            {[classLine, currentInstitution?.name].filter(Boolean).join(" · ")}
          </p>
        )}
      </div>

      {!currentInstitution ? (
        <Card className="py-12">
          <CardContent className="text-center">
            <BookOpen className="mx-auto mb-4 h-12 w-12 text-muted-foreground" />
            <p className="text-muted-foreground">{t("dashboard.noInstitutionTitle")}</p>
            <p className="mb-4 mt-1 text-sm text-muted-foreground">
              {t("dashboard.noInstitutionHint")}
            </p>
            <Button variant="outline" onClick={() => fetchInstitutions()}>
              <RefreshCw className="mr-2 h-4 w-4" />
              {t("dashboard.refreshNow")}
            </Button>
          </CardContent>
        </Card>
      ) : courses.length === 0 && !scopeQuery.isLoading ? (
        <Card className="py-12">
          <CardContent className="text-center">
            <BookOpen className="mx-auto mb-4 h-12 w-12 text-muted-foreground" />
            <p className="text-muted-foreground">{t("dashboard.noCoursesTitle")}</p>
            <p className="mt-1 text-sm text-muted-foreground">{t("dashboard.noCoursesHint")}</p>
          </CardContent>
        </Card>
      ) : (
        <>
          <DueShelf
            items={openQuizzes}
            loading={shelvesLoading}
            title={t("surface.quizzes.title")}
            icon={ClipboardList}
            empty={t("surface.quizzes.empty")}
            testId="shelf-quizzes"
            accentIndex={1}
            onOpen={openDueItem}
          />
          <DueShelf
            items={openGuides}
            loading={shelvesLoading}
            title={t("surface.guides.title")}
            icon={BookOpenCheck}
            empty={t("surface.guides.empty")}
            testId="shelf-guides"
            accentIndex={2}
            onOpen={openDueItem}
          />
          <CourseGrid
            courses={courses}
            counts={courseCounts}
            loading={shelvesLoading}
            onOpen={(courseId) => navigate(courseHref(courseId))}
          />
        </>
      )}

      {/* Joining things is not daily work, so it sits under the sections. */}
      {user && (
        <BrowsePublicInstitutions
          userId={user.id}
          memberInstitutionIds={institutions.map((i) => i.id)}
          onJoinSuccess={() => fetchInstitutions()}
        />
      )}
      {currentInstitution && user && (
        <BrowseClasses
          userId={user.id}
          institutionId={currentInstitution.id}
          enrolledClassIds={(scope?.classes ?? []).map((c) => c.id)}
          onEnrollmentChange={() => scopeQuery.refetch()}
        />
      )}

      {(profile?.father_name || profile?.date_of_birth) && (
        <div className="mt-6 flex flex-wrap items-center gap-4 border-t border-border pt-4 text-sm text-muted-foreground">
          {profile.father_name && (
            <span>
              {t("profile.fatherName")}{" "}
              <span className="font-medium text-foreground">{profile.father_name}</span>
            </span>
          )}
          {profile.date_of_birth && (
            <span>
              {t("profile.dateOfBirth")}{" "}
              <span className="font-medium text-foreground">
                {formatDate(profile.date_of_birth + "T12:00:00")}
              </span>
            </span>
          )}
        </div>
      )}
    </SurfaceShell>
  );
};

export default StudentDashboard;
