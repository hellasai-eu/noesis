import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { UserActionMenu } from "@/components/UserActionMenu";
import { InstitutionLogoUpload } from "@/components/InstitutionLogoUpload";
import { SafeImage } from "@/components/SafeImage";
import { NotificationBell } from "@/components/NotificationBell";
import { BugReportDialog } from "@/components/BugReportDialog";
import AcademicYearRolloverDialog from "@/components/class-management/AcademicYearRolloverDialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { LANGUAGE_OPTIONS, getLanguageName } from "@/lib/language-options";
import { SUPPORTED_LOCALES } from "@/i18n/config";
import {
  GRADE_OPTIONS,
  GREEK_SCHOOL_LEVELS,
  getSectionDisplayName,
  type SchoolLevel,
} from "@/lib/greek-school";
import { filterGradeOptionsBySchoolLevels } from "@/lib/grade-levels";
import { useInstitutionGradeLevels } from "@/hooks/useInstitutionGradeLevels";
import { Checkbox } from "@/components/ui/checkbox";
import {
  BookOpen,
  Plus,
  LogOut,
  Users,
  FileText,
  Loader2,
  Trash2,
  Upload,
  Clock,
  Building,
  RefreshCw,
  X,
  ArrowRight,
  AlertCircle,
  Search,
  ArrowLeftRight,
  Eye,
  MessageSquare,
  Globe,
  AlertTriangle,
  UserPlus,
  Languages,
  Cloud,
  CloudOff,
  School,
  CalendarDays,
  RotateCcw,
  ChevronDown,
  Home,
  Bot,
} from "lucide-react";
import { Switch } from "@/components/ui/switch";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { BrandLogo, BrandMark } from "@/components/BrandMark";
import { brand } from "@/deployment";
import { toast } from "sonner";
import { clearSelectedInstitutionId, setSelectedInstitutionId } from "@/lib/selected-institution";
import { SiteFooter } from "@/components/SiteFooter";

/**
 * Locales the interface is actually translated into.
 *
 * `LANGUAGE_OPTIONS` below is the far longer list of languages the AI can write
 * *content* in; the two are not the same question, and `institutions.default_language`
 * feeds both.
 */
const UI_TRANSLATED_LOCALES: readonly string[] = SUPPORTED_LOCALES;

interface Course {
  id: string;
  title: string;
  description: string | null;
  theme: string | null;
  institution_id: string;
  created_at: string;
  grade_level_id: string | null;
  category: string;
  course_materials: { count: number }[];
}

interface Institution {
  id: string;
  name: string;
  slug: string;
  logo_url: string | null;
  is_public: boolean;
  default_language: string;
  vector_store_id: string | null;
  allow_self_enrollment: boolean;
  institution_type: string;
  school_levels: string[];
  academic_period: string | null;
}

interface Invitation {
  id: string;
  email: string;
  status: string;
  created_at: string;
  course_id: string | null;
}

interface SectionOption {
  id: string;
  section_name: string;
  category: string | null;
  gradeCode: string;
}

interface InstructorOption {
  user_id: string;
  full_name: string | null;
  email: string | null;
  role: "admin" | "instructor";
}

