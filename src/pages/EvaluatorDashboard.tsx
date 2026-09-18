/**
 * EvaluatorDashboard (#667) — dedicated landing for users whose role in the
 * selected institution is `evaluator`. Lists the courses they are assigned
 * to via `course_evaluators` (RLS-scoped — see migration
 * 20260624100000_evaluator_role_and_rls.sql) and routes each card to the
 * read-only per-course browser at `/evaluator/course/:courseId`.
 *
 * Mirrors the chrome of StudentDashboard (institution switcher, profile
 * menu, sign-out) so the surface feels consistent for users who also belong
 * to other institutions in other roles.
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { useUserInstitution } from "@/hooks/useUserInstitution";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChangePasswordDialog } from "@/components/ChangePasswordDialog";
import { MfaSettingsDialog } from "@/components/MfaSettingsDialog";
import { NotificationBell } from "@/components/NotificationBell";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import {
  BookOpen,
  Loader2,
  ClipboardCheck,
  Building2,
  ChevronDown,
  Key,
  LogOut,
  Mail,
  ShieldCheck,
  Users,
} from "lucide-react";
import { setSelectedInstitutionId } from "@/lib/selected-institution";
import { BrandMark } from "@/components/BrandMark";

interface Course {
  id: string;
  title: string;
  description: string | null;
  theme: string | null;
  institution_id: string;
}

interface Institution {
  id: string;
  name: string;
  slug: string;
  logo_url: string | null;
}

const EvaluatorDashboard = () => {
  const { t } = useTranslation(["evaluator", "common"]);
  const navigate = useNavigate();
  const { user, profile, loading: authLoading, signOut } = useAuth();
  const {
    isAdmin,
    isInstructor,
    isEvaluator,
    loading: institutionLoading,
  } = useUserInstitution(user?.id);
  const [courses, setCourses] = useState<Course[]>([]);
  const [loading, setLoading] = useState(true);
  const [institutions, setInstitutions] = useState<Institution[]>([]);
  const [currentInstitution, setCurrentInstitution] = useState<Institution | null>(null);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [mfaOpen, setMfaOpen] = useState(false);

  // Auth + role gates. Evaluators only — every other role gets bounced back to
  // their own landing so the sidebar/URL surface stays role-scoped.
  useEffect(() => {
    if (!authLoading && !user) {
      navigate("/auth");
      return;
    }
    if (!authLoading && !institutionLoading && user) {
      if (isAdmin || isInstructor) {
        navigate("/dashboard");
        return;
      }
      if (!isEvaluator) {
        navigate("/student");
        return;
      }
      if (!sessionStorage.getItem("selectedInstitutionId")) {
        navigate("/select-institution");
      }
    }
  }, [user, isAdmin, isInstructor, isEvaluator, authLoading, institutionLoading, navigate]);

  // Fetch the evaluator's member institutions so we can offer an institution
  // switcher — same UX as StudentDashboard. Only institutions where the user
  // actually has a row in `user_institutions` show up.
  useEffect(() => {
    const fetchInstitutions = async () => {
      if (!user) return;

      const { data: memberships } = await supabase
        .from("user_institutions")
        .select("institution_id")
        .eq("user_id", user.id);

      const memberInstIds = (memberships ?? []).map((m) => m.institution_id);
      if (memberInstIds.length === 0) {
        setInstitutions([]);
        setCurrentInstitution(null);
        return;
      }

      const { data: instData } = await supabase
        .from("institutions")
        .select("id, name, slug, logo_url")
        .in("id", memberInstIds);

      const list = instData ?? [];
      setInstitutions(list);

      const selectedId = sessionStorage.getItem("selectedInstitutionId");
      const current = list.find((i) => i.id === selectedId) || list[0] || null;
      setCurrentInstitution(current);
      if (current && !selectedId) {
        setSelectedInstitutionId(current.id);
      }
    };
    fetchInstitutions();
  }, [user]);

  // Load the evaluator's assigned courses for the selected institution.
  // RLS already restricts `courses` SELECT to assigned courses (see
  // 20260624100000), so the institution filter is just a UX narrowing for
  // users assigned across multiple institutions.
  useEffect(() => {
    const fetchCourses = async () => {
      if (!user || !currentInstitution) {
        setCourses([]);
        setLoading(false);
        return;
      }
      setLoading(true);
      try {
        const { data, error } = await supabase
          .from("courses")
          .select("id, title, description, theme, institution_id")
          .eq("institution_id", currentInstitution.id)
          .order("title");
        if (error) throw error;
        setCourses(data ?? []);
      } catch (err) {
        console.error("Failed to load evaluator courses", err);
        setCourses([]);
      } finally {
        setLoading(false);
      }
    };
    fetchCourses();
  }, [user, currentInstitution]);

  const handleSwitchInstitution = (institution: Institution) => {
    setSelectedInstitutionId(institution.id);
    setCurrentInstitution(institution);
    setLoading(true);
  };

  const handleSignOut = async () => {
    await signOut();
    navigate("/auth");
  };

  if (authLoading || institutionLoading || loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-primary/5 via-background to-secondary/10">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-primary/5 via-background to-secondary/10">
      <nav className="border-b border-border bg-card/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="container mx-auto px-4 sm:px-6 py-3 sm:py-4 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 sm:gap-3">
            {/* The clipboard says which surface you are on; the mark and name
                are still the product's. */}
            <BrandMark
              size="responsive"
              icon={ClipboardCheck}
              nameClassName="hidden xs:inline"
              className="gap-2 sm:gap-3"
            />
            <Badge variant="outline" className="ml-1 text-xs">
              {t("roleLabel")}
            </Badge>
          </div>

          <div className="flex items-center gap-2 sm:gap-4">
            {institutions.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="flex items-center gap-1 sm:gap-2 px-2 sm:px-3 h-8 sm:h-9">
                    <Building2 className="w-4 h-4 flex-shrink-0" />
                    <span className="hidden sm:inline max-w-[100px] md:max-w-[150px] truncate">
                      {currentInstitution?.name || t("common:institution.fallbackName")}
                    </span>
                    <ChevronDown className="w-3 h-3 sm:w-4 sm:h-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuLabel>{t("common:institution.yours")}</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {institutions.map((inst) => (
                    <DropdownMenuItem
                      key={inst.id}
                      onClick={() => handleSwitchInstitution(inst)}
                      className={inst.id === currentInstitution?.id ? "bg-muted" : ""}
                    >
                      <Building2 className="w-4 h-4 mr-2" />
                      {inst.name}
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => navigate("/select-institution")}>
                    <Users className="w-4 h-4 mr-2" />
                    {t("common:institution.browseAll")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}

            <LanguageSwitcher />

            <NotificationBell />

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="gap-1 sm:gap-2 px-2 sm:px-3 h-8 sm:h-9">
                  <span className="hidden md:inline text-muted-foreground truncate max-w-[120px]">
                    {profile?.full_name || t("roleLabel")}
                  </span>
                  <ChevronDown className="w-3 h-3 sm:w-4 sm:h-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>
                  <div className="flex flex-col">
                    <span>{profile?.full_name || t("roleLabel")}</span>
                    <span className="text-xs text-muted-foreground font-normal">{t("roleLabel")}</span>
                  </div>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => setPasswordOpen(true)}>
                  <Key className="w-4 h-4 mr-2" />
                  {t("common:actions.changePassword")}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setMfaOpen(true)}>
                  <ShieldCheck className="w-4 h-4 mr-2" />
                  {t("common:actions.twoFactorAuth")}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => navigate("/contact")}>
                  <Mail className="w-4 h-4 mr-2" />
                  {t("common:actions.contactUs")}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={handleSignOut} className="text-destructive">
                  <LogOut className="w-4 h-4 mr-2" />
                  {t("common:actions.signOut")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <ChangePasswordDialog open={passwordOpen} onOpenChange={setPasswordOpen} />
            <MfaSettingsDialog open={mfaOpen} onOpenChange={setMfaOpen} />
          </div>
        </div>
      </nav>

      <main className="container mx-auto px-4 sm:px-6 py-4 sm:py-6 lg:py-8">
        <div className="mb-4 sm:mb-6">
          <h2 className="text-xl sm:text-2xl font-display font-bold text-foreground mb-0.5 sm:mb-1">
            {t("dashboard.heading")}
          </h2>
          <p className="text-sm sm:text-base text-muted-foreground">
            {t("dashboard.subheading")}
          </p>
        </div>

        {courses.length === 0 ? (
          <Card className="py-12" data-testid="evaluator-empty-state">
            <CardContent className="text-center">
              <BookOpen className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
              <p className="text-muted-foreground">{t("dashboard.emptyTitle")}</p>
              <p className="text-sm text-muted-foreground mt-1">
                {t("dashboard.emptyHint")}
              </p>
            </CardContent>
          </Card>
        ) : (
          <div
            className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-6"
            data-testid="evaluator-course-grid"
          >
            {courses.map((course) => (
              <Card
                key={course.id}
                data-testid={`evaluator-course-card-${course.id}`}
                className="group cursor-pointer hover:shadow-lg hover:border-primary/30 transition-all duration-300 overflow-hidden active:scale-[0.98]"
                onClick={() => navigate(`/evaluator/course/${course.id}`)}
              >
                <div className="h-1.5 sm:h-2 bg-gradient-to-r from-primary to-primary/60" />
                <CardHeader className="p-4 sm:p-6">
                  {course.theme && (
                    <div className="flex items-center gap-1.5 sm:gap-2 flex-wrap mb-2">
                      <Badge variant="secondary" className="w-fit text-xs px-1.5 sm:px-2 py-0.5">
                        {course.theme}
                      </Badge>
                    </div>
                  )}
                  <CardTitle className="group-hover:text-primary transition-colors text-base sm:text-lg">
                    {course.title}
                  </CardTitle>
                  <CardDescription className="line-clamp-2 text-sm">
                    {course.description || t("common:course.noDescription")}
                  </CardDescription>
                </CardHeader>
              </Card>
            ))}
          </div>
        )}
      </main>
    </div>
  );
};

export default EvaluatorDashboard;
