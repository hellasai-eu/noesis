import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { format } from "date-fns";
import {
  ArrowLeft,
  BookOpen,
  Calendar,
  GraduationCap,
  Loader2,
  Mail,
  School,
  User as UserIcon,
  Users,
} from "lucide-react";
import { toast } from "sonner";

import { useAuth } from "@/hooks/useAuth";
import { useUserInstitution } from "@/hooks/useUserInstitution";
import { supabase } from "@/integrations/supabase/client";
import { buildClassDisplayName } from "@/lib/greek-school";
import { useInstitutionGradeLevels } from "@/hooks/useInstitutionGradeLevels";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { InstructorHomeButton } from "@/components/InstructorHomeButton";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Separator } from "@/components/ui/separator";
import { AiDisclaimer } from "@/components/AiDisclaimer";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  CompetencyScoreEditor,
  type CompetencyGridEntry,
} from "@/components/student-evaluations/CompetencyScoreEditor";
import { currentLocale, dateFnsLocaleFor, formatDate as formatShortDate, useFormatters } from "@/i18n/formatters";

interface StudentInfo {
  userId: string;
  fullName: string | null;
  email: string | null;
  fatherName: string | null;
  dateOfBirth: string | null;
  gradeLevelId: string | null;
  institutionId: string | null;
  institutionName: string | null;
  enrolledAt: string | null;
}

interface EvaluationRow {
  id: string;
  overallAssessment: string | null;
  strengths: string[];
  weaknesses: string[];
  recommendations: string[];
  generatedAt: string;
  instructorFeedback: string | null;
  isManual: boolean;
  competencyScores: CompetencyGridEntry[];
}

interface CourseEntry {
  courseId: string;
  courseTitle: string;
  offeringId: string | null;
  classDisplayName: string;
  classActive: boolean;
  evaluations: EvaluationRow[];
}

const formatDate = (value: string | null | undefined): string => {
  if (!value) return "—";
  try {
    return format(new Date(value), "PPP", { locale: dateFnsLocaleFor(currentLocale()) });
  } catch {
    return value;
  }
};

const formatDOB = (value: string | null | undefined): string => {
  if (!value) return "—";
  // Noon, so a date-only value does not slip a day either side of UTC.
  return formatShortDate(value + "T12:00:00", undefined, value);
};

const InfoField = ({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof UserIcon;
  label: string;
  value: string | null | undefined;
}) => (
  <div className="flex items-start gap-3">
    <div className="mt-0.5 text-muted-foreground shrink-0">
      <Icon className="w-4 h-4" />
    </div>
    <div className="min-w-0">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm font-medium break-words">{value || "—"}</p>
    </div>
  </div>
);

const BulletList = ({ items }: { items: string[] }) => {
  if (!items || items.length === 0) {
    return <p className="text-sm text-muted-foreground italic">None recorded.</p>;
  }
  return (
    <ul className="list-disc list-inside space-y-1 text-sm">
      {items.map((item, idx) => (
        <li key={idx} className="text-foreground">
          {item}
        </li>
      ))}
    </ul>
  );
};

const EvaluationSummary = ({ evaluation }: { evaluation: EvaluationRow }) => (
  <div className="space-y-3">
    {/*
      `generate-student-evaluation` writes the assessment, strengths, weaknesses
      and recommendations below (#936). An evaluation an instructor wrote or
      overrode carries `is_manual`, and labelling a teacher's own judgement as
      machine output would be the same transparency failure in reverse — so the
      notice is conditional. `instructorFeedback` is always human and sits under
      its own heading.
    */}
    {!evaluation.isManual && <AiDisclaimer assessment />}
    {evaluation.overallAssessment && (
      <div>
        <p className="text-xs font-medium text-muted-foreground mb-1">
          Overall assessment
        </p>
        <p className="text-sm whitespace-pre-wrap">
          {evaluation.overallAssessment}
        </p>
      </div>
    )}
    <div className="grid gap-3 md:grid-cols-3">
      <div>
        <p className="text-xs font-medium text-muted-foreground mb-1">
          Strengths
        </p>
        <BulletList items={evaluation.strengths} />
      </div>
      <div>
        <p className="text-xs font-medium text-muted-foreground mb-1">
          Weaknesses
        </p>
        <BulletList items={evaluation.weaknesses} />
      </div>
      <div>
        <p className="text-xs font-medium text-muted-foreground mb-1">
          Recommendations
        </p>
        <BulletList items={evaluation.recommendations} />
      </div>
    </div>
    {evaluation.instructorFeedback && (
      <div>
        <p className="text-xs font-medium text-muted-foreground mb-1">
          Instructor feedback
        </p>
        <p className="text-sm whitespace-pre-wrap">
          {evaluation.instructorFeedback}
        </p>
      </div>
    )}
  </div>
);