const Dashboard = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { user, profile, loading, signOut } = useAuth();
  const [courses, setCourses] = useState<Course[]>([]);
  const [institution, setInstitution] = useState<Institution | null>(null);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [userCounts, setUserCounts] = useState({ total: 0, pending: 0, instructors: 0, students: 0 });
  const [loadingData, setLoadingData] = useState(true);
  const [isCreatingCourse, setIsCreatingCourse] = useState(false);
  const [isInviting, setIsInviting] = useState(false);
  const [resendingId, setResendingId] = useState<string | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  const [superAdminChecked, setSuperAdminChecked] = useState(false);
  const [userRoleInInstitution, setUserRoleInInstitution] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [publicWarningOpen, setPublicWarningOpen] = useState(false);
  const [pendingPublicValue, setPendingPublicValue] = useState(false);
  const [isUpdatingPublic, setIsUpdatingPublic] = useState(false);
  const [isUpdatingLanguage, setIsUpdatingLanguage] = useState(false);
  const [isUpdatingSelfEnrollment, setIsUpdatingSelfEnrollment] = useState(false);
  // AI feature families the school has switched off (institutions.ai_features_disabled).
  const [aiFamiliesDisabled, setAiFamiliesDisabled] = useState<string[]>([]);
  const [updatingAiFamily, setUpdatingAiFamily] = useState<string | null>(null);
  const [rolloverDialogOpen, setRolloverDialogOpen] = useState(false);
  const [editingPeriod, setEditingPeriod] = useState(false);
  const [periodInput, setPeriodInput] = useState("");
  const [isUpdatingPeriod, setIsUpdatingPeriod] = useState(false);
  const [activeSectionCount, setActiveSectionCount] = useState(0);
  const [institutionSettingsOpen, setInstitutionSettingsOpen] = useState(false);
  const [updatingSchoolLevel, setUpdatingSchoolLevel] = useState<SchoolLevel | null>(null);
  const [pendingDisableLevel, setPendingDisableLevel] = useState<{ level: SchoolLevel; classCount: number } | null>(null);
  
  // Get effective institution ID from session storage
  const getEffectiveInstitutionId = () => {
    return sessionStorage.getItem("selectedInstitutionId");
  };

  const effectiveInstitutionId = getEffectiveInstitutionId();
  const institutionGradeLevels = useInstitutionGradeLevels(effectiveInstitutionId);

  // Refresh user institution data.
  // Polled while the user has no institution selected, so an account that was
  // just granted access picks it up without a manual reload.
  const refreshUserInstitution = async () => {
    if (!user) return;
    setIsRefreshing(true);

    const { data: memberships } = await supabase
      .from("user_institutions")
      .select("institution_id")
      .eq("user_id", user.id);

    if (memberships && memberships.length === 1) {
      // Exactly one institution — nothing to choose, drop them straight in.
      setSelectedInstitutionId(memberships[0].institution_id);
      window.location.reload();
    } else if (memberships && memberships.length > 1) {
      // Several memberships: picking one here (this used to be an unordered
      // `.limit(1)`) would land the user in an arbitrary institution. Let them
      // choose instead.
      navigate("/select-institution");
    }
    setIsRefreshing(false);
  };

  // Auto-refresh when no institution access
  useEffect(() => {
    if (!loading && user && !effectiveInstitutionId && !isSuperAdmin) {
      const interval = setInterval(() => {
        refreshUserInstitution();
      }, 5000);
      return () => clearInterval(interval);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- polling interval, refreshUserInstitution is stable
  }, [loading, user, effectiveInstitutionId, isSuperAdmin]);

  // Handle institution slug from query params (for super admin navigation)
  useEffect(() => {
    const institutionSlug = searchParams.get("institution");
    if (institutionSlug && user) {
      // Fetch institution by slug and set it in session storage
      const fetchInstitutionBySlug = async () => {
        const { data } = await supabase
          .from("institutions")
          .select("id")
          .eq("slug", institutionSlug)
          .maybeSingle();
        
        if (data) {
          setSelectedInstitutionId(data.id);
          // Remove the query param and reload
          navigate("/dashboard", { replace: true });
        }
      };
      fetchInstitutionBySlug();
    }
  }, [searchParams, user, navigate]);

  // Course form
  const [courseTitle, setCourseTitle] = useState("");
  const [courseDescription, setCourseDescription] = useState("");
  const [courseTheme, setCourseTheme] = useState("");
  const [courseLanguage, setCourseLanguage] = useState("");
  const [courseGradeLevel, setCourseGradeLevel] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);

  // Sections + instructor assignment inside the create-course dialog
  const [gradeSections, setGradeSections] = useState<SectionOption[]>([]);
  const [selectedSectionIds, setSelectedSectionIds] = useState<Set<string>>(new Set());
  const [sectionsLoading, setSectionsLoading] = useState(false);
  const [availableInstructors, setAvailableInstructors] = useState<InstructorOption[]>([]);
  const [selectedInstructorIds, setSelectedInstructorIds] = useState<Set<string>>(new Set());

  // Restrict the grade dropdown to the institution's own school levels — the
  // backfill seeds `grade_levels` rows across every school level, so the
  // institution-scoped list alone still shows e.g. Δημοτικού grades to a
  // Λύκειο-only school (#825).
  const courseGradeOptions = useMemo(
    () =>
      filterGradeOptionsBySchoolLevels(
        institutionGradeLevels.options,
        institution?.school_levels,
      ),
    [institutionGradeLevels.options, institution?.school_levels],
  );

  // Load the selected grade's active sections so the admin can pick which ones
  // the new course gets attached to. All sections start checked.
  useEffect(() => {
    const instId = getEffectiveInstitutionId();
    const gradeLevelId =
      courseGradeLevel && courseGradeLevel !== "none"
        ? institutionGradeLevels.findIdByCode(courseGradeLevel)
        : null;
    // Clear the previous grade's sections immediately — submitting while the
    // new grade's sections are still loading must not attach the course to
    // the old grade's classes.
    setGradeSections([]);
    setSelectedSectionIds(new Set());
    if (!dialogOpen || !instId || !gradeLevelId) {
      setSectionsLoading(false);
      return;
    }
    let cancelled = false;
    setSectionsLoading(true);
    const fetchSections = async () => {
      const { data, error } = await supabase
        .from("classes")
        .select("id, section_name, category")
        .eq("institution_id", instId)
        .eq("grade_level_id", gradeLevelId)
        .eq("is_active", true)
        .order("section_name");
      if (cancelled) return;
      if (error) {
        console.error("Error fetching sections:", error);
        toast.error("Failed to load this grade's sections — the course will not be attached to any section");
        setSectionsLoading(false);
        return;
      }
      const sections = (data ?? []).map((c) => ({
        id: c.id,
        section_name: c.section_name ?? "",
        category: c.category,
        gradeCode: courseGradeLevel,
      }));
      setGradeSections(sections);
      setSelectedSectionIds(new Set(sections.map((s) => s.id)));
      setSectionsLoading(false);
    };
    fetchSections();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- findIdByCode is memoized on the grade rows; the hook's wrapper object is new each render
  }, [dialogOpen, courseGradeLevel, institutionGradeLevels.findIdByCode]);

  // Load the institution's instructors/admins for optional assignment.
  // No FK between user_institutions and profiles — join client-side on user_id.
  useEffect(() => {
    if (!dialogOpen) return;
    const instId = getEffectiveInstitutionId();
    if (!instId) return;
    let cancelled = false;
    const fetchInstructors = async () => {
      const { data: members } = await supabase
        .from("user_institutions")
        .select("user_id, role")
        .eq("institution_id", instId)
        .eq("is_suspended", false)
        .in("role", ["instructor", "admin"]);
      if (cancelled) return;
      if (!members || members.length === 0) {
        setAvailableInstructors([]);
        return;
      }
      const roleMap = new Map(
        members.map((m) => [m.user_id, m.role as "admin" | "instructor"]),
      );
      const { data: profiles } = await supabase
        .from("profiles")
        .select("user_id, full_name, email")
        .in("user_id", members.map((m) => m.user_id));
      if (cancelled) return;
      setAvailableInstructors(
        (profiles ?? []).map((p) => ({
          user_id: p.user_id,
          full_name: p.full_name,
          email: p.email,
          role: roleMap.get(p.user_id) || "instructor",
        })),
      );
    };
    fetchInstructors();
    return () => {
      cancelled = true;
    };
  }, [dialogOpen]);

  const toggleSectionSelection = (classId: string) => {
    setSelectedSectionIds((prev) => {
      const next = new Set(prev);
      if (next.has(classId)) {
        next.delete(classId);
      } else {
        next.add(classId);
      }
      return next;
    });
  };

  const toggleInstructorSelection = (userId: string) => {
    setSelectedInstructorIds((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) {
        next.delete(userId);
      } else {
        next.add(userId);
      }
      return next;
    });
  };

  // Course filters
  const [filterGradeLevel, setFilterGradeLevel] = useState<string>("all");
  const [filterCategory, setFilterCategory] = useState<string>("all");

  // Vector store sync
  const [syncingCourseId, setSyncingCourseId] = useState<string | null>(null);

  // Invitation form
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);

  // Bug report dialog
  const [bugReportOpen, setBugReportOpen] = useState(false);

  // Check super admin status
  useEffect(() => {
    const checkSuperAdmin = async () => {
      if (!user) return;
      const { data } = await supabase.rpc("is_super_admin", { _user_id: user.id });
      setIsSuperAdmin(data || false);
      setSuperAdminChecked(true);
    };
    if (user) checkSuperAdmin();
  }, [user]);

  useEffect(() => {
    if (!loading && !user) {
      navigate("/auth");
      return;
    }
  }, [user, loading, navigate]);

  // Check user's role in the selected institution
  // Guard on superAdminChecked so we never redirect before is_super_admin has resolved —
  // super-admins typically have no row in user_institutions (roleData=null), so running this
  // check while isSuperAdmin is still false would incorrectly send them to /student.
  useEffect(() => {
    const checkRoleInInstitution = async () => {
      const instId = getEffectiveInstitutionId();
      if (!user || !instId || !superAdminChecked) return;

      const { data: roleData } = await supabase.rpc("get_user_role_in_institution", {
        _user_id: user.id,
        _institution_id: instId,
      });
      setUserRoleInInstitution(roleData);

      // If not admin/instructor and not super admin, send users to their own
      // role-specific landing. Evaluators (#667) get a dedicated /evaluator
      // workspace rather than being lumped into /student.
      if (roleData !== "admin" && roleData !== "instructor" && !isSuperAdmin) {
        navigate(roleData === "evaluator" ? "/evaluator" : "/student");
      }
    };

    if (user && effectiveInstitutionId) {
      checkRoleInInstitution();
    }
  }, [user, effectiveInstitutionId, isSuperAdmin, navigate, superAdminChecked]);

  useEffect(() => {
    const instId = getEffectiveInstitutionId();
    if (instId && user) {
      fetchInstitutionData(instId);
    } else if (!isSuperAdmin && !loading) {
      // No institution selected - redirect to select
      navigate("/select-institution");
    } else if (isSuperAdmin && !instId && !loading) {
      // Super admin without selected institution - redirect to select
      navigate("/select-institution");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch on institution/user change
  }, [effectiveInstitutionId, isSuperAdmin, navigate, user, loading]);

  const fetchInstitutionData = async (institutionId: string) => {
    if (!institutionId || !user) return;

    try {
      // Fetch institution
      const { data: instData } = await supabase
        .from("institutions")
        .select("*")
        .eq("id", institutionId)
        .maybeSingle();

      if (instData) {
        setInstitution(instData);
        // Set course language default to institution's default language
        setCourseLanguage(instData.default_language || "en");
        // jsonb column; the CHECK constraint keeps it a subset of the known families.
        setAiFamiliesDisabled(
          Array.isArray(instData.ai_features_disabled)
            ? (instData.ai_features_disabled as string[])
            : [],
        );
      }

      // Fetch courses
      const { data: coursesData } = await supabase
        .from("courses")
        .select("id, title, description, theme, institution_id, created_at, grade_level_id, category, course_materials(count)")
        .eq("institution_id", institutionId)
        .order("created_at", { ascending: false });

      if (coursesData) {
        setCourses(coursesData);
      }

      // Fetch invitations and user counts if admin or super admin
      const { data: roleData } = await supabase.rpc("get_user_role_in_institution", {
        _user_id: user.id,
        _institution_id: institutionId,
      });
      
      if (roleData === "admin" || isSuperAdmin) {
        const { data: invData } = await supabase
          .from("invitations")
          .select("*")
          .eq("institution_id", institutionId)
          .order("created_at", { ascending: false });

        if (invData) {
          setInvitations(invData);
        }

        // Fetch user counts from user_institutions table
        const { data: membershipData } = await supabase
          .from("user_institutions")
          .select("role")
          .eq("institution_id", institutionId);

        if (membershipData) {
          setUserCounts({
            total: membershipData.length,
            pending: invData?.filter((i) => i.status === "pending").length || 0,
            instructors: membershipData.filter((m) => m.role === "instructor").length,
            students: membershipData.filter((m) => m.role === "student").length,
          });
        }
      }
    } catch (error) {
      console.error("Error fetching data:", error);
    } finally {
      setLoadingData(false);
    }
  };

  const handleCreateCourse = async (e: React.FormEvent) => {
    e.preventDefault();
    const instId = getEffectiveInstitutionId();
    if (!instId) return;

    setIsCreatingCourse(true);

    try {
      const resolvedGradeLevel =
        courseGradeLevel && courseGradeLevel !== "none" ? courseGradeLevel : null;
      const resolvedGradeLevelId = resolvedGradeLevel
        ? institutionGradeLevels.findIdByCode(resolvedGradeLevel)
        : null;
      const { data, error } = await supabase
        .from("courses")
        .insert({
          title: courseTitle,
          description: courseDescription || null,
          theme: courseTheme || null,
          language: courseLanguage || institution?.default_language || "en",
          institution_id: instId,
          created_by: user?.id,
          grade_level_id: resolvedGradeLevelId,
        })
        .select("id, title, description, theme, institution_id, created_at, grade_level_id, category, course_materials(count)")
        .single();

      if (error) throw error;

      // Attach the course as an offering to the sections the admin selected
      // in the dialog (all of the grade's sections are pre-checked, matching
      // the old auto-attach behavior for greek_school).
      if (resolvedGradeLevelId && selectedSectionIds.size > 0) {
        const { error: offeringError } = await supabase
          .from("offerings")
          .upsert(
            Array.from(selectedSectionIds).map((classId) => ({
              class_id: classId,
              course_id: data.id,
              is_active: true,
            })),
            { onConflict: "class_id,course_id" }
          );
        if (offeringError) {
          console.error("Error creating offerings:", offeringError);
          toast.warning("Course created but could not be attached to the selected sections");
        }
      }

      // Assign the selected instructors to the new course.
      if (selectedInstructorIds.size > 0) {
        const { error: instructorError } = await supabase
          .from("course_instructors")
          .insert(
            Array.from(selectedInstructorIds).map((userId) => ({
              course_id: data.id,
              user_id: userId,
            }))
          );
        if (instructorError) {
          console.error("Error assigning instructors:", instructorError);
          toast.warning("Course created but instructors could not be assigned");
        }
      }

      setCourses([data, ...courses]);
      toast.success("Course created successfully!");
      setDialogOpen(false);
      setCourseTitle("");
      setCourseDescription("");
      setCourseTheme("");
      setCourseLanguage(institution?.default_language || "en");
      setCourseGradeLevel("");
      setSelectedInstructorIds(new Set());
    } catch (error: any) {
      if (error.code === "23505") {
        toast.error("A course with this title already exists");
      } else {
        toast.error(error.message || "Failed to create course");
      }
    } finally {
      setIsCreatingCourse(false);
    }
  };

  const handleSyncVectorStore = async () => {
    if (!institution) return;
    setSyncingCourseId("institution");
    try {
      const { data, error } = await supabase.functions.invoke("manage-vector-store", {
        body: { action: "sync", institutionId: institution.id, institutionName: institution.name },
      });

      if (error) throw error;

      if (data?.vectorStoreId) {
        setInstitution({ ...institution, vector_store_id: data.vectorStoreId });
        toast.success("Vector store synced successfully");
      }
    } catch (err: any) {
      console.error("Sync error:", err);
      toast.error(err.message || "Failed to sync vector store");
    } finally {
      setSyncingCourseId(null);
    }
  };

  const handleBulkSyncFiles = async () => {
    if (!institution) return;
    setSyncingCourseId("institution");
    try {
      const { data, error } = await supabase.functions.invoke("manage-vector-store", {
        body: { action: "bulk-sync-files", institutionId: institution.id },
      });

      if (error) throw error;

      toast.success(data?.message || "Bulk sync complete");
    } catch (err: any) {
      console.error("Bulk sync error:", err);
      toast.error(err.message || "Failed to bulk sync files");
    } finally {
      setSyncingCourseId(null);
    }
  };

  const handleDeleteCourse = async (courseId: string) => {
    if (!confirm("Are you sure you want to delete this course?")) return;

    try {
      const { error } = await supabase.from("courses").delete().eq("id", courseId);

      if (error) throw error;

      setCourses(courses.filter((c) => c.id !== courseId));
      toast.success("Course deleted");
    } catch (error: any) {
      toast.error(error.message || "Failed to delete course");
    }
  };

  const handleInviteUser = async (e: React.FormEvent) => {
    e.preventDefault();
    const instId = getEffectiveInstitutionId();
    if (!instId) return;

    setIsInviting(true);

    try {
      // Create invitation record
      const { data, error } = await supabase
        .from("invitations")
        .insert({
          email: inviteEmail,
          institution_id: instId,
          invited_by: user?.id,
        })
        .select()
        .single();

      if (error) throw error;

      // Send invitation email
      const { error: emailError } = await supabase.functions.invoke("send-invitation", {
        body: {
          email: inviteEmail,
          institutionId: instId,
          institutionName: institution?.name || "Your Institution",
          inviterName: profile?.full_name || profile?.email || "An administrator",
        },
      });

      if (emailError) {
        console.error("Failed to send email:", emailError);
        toast.warning("Invitation created but email may not have been sent");
      } else {
        toast.success(`Invitation email sent to ${inviteEmail}`);
      }

      setInvitations([data, ...invitations]);
      setInviteDialogOpen(false);
      setInviteEmail("");
    } catch (error: any) {
      toast.error(error.message || "Failed to send invitation");
    } finally {
      setIsInviting(false);
    }
  };

  const handleCancelInvitation = async (invitationId: string) => {
    if (!confirm("Are you sure you want to cancel this invitation?")) return;
    
    setCancellingId(invitationId);
    try {
      const { error } = await supabase
        .from("invitations")
        .delete()
        .eq("id", invitationId);

      if (error) throw error;

      setInvitations(invitations.filter((inv) => inv.id !== invitationId));
      toast.success("Invitation cancelled");
    } catch (error: any) {
      toast.error(error.message || "Failed to cancel invitation");
    } finally {
      setCancellingId(null);
    }
  };

  const handleResendInvitation = async (invitation: Invitation) => {
    setResendingId(invitation.id);
    try {
      const instId = getEffectiveInstitutionId();
      const { error: emailError } = await supabase.functions.invoke("send-invitation", {
        body: {
          email: invitation.email,
          institutionId: instId,
          institutionName: institution?.name || "Your Institution",
          inviterName: profile?.full_name || profile?.email || "An administrator",
        },
      });

      if (emailError) throw emailError;

      toast.success(`Invitation resent to ${invitation.email}`);
    } catch (error: any) {
      toast.error(error.message || "Failed to resend invitation");
    } finally {
      setResendingId(null);
    }
  };

  const handleSignOut = async () => {
    clearSelectedInstitutionId();
    await signOut();
    navigate("/");
  };

  const handlePublicToggleRequest = (newValue: boolean) => {
    setPendingPublicValue(newValue);
    setPublicWarningOpen(true);
  };

  const handleConfirmPublicChange = async () => {
    if (!institution) return;
    setIsUpdatingPublic(true);
    
    try {
      const { error } = await supabase
        .from("institutions")
        .update({ is_public: pendingPublicValue })
        .eq("id", institution.id);
      
      if (error) throw error;
      
      setInstitution({ ...institution, is_public: pendingPublicValue });
      toast.success(
        pendingPublicValue 
          ? "Institution is now public - all users can access it" 
          : "Institution is now private"
      );
    } catch (error: any) {
      toast.error(error.message || "Failed to update institution");
    } finally {
      setIsUpdatingPublic(false);
      setPublicWarningOpen(false);
    }
  };

  const handleLanguageChange = async (newLanguage: string) => {
    if (!institution) return;
    setIsUpdatingLanguage(true);
    
    try {
      const { error } = await supabase
        .from("institutions")
        .update({ default_language: newLanguage })
        .eq("id", institution.id);
      
      if (error) throw error;
      
      setInstitution({ ...institution, default_language: newLanguage });
      toast.success("Default language updated");
    } catch (error: any) {
      toast.error(error.message || "Failed to update language");
    } finally {
      setIsUpdatingLanguage(false);
    }
  };

  // Toggle one AI feature family for this school. The column is written by
  // the institution's own admins by design (unlike openai_store_enabled);
  // enforcement happens server-side in _shared/ai-feature-gate.ts within a
  // minute of the change.
  const handleAiFamilyToggle = async (family: string, enabled: boolean) => {
    if (!institution) return;
    const next = enabled
      ? aiFamiliesDisabled.filter((f) => f !== family)
      : [...aiFamiliesDisabled.filter((f) => f !== family), family];
    setUpdatingAiFamily(family);
    try {
      const { error } = await supabase
        .from("institutions")
        .update({ ai_features_disabled: next })
        .eq("id", institution.id);
      if (error) throw error;
      setAiFamiliesDisabled(next);
      toast.success(
        enabled ? `AI ${family} switched on` : `AI ${family} switched off for this school`,
      );
    } catch (error: any) {
      toast.error(error.message || "Failed to update AI features");
    } finally {
      setUpdatingAiFamily(null);
    }
  };

  const handleSaveAcademicPeriod = async () => {
    if (!institution || !periodInput.trim()) return;
    setIsUpdatingPeriod(true);
    try {
      const { error } = await supabase
        .from("institutions")
        .update({ academic_period: periodInput.trim() })
        .eq("id", institution.id);
      if (error) throw error;
      setInstitution({ ...institution, academic_period: periodInput.trim() });
      setEditingPeriod(false);
      toast.success("Academic period updated");
    } catch (error: any) {
      toast.error(error.message || "Failed to update academic period");
    } finally {
      setIsUpdatingPeriod(false);
    }
  };

  // Fetch active section count for rollover dialog
  useEffect(() => {
    const fetchActiveSections = async () => {
      if (!institution) return;
      const { count } = await supabase
        .from("classes")
        .select("id", { count: "exact", head: true })
        .eq("institution_id", institution.id)
        .eq("is_active", true);
      setActiveSectionCount(count || 0);
    };
    fetchActiveSections();
  }, [institution?.id]);

  const applySchoolLevelChange = async (level: SchoolLevel, next: SchoolLevel[]) => {
    if (!institution) return;
    setUpdatingSchoolLevel(level);
    try {
      const { error } = await supabase
        .from("institutions")
        .update({ school_levels: next })
        .eq("id", institution.id);

      if (error) throw error;

      setInstitution({ ...institution, school_levels: next });
      toast.success(next.includes(level) ? "School level enabled" : "School level disabled");
    } catch (error: any) {
      toast.error(error.message || "Failed to update school levels");
    } finally {
      setUpdatingSchoolLevel(null);
    }
  };

  const confirmDisableLevel = async () => {
    if (!pendingDisableLevel || !institution) return;
    const { level } = pendingDisableLevel;
    const current = (institution.school_levels as SchoolLevel[]) ?? [];
    const next = current.filter((l) => l !== level);
    setPendingDisableLevel(null);
    if (next.length === 0) {
      toast.error("At least one school level must remain enabled");
      return;
    }
    await applySchoolLevelChange(level, next);
  };

  const handleSchoolLevelToggle = async (level: SchoolLevel, checked: boolean) => {
    if (!institution) return;
    const current = (institution.school_levels as SchoolLevel[]) ?? [];
    const next = checked
      ? Array.from(new Set([...current, level]))
      : current.filter((l) => l !== level);

    if (next.length === 0) {
      toast.error("At least one school level must remain enabled");
      return;
    }

    if (!checked) {
      const levelGrades = GRADE_OPTIONS.filter((g) => g.level === level).map((g) => g.value);
      const levelGradeIds = levelGrades
        .map((code) => institutionGradeLevels.findIdByCode(code))
        .filter((id): id is string => !!id);
      // FK identity match — the TEXT column no longer exists after #799.
      if (levelGradeIds.length === 0) {
        // No grade_levels rows for this level yet → no classes to guard.
        await applySchoolLevelChange(level, next);
        return;
      }
      const { count, error: countError } = await supabase
        .from("classes")
        .select("id", { count: "exact", head: true })
        .eq("institution_id", institution.id)
        .eq("is_active", true)
        .in("grade_level_id", levelGradeIds);

      if (countError) {
        toast.error("Failed to check active classes — please try again");
        return;
      }

      if (count && count > 0) {
        setPendingDisableLevel({ level, classCount: count });
        return;
      }
    }

    await applySchoolLevelChange(level, next);
  };

  const handleSelfEnrollmentToggle = async (newValue: boolean) => {
    if (!institution) return;
    setIsUpdatingSelfEnrollment(true);
    
    try {
      const { error } = await supabase
        .from("institutions")
        .update({ allow_self_enrollment: newValue })
        .eq("id", institution.id);
      
      if (error) throw error;
      
      setInstitution({ ...institution, allow_self_enrollment: newValue });
      toast.success(newValue ? "Self-enrollment enabled" : "Self-enrollment disabled");
    } catch (error: any) {
      toast.error(error.message || "Failed to update setting");
    } finally {
      setIsUpdatingSelfEnrollment(false);
    }
  };

  if (loading || loadingData) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  // Show message if user doesn't have an institution (they need to be invited by super admin)
  if (!effectiveInstitutionId && !isSuperAdmin) {
    return (
      <div className="min-h-screen bg-background">
        <nav className="border-b border-border bg-card">
          <div className="container mx-auto px-6 py-4 flex items-center justify-between">
            <BrandMark />
            <Button variant="ghost" onClick={handleSignOut}>
              <LogOut className="w-4 h-4 mr-2" />
              Sign Out
            </Button>
          </div>
        </nav>

        <div className="container mx-auto px-6 py-16">
          <div className="max-w-xl mx-auto text-center">
            <div className="w-20 h-20 rounded-2xl bg-secondary flex items-center justify-center mx-auto mb-8">
              <AlertCircle className="w-10 h-10 text-muted-foreground" />
            </div>
            <h1 className="text-3xl font-display font-bold text-foreground mb-4">
              No Institution Access
            </h1>
            <p className="text-muted-foreground mb-4">
              If you just accepted an invitation, try refreshing the page. Your access may take a moment to activate. Otherwise, please contact your administrator.
            </p>
            <p className="text-sm text-muted-foreground mb-8">
              Auto-refreshing every 5 seconds...
            </p>
            <div className="flex items-center justify-center gap-4">
              <Button variant="outline" onClick={refreshUserInstitution} disabled={isRefreshing}>
                {isRefreshing ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <RefreshCw className="w-4 h-4 mr-2" />
                )}
                Refresh Now
              </Button>
              <Button variant="ghost" onClick={handleSignOut}>
                <LogOut className="w-4 h-4 mr-2" />
                Sign Out
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }
  // Check if user is admin of this institution or super admin
  const actualIsAdmin = userRoleInInstitution === "admin" || isSuperAdmin;
  const actualIsInstructor = userRoleInInstitution === "instructor";
  
  // Check if viewing as instructor (admins can simulate instructor view)
  const viewAsInstructor = searchParams.get("view") === "instructor";
  const isAdmin = actualIsAdmin && !viewAsInstructor;

  const isGreekSchool = institution?.institution_type === "greek_school";

  // Build the grade filter dropdown from the courses' grade_level_id values,
  // then look up labels + ordering from the institution's grade_levels rows.
  // FK identity matches structurally — no string-taxonomy assumption (#798).
  const uniqueGradeLevelIds = Array.from(
    new Set(courses.map((c) => c.grade_level_id).filter((id): id is string => !!id)),
  );
  const gradeLevelIdOrdinal = new Map(
    institutionGradeLevels.rows.map((r) => [r.id, r.ordinal] as const),
  );
  const sortedGradeLevelIds = uniqueGradeLevelIds.slice().sort(
    (a, b) => (gradeLevelIdOrdinal.get(a) ?? Number.MAX_SAFE_INTEGER) -
      (gradeLevelIdOrdinal.get(b) ?? Number.MAX_SAFE_INTEGER),
  );
  const gradeLevelIdToCode = new Map(
    institutionGradeLevels.rows.map((r) => [r.id, r.code] as const),
  );
  const uniqueCategories = Array.from(new Set(courses.map((c) => c.category))).sort();

  const filteredCourses = courses.filter((c) => {
    if (filterGradeLevel !== "all" && c.grade_level_id !== filterGradeLevel) return false;
    if (filterCategory !== "all" && c.category !== filterCategory) return false;
    return true;
  });

  return (
    <div className="min-h-screen flex flex-col bg-background">
      {/* Navigation */}
      <nav className="border-b border-border bg-card sticky top-0 z-50">
        <div className="container mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-3">
              <SafeImage
                src={institution?.logo_url || undefined}
                alt={institution?.name ? `${institution.name} institution logo` : "Institution logo"}
                wrapperClassName="w-10 h-10"
                className="w-full h-full rounded-lg object-contain"
                fallback={<BrandLogo />}
              />
              <div>
                <span className="text-xl font-display font-bold text-foreground">
                  {brand.name}
                </span>
                {institution && (
                  <p className="text-xs text-muted-foreground">{institution.name}</p>
                )}
              </div>
            </div>
            {isAdmin && institution && (
              <InstitutionLogoUpload
                institutionId={institution.id}
                currentLogoUrl={institution.logo_url}
                onLogoUpdate={(newUrl) => setInstitution({ ...institution, logo_url: newUrl })}
              />
            )}
          </div>
          <div className="flex items-center gap-2">
            {(actualIsAdmin || actualIsInstructor) && (
              <Select
                value={actualIsAdmin 
                  ? (viewAsInstructor ? "instructor" : "admin")
                  : "instructor"
                }
                onValueChange={(value) => {
                  if (value === "student") {
                    navigate("/student?view=student");
                  } else if (value === "instructor") {
                    navigate("/dashboard?view=instructor");
                  } else if (actualIsAdmin) {
                    navigate("/dashboard");
                  }
                }}
              >
                <SelectTrigger className={`h-9 w-[160px] ${
                  viewAsInstructor 
                    ? "bg-amber-100 dark:bg-amber-900/30 border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-300" 
                    : ""
                }`}>
                  <Eye className={`w-4 h-4 mr-2 ${viewAsInstructor ? "text-amber-600 dark:text-amber-400" : ""}`} />
                  <SelectValue placeholder="View as..." />
                </SelectTrigger>
                <SelectContent>
                  {actualIsAdmin && <SelectItem value="admin">View as Admin</SelectItem>}
                  <SelectItem value="instructor">View as Instructor</SelectItem>
                  <SelectItem value="student">View as Student</SelectItem>
                </SelectContent>
              </Select>
            )}
            {(actualIsInstructor || actualIsAdmin) && (
              <Button
                variant="default"
                size="sm"
                aria-label="Instructor's Home"
                onClick={() => navigate("/instructor")}
              >
                <Home className="w-4 h-4" />
                <span className="hidden sm:inline">Instructor's Home</span>
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={() => navigate("/select-institution")}>
              <School className="w-4 h-4 mr-1" />
              {isSuperAdmin ? "Switch" : "Institutions"}
            </Button>
            <NotificationBell includeAdminFeed={actualIsAdmin || actualIsInstructor} />
            <UserActionMenu
              onSignOut={handleSignOut}
              onReportBug={
                actualIsAdmin || actualIsInstructor || isSuperAdmin
                  ? () => setBugReportOpen(true)
                  : undefined
              }
              roleLabel={
                isSuperAdmin
                  ? "Super Admin"
                  : isAdmin
                    ? "Admin"
                    : actualIsInstructor
                      ? "Instructor"
                      : undefined
              }
            />
          </div>
        </div>
      </nav>
      <BugReportDialog open={bugReportOpen} onOpenChange={setBugReportOpen} />

      <main className="flex-1 container mx-auto px-6 py-8">
        {/* User Management Section (Admin only) */}
        {isAdmin && (
          <div className="mb-12">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-2xl font-display font-bold text-foreground">
                User Management
              </h2>
              <Button onClick={() => navigate("/users")}>
                <Users className="w-4 h-4 mr-2" />
                Manage Users
              </Button>
            </div>

            <Card className="hover:shadow-elegant transition-all cursor-pointer" onClick={() => navigate("/users")}>
              <CardContent className="py-6">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-6">
                    <div className="w-14 h-14 rounded-xl bg-primary/10 flex items-center justify-center">
                      <Users className="w-7 h-7 text-primary" />
                    </div>
                    <div className="flex items-center gap-8">
                      <div className="text-center">
                        <p className="text-2xl font-bold">{userCounts.total}</p>
                        <p className="text-xs text-muted-foreground">Total Users</p>
                      </div>
                      <div className="text-center">
                        <p className="text-2xl font-bold text-amber-500">{userCounts.pending}</p>
                        <p className="text-xs text-muted-foreground">Pending</p>
                      </div>
                      <div className="text-center">
                        <p className="text-2xl font-bold text-green-500">{userCounts.students}</p>
                        <p className="text-xs text-muted-foreground">Students</p>
                      </div>
                      <div className="text-center">
                        <p className="text-2xl font-bold text-blue-500">{userCounts.instructors}</p>
                        <p className="text-xs text-muted-foreground">Instructors</p>
                      </div>
                    </div>
                  </div>
                  <ArrowRight className="w-5 h-5 text-muted-foreground" />
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Class Management Section (Admin only) */}
        {isAdmin && (
          <div className="mb-12">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-2xl font-display font-bold text-foreground">
                Class Management
              </h2>
              <Button onClick={() => navigate("/classes")}>
                <School className="w-4 h-4 mr-2" />
                Manage Classes
              </Button>
            </div>

            <Card className="hover:shadow-elegant transition-all cursor-pointer" onClick={() => navigate("/classes")}>
              <CardContent className="py-6">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-6">
                    <div className="w-14 h-14 rounded-xl bg-violet-500/10 flex items-center justify-center">
                      <School className="w-7 h-7 text-violet-500" />
                    </div>
                    <div>
                      <p className="font-medium text-foreground">
                        Create and manage classes
                      </p>
                      <p className="text-sm text-muted-foreground">
                        Enroll students once, attach multiple courses
                      </p>
                    </div>
                  </div>
                  <ArrowRight className="w-5 h-5 text-muted-foreground" />
                </div>
              </CardContent>
            </Card>
          </div>
        )}



        <AlertDialog open={publicWarningOpen} onOpenChange={setPublicWarningOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle className="flex items-center gap-2">
                <AlertTriangle className="w-5 h-5 text-amber-500" />
                {pendingPublicValue ? "Make Institution Public?" : "Make Institution Private?"}
              </AlertDialogTitle>
              <AlertDialogDescription asChild>
                <div className="space-y-4">
                  {pendingPublicValue ? (
                    <>
                      <div className="p-4 bg-destructive/10 border border-destructive/20 rounded-lg">
                        <p className="text-destructive font-medium mb-2">⚠️ Warning: This is a significant change</p>
                        <ul className="text-sm text-destructive/80 space-y-1 list-disc list-inside">
                          <li>All authenticated users will be able to see this institution</li>
                          <li>The institution will appear in every user's dashboard</li>
                          <li>Any user can access courses and materials</li>
                          <li>This cannot be undone without manually reviewing access</li>
                        </ul>
                      </div>
                      <p className="text-sm text-muted-foreground">
                        Are you sure you want to make <strong>{institution?.name}</strong> publicly accessible?
                      </p>
                    </>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      Making this institution private will restrict access to only invited users. 
                      Users who previously had access through the public setting will no longer be able to access it.
                    </p>
                  )}
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={isUpdatingPublic}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={handleConfirmPublicChange}
                disabled={isUpdatingPublic}
                className={pendingPublicValue ? "bg-destructive hover:bg-destructive/90" : ""}
              >
                {isUpdatingPublic ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Updating...
                  </>
                ) : pendingPublicValue ? (
                  "Yes, Make Public"
                ) : (
                  "Make Private"
                )}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <AlertDialog open={!!pendingDisableLevel} onOpenChange={(open) => { if (!open) setPendingDisableLevel(null); }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle className="flex items-center gap-2">
                <AlertTriangle className="w-5 h-5 text-amber-500" />
                Disable School Level?
              </AlertDialogTitle>
              <AlertDialogDescription asChild>
                <div className="space-y-3">
                  <p className="text-sm text-muted-foreground">
                    There {pendingDisableLevel?.classCount === 1 ? "is" : "are"}{" "}
                    <strong>{pendingDisableLevel?.classCount}</strong> active class
                    {pendingDisableLevel?.classCount !== 1 ? "es" : ""} using{" "}
                    <strong>
                      {GREEK_SCHOOL_LEVELS.find((l) => l.id === pendingDisableLevel?.level)?.labelEl}
                    </strong>{" "}
                    grade levels. Disabling this level will hide those grades from the grade level creation dialog,
                    but existing classes and enrollments will not be affected.
                  </p>
                  <p className="text-sm text-muted-foreground">
                    Are you sure you want to disable this school level?
                  </p>
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={confirmDisableLevel} className="bg-destructive hover:bg-destructive/90">
                Disable Level
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <div className="mb-12">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-4">
              <h2 className="text-2xl font-display font-bold text-foreground">Courses</h2>
            </div>
            {isAdmin && (
              <div className="flex items-center gap-2">
                <Dialog open={dialogOpen} onOpenChange={(open) => {
                  setDialogOpen(open);
                  if (!open) {
                    // Reset form when dialog closes
                    setCourseTitle("");
                    setCourseDescription("");
                    setCourseTheme("");
                    setCourseLanguage(institution?.default_language || "en");
                    setCourseGradeLevel("");
                    setSelectedInstructorIds(new Set());
                  }
                }}>
                  <DialogTrigger asChild>
                    <Button variant="gold">
                      <Plus className="w-4 h-4 mr-2" />
                      Add Course
                    </Button>
                </DialogTrigger>
                <DialogContent className="max-h-[90vh] overflow-y-auto">
                  <DialogHeader>
                    <DialogTitle>Create New Course</DialogTitle>
                    <DialogDescription>
                      Add a new course to your institution
                    </DialogDescription>
                  </DialogHeader>
                  <form onSubmit={handleCreateCourse} className="space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="title">Course Title</Label>
                      <Input
                        id="title"
                        placeholder="Introduction to Philosophy"
                        value={courseTitle}
                        onChange={(e) => setCourseTitle(e.target.value)}
                        required
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="description">Description</Label>
                      <Textarea
                        id="description"
                        placeholder="Explore the fundamental questions of existence..."
                        value={courseDescription}
                        onChange={(e) => setCourseDescription(e.target.value)}
                        rows={3}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="theme">Theme (Optional)</Label>
                      <Input
                        id="theme"
                        placeholder="Philosophy, Science, Mathematics..."
                        value={courseTheme}
                        onChange={(e) => setCourseTheme(e.target.value)}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="language">Course Language</Label>
                      <Select value={courseLanguage} onValueChange={setCourseLanguage}>
                        <SelectTrigger>
                          <SelectValue placeholder="Select language" />
                        </SelectTrigger>
                        <SelectContent>
                          {LANGUAGE_OPTIONS.map((lang) => (
                            <SelectItem key={lang.code} value={lang.code}>
                              {lang.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    {courseGradeOptions.length > 0 && (
                      <div className="space-y-2">
                        <Label htmlFor="grade-level">Grade Level</Label>
                        <Select value={courseGradeLevel} onValueChange={setCourseGradeLevel}>
                          <SelectTrigger id="grade-level">
                            <SelectValue placeholder="Select grade (optional)" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="none">No specific grade</SelectItem>
                            {courseGradeOptions.map((g) => (
                              <SelectItem key={g.value} value={g.value}>
                                {institution?.default_language === "el" ? g.labelEl : g.labelEn}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                    {sectionsLoading && (
                      <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                        <Loader2 className="w-3 h-3 animate-spin" />
                        Loading sections...
                      </p>
                    )}
                    {gradeSections.length > 0 && (
                      <div className="space-y-2">
                        <Label>
                          Sections ({selectedSectionIds.size} of {gradeSections.length} selected)
                        </Label>
                        <div className="flex flex-wrap gap-3 p-3 border rounded-md">
                          {gradeSections.map((sec) => (
                            <label
                              key={sec.id}
                              className="flex items-center gap-1.5 cursor-pointer text-sm"
                            >
                              <Checkbox
                                checked={selectedSectionIds.has(sec.id)}
                                onCheckedChange={() => toggleSectionSelection(sec.id)}
                              />
                              <span>
                                {getSectionDisplayName(sec.gradeCode, sec.section_name)}
                                {sec.category ? ` (${sec.category})` : ""}
                              </span>
                            </label>
                          ))}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          The course will be attached to the selected sections.
                        </p>
                      </div>
                    )}
                    {availableInstructors.length > 0 && (
                      <div className="space-y-2">
                        <Label>
                          Assign Instructors (optional
                          {selectedInstructorIds.size > 0
                            ? `, ${selectedInstructorIds.size} selected`
                            : ""})
                        </Label>
                        <div className="max-h-[160px] overflow-y-auto border rounded-md p-2 space-y-1">
                          {availableInstructors.map((instructor) => (
                            <label
                              key={instructor.user_id}
                              className="flex items-center gap-3 p-2 rounded-md cursor-pointer hover:bg-secondary"
                            >
                              <Checkbox
                                checked={selectedInstructorIds.has(instructor.user_id)}
                                onCheckedChange={() =>
                                  toggleInstructorSelection(instructor.user_id)
                                }
                              />
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2">
                                  <p className="font-medium text-sm truncate">
                                    {instructor.full_name || instructor.email || "No name"}
                                  </p>
                                  <Badge
                                    variant={instructor.role === "admin" ? "default" : "secondary"}
                                    className="text-xs py-0 px-1.5 shrink-0"
                                  >
                                    {instructor.role === "admin" ? "Admin" : "Instructor"}
                                  </Badge>
                                </div>
                                {instructor.email && (
                                  <p className="text-xs text-muted-foreground truncate mt-0.5">
                                    {instructor.email}
                                  </p>
                                )}
                              </div>
                            </label>
                          ))}
                        </div>
                      </div>
                    )}
                    <Button
                      type="submit"
                      className="w-full"
                      disabled={isCreatingCourse || sectionsLoading}
                    >
                      {isCreatingCourse ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin" />
                          Creating...
                        </>
                      ) : (
                        "Create Course"
                      )}
                    </Button>
                  </form>
                </DialogContent>
                </Dialog>
              </div>
            )}
          </div>

          {courses.length > 0 && ((isGreekSchool && sortedGradeLevelIds.length > 0) || uniqueCategories.length > 1) && (
            <div className="flex flex-wrap items-center gap-3 mb-6">
              {isGreekSchool && sortedGradeLevelIds.length > 0 && (
                <Select value={filterGradeLevel} onValueChange={setFilterGradeLevel}>
                  <SelectTrigger className="w-[200px]">
                    <SelectValue placeholder="All Grade Levels" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Grade Levels</SelectItem>
                    {sortedGradeLevelIds.map((glId) => (
                      <SelectItem key={glId} value={glId}>
                        {institutionGradeLevels.getLabel(gradeLevelIdToCode.get(glId), institution?.default_language || "el")}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {uniqueCategories.length > 1 && (
                <Select value={filterCategory} onValueChange={setFilterCategory}>
                  <SelectTrigger className="w-[200px]">
                    <SelectValue placeholder="All Categories" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Categories</SelectItem>
                    {uniqueCategories.map((cat) => (
                      <SelectItem key={cat} value={cat}>
                        {cat}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {(filterGradeLevel !== "all" || filterCategory !== "all") && (
                <span className="text-sm text-muted-foreground">
                  {filteredCourses.length} of {courses.length} courses
                </span>
              )}
            </div>
          )}

          {(() => {
            if (courses.length === 0) {
              return (
                <Card className="border-dashed">
                  <CardContent className="py-12 text-center">
                    <BookOpen className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
                    <h3 className="text-lg font-medium text-foreground mb-2">No courses yet</h3>
                    <p className="text-muted-foreground mb-4">
                      {isAdmin
                        ? "Create your first course to get started"
                        : "Courses will appear here once created"}
                    </p>
                  </CardContent>
                </Card>
              );
            }

            if (filteredCourses.length === 0) {
              return (
                <Card className="border-dashed">
                  <CardContent className="py-12 text-center">
                    <BookOpen className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
                    <h3 className="text-lg font-medium text-foreground mb-2">No matching courses</h3>
                    <p className="text-muted-foreground">Try adjusting your filters</p>
                  </CardContent>
                </Card>
              );
            }

            return (
              <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
                {filteredCourses.map((course) => (
                <Card 
                  key={course.id} 
                  className="group hover:shadow-elegant transition-all cursor-pointer"
                  onClick={() => navigate(`/course/${course.id}`)}
                >
                  <CardHeader>
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <div className="flex flex-wrap gap-1 mb-2">
                          {course.theme && (
                            <span className="text-xs px-2 py-1 bg-gold/10 text-gold-dark rounded-full inline-block">
                              {course.theme}
                            </span>
                          )}
                          {uniqueCategories.length > 1 && course.category !== "Default" && (
                            <span className="text-xs px-2 py-1 bg-primary/10 text-primary rounded-full inline-block">
                              {course.category}
                            </span>
                          )}
                          {isGreekSchool && course.grade_level_id && (
                            <span className="text-xs px-2 py-1 bg-muted text-muted-foreground rounded-full inline-block">
                              {institutionGradeLevels.getLabelById(course.grade_level_id, institution?.default_language || "el")}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          <CardTitle className="text-lg">{course.title}</CardTitle>
                        </div>
                      </div>
                      {isAdmin && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="opacity-0 group-hover:opacity-100 transition-opacity text-destructive hover:text-destructive"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteCourse(course.id);
                          }}
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      )}
                    </div>
                    <CardDescription className="line-clamp-2">
                      {course.description || "No description provided"}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {(() => {
                      const materialCount = course.course_materials?.[0]?.count ?? 0;
                      return materialCount > 0 ? (
                        <Badge
                          variant="secondary"
                          className="gap-1 bg-emerald-500/15 text-emerald-700 hover:bg-emerald-500/20 dark:text-emerald-400"
                        >
                          <FileText className="w-3 h-3" />
                          {materialCount} {materialCount === 1 ? "Material" : "Materials"}
                        </Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">No Materials</span>
                      );
                    })()}
                    <div className="flex items-center gap-4">
                      <Button variant="outline" size="sm" className="flex-1">
                        <FileText className="w-4 h-4 mr-2" />
                        Materials
                      </Button>
                      <Button 
                        variant="ghost" 
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          navigate(`/course/${course.id}`);
                        }}
                      >
                        <ArrowRight className="w-4 h-4" />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
                {(actualIsInstructor || actualIsAdmin) && (
                  <Card
                    role="link"
                    tabIndex={0}
                    aria-label="Instructor's Home"
                    className="group cursor-pointer bg-primary text-primary-foreground border-primary hover:shadow-elegant transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    onClick={() => navigate("/instructor")}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        navigate("/instructor");
                      }
                    }}
                  >
                    <CardHeader>
                      <div className="flex items-center gap-2">
                        <Home className="w-5 h-5" />
                        <CardTitle className="text-lg">Instructor's Home</CardTitle>
                      </div>
                      <CardDescription className="line-clamp-2 text-primary-foreground/80">
                        Set up your courses, track study guides, and see what to do next
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      <div className="flex items-center justify-end">
                        <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-1" />
                      </div>
                    </CardContent>
                  </Card>
                )}
              </div>
            );
          })()}
        </div>

        {/* Institution Settings (Admin only) */}
        {isAdmin && institution && (
          <Collapsible
            open={institutionSettingsOpen}
            onOpenChange={setInstitutionSettingsOpen}
            className="mb-12"
          >
            <CollapsibleTrigger
              className="group mb-6 flex w-full items-center justify-between gap-3 rounded-lg border border-border bg-card px-5 py-4 text-left transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-controls="institution-settings-content"
            >
              <div className="flex items-center gap-3">
                <ChevronDown
                  className={`w-5 h-5 text-muted-foreground transition-transform ${institutionSettingsOpen ? "rotate-180" : ""}`}
                />
                <span className="text-2xl font-display font-bold text-foreground">
                  Institution Settings
                </span>
              </div>
              <span className="text-sm text-muted-foreground group-hover:text-foreground">
                {institutionSettingsOpen ? "Hide" : "Show"}
              </span>
            </CollapsibleTrigger>
            <CollapsibleContent id="institution-settings-content">
              <div className="mb-4 flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-900 dark:text-amber-200">
                <AlertTriangle className="w-5 h-5 mt-0.5 shrink-0 text-amber-600" />
                <div>
                  <p className="font-medium">Do not touch unless you know what you are doing.</p>
                  <p className="text-amber-800/80 dark:text-amber-200/80">
                    These settings affect the entire institution. Changes here can disrupt
                    access, billing, and class structures for all users.
                  </p>
                </div>
              </div>
            <Card>
              <CardContent className="py-6">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${institution.is_public ? 'bg-amber-500/20' : 'bg-muted'}`}>
                      <Globe className={`w-6 h-6 ${institution.is_public ? 'text-amber-600' : 'text-muted-foreground'}`} />
                    </div>
                    <div>
                      <p className="font-medium text-foreground">Public Institution</p>
                      <p className="text-sm text-muted-foreground">
                        {institution.is_public 
                          ? "All authenticated users can access this institution" 
                          : "Only invited users can access this institution"}
                      </p>
                    </div>
                  </div>
                  <Switch
                    checked={institution.is_public}
                    onCheckedChange={handlePublicToggleRequest}
                    disabled={isUpdatingPublic}
                  />
                </div>
                {institution.is_public && (
                  <div className="mt-4 p-3 bg-amber-500/10 border border-amber-500/20 rounded-lg flex items-start gap-3">
                    <AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
                    <p className="text-sm text-amber-700 dark:text-amber-400">
                      This institution is publicly accessible. Any logged-in user can view its courses and content.
                    </p>
                  </div>
                )}

                {/* Language Settings */}
                <div className="mt-6 pt-6 border-t flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center">
                      <Languages className="w-6 h-6 text-primary" />
                    </div>
                    <div>
                      <p className="font-medium text-foreground">Default Language</p>
                      <p className="text-sm text-muted-foreground">
                        Language for AI-generated content (questions, evaluations, etc.),
                        and the default interface language for everyone in this
                        institution. Each person can override the interface language
                        for themselves.
                      </p>
                      {/* The dropdown offers every language the AI can write in, but
                          the interface is only translated into the locales we ship a
                          catalog for. Saying so here beats an admin picking French and
                          wondering why the interface stayed English. */}
                      {!UI_TRANSLATED_LOCALES.includes(institution.default_language || "en") && (
                        <p className="text-xs text-muted-foreground mt-1">
                          The interface is translated into{" "}
                          {UI_TRANSLATED_LOCALES.map(getLanguageName).join(" and ")}.
                          Other languages apply to AI-generated content only; the
                          interface stays in English.
                        </p>
                      )}
                    </div>
                  </div>
                  <Select
                    value={institution.default_language || "en"}
                    onValueChange={handleLanguageChange}
                    disabled={isUpdatingLanguage}
                  >
                    <SelectTrigger className="w-[200px]">
                      <SelectValue placeholder="Select language" />
                    </SelectTrigger>
                    <SelectContent>
                      {LANGUAGE_OPTIONS.map((lang) => (
                        <SelectItem key={lang.code} value={lang.code}>
                          {lang.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Self-Enrollment Settings */}
                <div className="mt-6 pt-6 border-t flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${institution.allow_self_enrollment ? 'bg-green-500/20' : 'bg-muted'}`}>
                      <UserPlus className={`w-6 h-6 ${institution.allow_self_enrollment ? 'text-green-600' : 'text-muted-foreground'}`} />
                    </div>
                    <div>
                      <p className="font-medium text-foreground">Student Self-Enrollment</p>
                      <p className="text-sm text-muted-foreground">
                        {institution.allow_self_enrollment 
                          ? "Students can browse and enroll themselves in available classes" 
                          : "Only admins can enroll students in classes"}
                      </p>
                    </div>
                  </div>
                  <Switch
                    checked={institution.allow_self_enrollment}
                    onCheckedChange={handleSelfEnrollmentToggle}
                    disabled={isUpdatingSelfEnrollment}
                  />
                </div>

                {/* AI features (per-school toggles + activity view) */}
                <div className="mt-6 pt-6 border-t">
                  <div className="flex items-start gap-4">
                    <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                      <Bot className="w-6 h-6 text-primary" />
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center justify-between gap-4">
                        <div>
                          <p className="font-medium text-foreground">AI Features</p>
                          <p className="text-sm text-muted-foreground">
                            Switch whole AI feature families on or off for this school.
                            Changes take effect within a minute. Safety screening of
                            pupil messages is always on and is not a toggle.
                          </p>
                        </div>
                        <Button variant="outline" size="sm" onClick={() => navigate("/ai-activity")}>
                          View AI activity
                        </Button>
                      </div>
                      <div className="mt-4 flex flex-col gap-3">
                        {[
                          { id: "tutoring", label: "Tutoring", detail: "The pupil-facing AI tutors" },
                          { id: "grading", label: "Grading", detail: "AI grading and answer validation" },
                          { id: "analytics", label: "Analytics", detail: "Evaluations, clustering and analysis for instructors" },
                          { id: "generation", label: "Content generation", detail: "Questions, study guides, summaries, flashcards" },
                        ].map((family) => {
                          const enabled = !aiFamiliesDisabled.includes(family.id);
                          return (
                            <div key={family.id} className="flex items-center justify-between">
                              <div>
                                <p className="text-sm font-medium">{family.label}</p>
                                <p className="text-xs text-muted-foreground">{family.detail}</p>
                              </div>
                              <div className="flex items-center gap-2">
                                {updatingAiFamily === family.id && (
                                  <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />
                                )}
                                <Switch
                                  checked={enabled}
                                  onCheckedChange={(checked) =>
                                    handleAiFamilyToggle(family.id, checked === true)
                                  }
                                  disabled={updatingAiFamily !== null}
                                  aria-label={`AI ${family.label} for this school`}
                                />
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                </div>

                {/* School Levels (greek_school only) */}
                {isGreekSchool && (
                  <div className="mt-6 pt-6 border-t">
                    <div className="flex items-start gap-4">
                      <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                        <School className="w-6 h-6 text-primary" />
                      </div>
                      <div className="flex-1">
                        <p className="font-medium text-foreground">School Levels</p>
                        <p className="text-sm text-muted-foreground mb-3">
                          Which school levels this institution offers. At least one must be enabled.
                        </p>
                        <div className="flex flex-col gap-2">
                          {GREEK_SCHOOL_LEVELS.map((level) => {
                            const isOn = (institution.school_levels ?? []).includes(level.id);
                            return (
                              <label
                                key={level.id}
                                className="flex items-center gap-2 cursor-pointer"
                              >
                                <Checkbox
                                  checked={isOn}
                                  disabled={updatingSchoolLevel !== null || !!pendingDisableLevel}
                                  onCheckedChange={(checked) =>
                                    handleSchoolLevelToggle(level.id, checked === true)
                                  }
                                />
                                <span className="text-sm">
                                  {level.labelEl} ({level.labelEn})
                                </span>
                                {updatingSchoolLevel === level.id && (
                                  <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />
                                )}
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* Academic Period Settings */}
                <div className="mt-6 pt-6 border-t flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${institution.academic_period ? 'bg-primary/10' : 'bg-muted'}`}>
                      <CalendarDays className={`w-6 h-6 ${institution.academic_period ? 'text-primary' : 'text-muted-foreground'}`} />
                    </div>
                    <div>
                      <p className="font-medium text-foreground">Academic Period</p>
                      <p className="text-sm text-muted-foreground">
                        {institution.academic_period
                          ? `Current period: ${institution.academic_period}`
                          : "No academic period set"}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {editingPeriod ? (
                      <div className="flex items-center gap-2">
                        <Input
                          className="w-[140px] h-9"
                          placeholder="e.g., 2025-2026"
                          value={periodInput}
                          onChange={(e) => setPeriodInput(e.target.value)}
                          disabled={isUpdatingPeriod}
                        />
                        <Button
                          size="sm"
                          onClick={handleSaveAcademicPeriod}
                          disabled={!periodInput.trim() || isUpdatingPeriod}
                        >
                          {isUpdatingPeriod ? <Loader2 className="w-4 h-4 animate-spin" /> : "Save"}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setEditingPeriod(false)}
                          disabled={isUpdatingPeriod}
                        >
                          Cancel
                        </Button>
                      </div>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setPeriodInput(institution.academic_period || "");
                          setEditingPeriod(true);
                        }}
                      >
                        {institution.academic_period ? "Change" : "Set Period"}
                      </Button>
                    )}
                  </div>
                </div>

                {/* Academic Year Rollover */}
                <div className="mt-6 pt-6 border-t flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <div className="w-12 h-12 rounded-xl bg-muted flex items-center justify-center">
                      <RotateCcw className="w-6 h-6 text-muted-foreground" />
                    </div>
                    <div>
                      <p className="font-medium text-foreground">New Year Rollover</p>
                      <p className="text-sm text-muted-foreground">
                        Archive current sections and create new ones for the next academic year
                      </p>
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setRolloverDialogOpen(true)}
                    disabled={activeSectionCount === 0}
                  >
                    <RotateCcw className="w-4 h-4 mr-2" />
                    Rollover ({activeSectionCount} sections)
                  </Button>
                </div>

                {/* Vector Store Settings */}
                <div className="mt-6 pt-6 border-t flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${institution.vector_store_id ? 'bg-green-500/20' : 'bg-muted'}`}>
                      {institution.vector_store_id ? (
                        <Cloud className="w-6 h-6 text-green-600" />
                      ) : (
                        <CloudOff className="w-6 h-6 text-muted-foreground" />
                      )}
                    </div>
                    <div>
                      <p className="font-medium text-foreground">AI Cloud</p>
                      <p className="text-sm text-muted-foreground">
                        {institution.vector_store_id 
                          ? "AI cloud features are active" 
                          : "Enable AI cloud features for this institution"}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {institution.vector_store_id ? (
                      <Badge variant="outline" className="bg-green-500/10 text-green-600 border-green-500/20">
                        Active
                      </Badge>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleSyncVectorStore}
                        disabled={syncingCourseId === "institution"}
                      >
                        {syncingCourseId === "institution" ? (
                          <>
                            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                            Enabling...
                          </>
                        ) : (
                          <>
                            <Cloud className="w-4 h-4 mr-2" />
                            Enable AI Cloud
                          </>
                        )}
                      </Button>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
            </CollapsibleContent>
          </Collapsible>
        )}
      </main>

      {/* Rendered here rather than left to GlobalFooter, so the legal links sit
          at the bottom of the page instead of below a forced 100vh — on a short
          dashboard that meant scrolling into blank space to find them (#937).
          Before the dialog, which is portalled and renders nothing in flow. */}
      <SiteFooter />

      {institution && (
        <AcademicYearRolloverDialog
          open={rolloverDialogOpen}
          onOpenChange={setRolloverDialogOpen}
          institutionId={institution.id}
          currentPeriod={institution.academic_period}
          activeSectionCount={activeSectionCount}
          onCompleted={() => {
            fetchInstitutionData(institution.id);
          }}
        />
      )}
    </div>
  );
};

export default Dashboard;