const renderCourseCard = (
  course: CourseEntry,
  {
    expandedCourseHistory,
    toggleCourseHistory,
  }: {
    expandedCourseHistory: Set<string>;
    toggleCourseHistory: (courseId: string) => void;
  },
) => {
  const latest = course.evaluations[0] || null;
  const history = course.evaluations.slice(1);
  const historyExpanded = expandedCourseHistory.has(course.courseId);
  return (
    <Card key={course.courseId}>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="text-base">{course.courseTitle}</CardTitle>
            <CardDescription className="flex flex-wrap items-center gap-2 pt-1">
              <span>{course.classDisplayName}</span>
              <Badge
                variant={course.classActive ? "default" : "secondary"}
                className="text-[10px]"
              >
                {course.classActive ? "Active" : "Inactive"}
              </Badge>
            </CardDescription>
          </div>
          <Badge variant="outline" className="text-[10px]">
            {course.evaluations.length} eval
            {course.evaluations.length === 1 ? "" : "s"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {!latest ? (
          <p className="text-sm text-muted-foreground">
            No evaluation generated for this course yet.
          </p>
        ) : (
          <>
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">
                Latest evaluation · {formatDate(latest.generatedAt)}
                {latest.isManual && (
                  <span className="ml-2 italic">manual</span>
                )}
              </p>
            </div>
            <EvaluationSummary evaluation={latest} />

            {latest.competencyScores.length > 0 && (
              <>
                <Separator />
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-2">
                    Course competency scores
                  </p>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {latest.competencyScores.map((entry) => (
                      <CompetencyScoreEditor
                        key={entry.competencyId}
                        entry={entry}
                        evaluationId={latest.id}
                        canEdit={false}
                        hasEvaluation
                        onSaved={() => {}}
                      />
                    ))}
                  </div>
                </div>
              </>
            )}

            {history.length > 0 && (
              <>
                <Separator />
                <Collapsible
                  open={historyExpanded}
                  onOpenChange={() => toggleCourseHistory(course.courseId)}
                >
                  <CollapsibleTrigger className="text-sm font-medium text-muted-foreground hover:text-foreground">
                    {historyExpanded ? "Hide" : "Show"} evaluation history (
                    {history.length})
                  </CollapsibleTrigger>
                  <CollapsibleContent className="pt-3 space-y-4">
                    {history.map((evaluation) => (
                      <div
                        key={evaluation.id}
                        className="rounded-md border bg-muted/30 p-3 space-y-3"
                      >
                        <p className="text-xs text-muted-foreground">
                          {formatDate(evaluation.generatedAt)}
                          {evaluation.isManual && (
                            <span className="ml-2 italic">manual</span>
                          )}
                        </p>
                        <EvaluationSummary evaluation={evaluation} />
                      </div>
                    ))}
                  </CollapsibleContent>
                </Collapsible>
              </>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
};

const StudentProfile = () => {
  const { compareText } = useFormatters();
  const { userId } = useParams<{ userId: string }>();
  const navigate = useNavigate();
  const { user, profile, loading: authLoading } = useAuth();
  const { isStudent, loading: institutionLoading } = useUserInstitution(user?.id);

  const [loading, setLoading] = useState(true);
  const [accessDenied, setAccessDenied] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [student, setStudent] = useState<StudentInfo | null>(null);
  const [courses, setCourses] = useState<CourseEntry[]>([]);
  const [expandedCourseHistory, setExpandedCourseHistory] = useState<
    Set<string>
  >(new Set());

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      navigate("/auth");
      return;
    }
    // This bounce used to read `profile?.role`, but `Profile` has no `role` —
    // a user's role lives on `user_institutions`, not `profiles` — so it was
    // always `undefined === "student"` and never fired. Students fell through
    // to the access check below and got the access-denied screen instead of
    // their own dashboard. Now sourced from `useUserInstitution`, which is
    // where the role actually is, and gated on its load so the redirect does
    // not fire before membership is known.
    if (institutionLoading) return;
    if (isStudent) {
      navigate("/student");
      return;
    }
    if (!userId) {
      setNotFound(true);
      setLoading(false);
      return;
    }

    let cancelled = false;

    const run = async () => {
      setLoading(true);
      setAccessDenied(false);
      setNotFound(false);

      try {
        // Load the target student's institution membership first — we need it
        // for access checks and to display institution info.
        const selectedInstitutionId = sessionStorage.getItem(
          "selectedInstitutionId",
        );

        let studentMembershipQuery = supabase
          .from("user_institutions")
          .select("id, user_id, institution_id, role, grade_level_id, created_at")
          .eq("user_id", userId)
          .eq("role", "student");

        if (selectedInstitutionId) {
          studentMembershipQuery = studentMembershipQuery.eq(
            "institution_id",
            selectedInstitutionId,
          );
        }

        const { data: studentMemberships } = await studentMembershipQuery;
        const studentMembership =
          (studentMemberships && studentMemberships[0]) || null;

        if (!studentMembership) {
          if (!cancelled) {
            setNotFound(true);
            setLoading(false);
          }
          return;
        }

        const studentInstitutionId = studentMembership.institution_id;

        // Access check.
        const { data: isSuperAdmin } = await supabase.rpc("is_super_admin", {
          _user_id: user.id,
        });

        let allowed = Boolean(isSuperAdmin);

        if (!allowed) {
          const { data: isAdmin } = await supabase.rpc(
            "is_institution_admin",
            {
              _user_id: user.id,
              _institution_id: studentInstitutionId,
            },
          );
          if (isAdmin) allowed = true;
        }

        if (!allowed) {
          // Instructor: permit only if they teach the student.
          //
          // This used to intersect the student's classes with the instructor's
          // rows in `course_instructor_sections`, which inverts the #59
          // semantic: no rows there means *unrestricted*, not "no sections". An
          // instructor with full access to the course has an empty set to
          // intersect against, so the intersection was empty and the page
          // denied exactly the people entitled to everything.
          //
          // `instructor_teaches_student` is the same predicate the
          // `user_institutions` SELECT policy uses, so the page cannot drift
          // from the rule that decides whether it can read the row at all.
          // No `_user_id`: the function reads the caller from `auth.uid()`, so
          // the rpc cannot be asked whether somebody else teaches somebody
          // else.
          const { data: teaches } = await supabase.rpc(
            "instructor_teaches_student",
            {
              _student_id: userId,
              _institution_id: studentInstitutionId,
            },
          );
          allowed = Boolean(teaches);
        }

        if (!allowed) {
          if (!cancelled) {
            setAccessDenied(true);
            setLoading(false);
          }
          return;
        }

        // Parallel data fetch: profile, institution name, course enrollments,
        // evaluations.
        const [
          profileRes,
          institutionRes,
          enrollmentsRes,
          evaluationsRes,
        ] = await Promise.all([
          supabase
            .from("profiles")
            .select("user_id, full_name, email, father_name, date_of_birth")
            .eq("user_id", userId)
            .maybeSingle(),
          supabase
            .from("institutions")
            .select("id, name")
            .eq("id", studentInstitutionId)
            .maybeSingle(),
          supabase
            .from("class_enrollments")
            .select(
              "class_id, role, enrolled_at, classes!inner(id, name, grade_level_id, section_name, category, is_active, institution_id, offerings(id, course_id, is_active, courses(id, title)))",
            )
            .eq("user_id", userId)
            .eq("role", "student")
            .eq("classes.institution_id", studentInstitutionId),
          supabase
            .from("student_evaluations")
            .select(
              "id, course_id, offering_id, overall_assessment, strengths, weaknesses, recommendations, generated_at, instructor_feedback, is_manual",
            )
            .eq("user_id", userId)
            .order("generated_at", { ascending: false }),
        ]);

        if (cancelled) return;

        // Student info card.
        const profile = profileRes.data;
        const studentInfo: StudentInfo = {
          userId: studentMembership.user_id,
          fullName: profile?.full_name ?? null,
          email: profile?.email ?? null,
          fatherName: profile?.father_name ?? null,
          dateOfBirth: profile?.date_of_birth ?? null,
          gradeLevelId: studentMembership.grade_level_id ?? null,
          institutionId: studentInstitutionId,
          institutionName: institutionRes.data?.name ?? null,
          enrolledAt: studentMembership.created_at ?? null,
        };
        setStudent(studentInfo);

        // Build per-course entries from enrollments. offerings are nested
        // inside classes — PostgREST joins class_enrollments → classes via
        // class_id, and classes → offerings via offerings.class_id. We dedupe
        // by courseId and keep one class display name per course.
        type OfferingRow = {
          id: string;
          course_id: string;
          is_active: boolean | null;
          courses: { id: string; title: string | null } | null;
        };
        type ClassRow = {
          id: string;
          name: string | null;
          grade_level_id: string | null;
          section_name: string | null;
          category: string | null;
          is_active: boolean | null;
          institution_id: string;
          offerings: OfferingRow[] | OfferingRow | null;
        };
        type EnrollmentRow = {
          class_id: string;
          role: string;
          enrolled_at: string | null;
          classes: ClassRow | null;
        };

        const courseMap = new Map<string, CourseEntry>();
        for (const row of (enrollmentsRes.data || []) as EnrollmentRow[]) {
          const cls = row.classes;
          if (!cls) continue;
          const offerings = Array.isArray(cls.offerings)
            ? cls.offerings
            : cls.offerings
              ? [cls.offerings]
              : [];
          for (const offering of offerings) {
            if (!offering || !offering.course_id) continue;
            const course = offering.courses;
            const courseId = offering.course_id;
            const courseTitle = course?.title || "Untitled course";
            if (courseMap.has(courseId)) continue;
            courseMap.set(courseId, {
              courseId,
              courseTitle,
              offeringId: offering.id ?? null,
              classDisplayName: buildClassDisplayName(cls),
              classActive: Boolean(cls.is_active && offering.is_active),
              evaluations: [],
            });
          }
        }

        // Load competency scores only for evaluations that will be rendered.
        const evaluationIds = (evaluationsRes.data || [])
          .filter((e) => courseMap.has(e.course_id))
          .map((e) => e.id);
        type CompetencyScoreRow = {
          evaluation_id: string;
          competency_id: string;
          score: number | null;
          rationale: string | null;
          is_manual: boolean | null;
          course_competencies: { id: string; title: string | null } | null;
        };
        let scoresByEvaluation = new Map<string, CompetencyScoreRow[]>();
        if (evaluationIds.length > 0) {
          const { data: scoresData } = await supabase
            .from("evaluation_competency_scores")
            .select(
              "evaluation_id, competency_id, score, rationale, is_manual, course_competencies(id, title)",
            )
            .in("evaluation_id", evaluationIds);
          scoresByEvaluation = new Map();
          for (const row of (scoresData || []) as CompetencyScoreRow[]) {
            const list = scoresByEvaluation.get(row.evaluation_id) || [];
            list.push(row);
            scoresByEvaluation.set(row.evaluation_id, list);
          }
        }

        for (const ev of evaluationsRes.data || []) {
          const entry = courseMap.get(ev.course_id);
          if (!entry) continue;
          const rawScores = scoresByEvaluation.get(ev.id) || [];
          const scores: CompetencyGridEntry[] = rawScores.map((s) => {
            const hasScore = s.score !== null && s.score !== undefined;
            return {
              competencyId: s.competency_id,
              title: s.course_competencies?.title || "",
              score: hasScore ? Number(s.score) : null,
              rationale: s.rationale,
              status: hasScore ? "scored" : "insufficient",
              isManual: Boolean(s.is_manual),
            };
          });
          scores.sort((a, b) => compareText(a.title, b.title));
          entry.evaluations.push({
            id: ev.id,
            overallAssessment: ev.overall_assessment,
            strengths: Array.isArray(ev.strengths) ? ev.strengths : [],
            weaknesses: Array.isArray(ev.weaknesses) ? ev.weaknesses : [],
            recommendations: Array.isArray(ev.recommendations)
              ? ev.recommendations
              : [],
            generatedAt: ev.generated_at,
            instructorFeedback: ev.instructor_feedback,
            isManual: Boolean(ev.is_manual),
            competencyScores: scores,
          });
        }

        const orderedCourses = Array.from(courseMap.values()).sort((a, b) => {
          // Active courses first, then alphabetical.
          if (a.classActive !== b.classActive) return a.classActive ? -1 : 1;
          return compareText(a.courseTitle, b.courseTitle);
        });
        setCourses(orderedCourses);
      } catch (error) {
        console.error("Failed to load student profile", error);
        if (!cancelled) {
          toast.error("Failed to load student profile");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    run();
    return () => {
      cancelled = true;
    };
  }, [user, profile, authLoading, isStudent, institutionLoading, userId, navigate, compareText]);

  const toggleCourseHistory = (courseId: string) => {
    setExpandedCourseHistory((prev) => {
      const next = new Set(prev);
      if (next.has(courseId)) next.delete(courseId);
      else next.add(courseId);
      return next;
    });
  };

  const institutionGradeLevels = useInstitutionGradeLevels(student?.institutionId ?? null);
  const gradeLabel = useMemo(() => {
    if (!student?.gradeLevelId) return null;
    return institutionGradeLevels.getLabelById(student.gradeLevelId, "el");
  }, [student?.gradeLevelId, institutionGradeLevels]);

  const activeCourses = useMemo(
    () => courses.filter((c) => c.classActive),
    [courses],
  );
  const pastCourses = useMemo(
    () => courses.filter((c) => !c.classActive),
    [courses],
  );

  if (authLoading || loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (accessDenied) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-50 dark:from-background dark:to-background">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
          <Card>
            <CardHeader>
              <CardTitle>Access denied</CardTitle>
              <CardDescription>
                You do not have permission to view this student's profile.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button variant="outline" onClick={() => navigate(-1)}>
                <ArrowLeft className="w-4 h-4 mr-2" />
                Back
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  if (notFound || !student) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-50 dark:from-background dark:to-background">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
          <Card>
            <CardHeader>
              <CardTitle>Student not found</CardTitle>
              <CardDescription>
                We couldn't find a student profile for the given id in your
                institution.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button variant="outline" onClick={() => navigate(-1)}>
                <ArrowLeft className="w-4 h-4 mr-2" />
                Back
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <TooltipProvider>
      <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-50 dark:from-background dark:to-background">
        <div className="border-b bg-background/70 backdrop-blur">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex items-center gap-3">
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigate(-1)}
              className="gap-2"
            >
              <ArrowLeft className="w-4 h-4" />
              Back
            </Button>
            <div className="min-w-0">
              <h1 className="text-lg sm:text-xl font-semibold truncate">
                {student.fullName || "Unnamed student"}
              </h1>
              <p className="text-xs text-muted-foreground truncate">
                Student profile
              </p>
            </div>
            <div className="ml-auto">
              <InstructorHomeButton />
            </div>
          </div>
        </div>

        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
          {/* Student Info */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <UserIcon className="w-4 h-4" />
                Student information
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <InfoField
                  icon={UserIcon}
                  label="Full name"
                  value={student.fullName}
                />
                <InfoField icon={Mail} label="Email" value={student.email} />
                <InfoField
                  icon={Users}
                  label="Father's name"
                  value={student.fatherName}
                />
                <InfoField
                  icon={Calendar}
                  label="Date of birth"
                  value={formatDOB(student.dateOfBirth)}
                />
                <InfoField
                  icon={GraduationCap}
                  label="Grade level"
                  value={gradeLabel}
                />
                <InfoField
                  icon={School}
                  label="Institution"
                  value={student.institutionName}
                />
                <InfoField
                  icon={Calendar}
                  label="Enrolled"
                  value={formatDate(student.enrolledAt)}
                />
              </div>
            </CardContent>
          </Card>

          {/* Courses */}
          <div className="space-y-6">
            <div className="flex items-center gap-2">
              <BookOpen className="w-4 h-4 text-muted-foreground" />
              <h2 className="text-base font-semibold">Courses</h2>
              <Badge variant="secondary">{courses.length}</Badge>
            </div>

            {courses.length === 0 ? (
              <Card>
                <CardContent className="py-8 text-center text-sm text-muted-foreground">
                  This student is not enrolled in any courses yet.
                </CardContent>
              </Card>
            ) : (
              <>
                <section className="space-y-3">
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                      Active courses
                    </h3>
                    <Badge variant="secondary">{activeCourses.length}</Badge>
                  </div>
                  {activeCourses.length === 0 ? (
                    <Card>
                      <CardContent className="py-6 text-center text-sm text-muted-foreground">
                        No active courses.
                      </CardContent>
                    </Card>
                  ) : (
                    activeCourses.map((course) =>
                      renderCourseCard(course, {
                        expandedCourseHistory,
                        toggleCourseHistory,
                      }),
                    )
                  )}
                </section>

                {pastCourses.length > 0 && (
                  <section className="space-y-3">
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                        Past courses
                      </h3>
                      <Badge variant="secondary">{pastCourses.length}</Badge>
                    </div>
                    {pastCourses.map((course) =>
                      renderCourseCard(course, {
                        expandedCourseHistory,
                        toggleCourseHistory,
                      }),
                    )}
                  </section>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
};

export default StudentProfile;
