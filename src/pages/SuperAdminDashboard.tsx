import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { SafeImage } from "@/components/SafeImage";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
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
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import {
  GREEK_SCHOOL_LEVELS,
  buildStarterClasses,
  type SchoolLevel,
  type InstitutionType,
  type StarterClass,
} from "@/lib/greek-school";
import { ensureGradeLevel } from "@/lib/grade-levels";
import {
  BookOpen,
  Plus,
  LogOut,
  Loader2,
  Building,
  Users,
  Trash2,
  AlertTriangle,
  BarChart3,
  Zap,
  Download,
  Bug,
} from "lucide-react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { NotificationBell } from "@/components/NotificationBell";

interface Institution {
  id: string;
  name: string;
  slug: string;
  logo_url: string | null;
  created_at: string;
  openai_store_enabled: boolean;
}

const SuperAdminDashboard = () => {
  const navigate = useNavigate();
  const { user, loading, signOut } = useAuth();
  const [isSuperAdmin, setIsSuperAdmin] = useState<boolean | null>(null);
  const [institutions, setInstitutions] = useState<Institution[]>([]);
  const [loadingData, setLoadingData] = useState(true);
  const [isCreating, setIsCreating] = useState(false);

  // Institution form
  const [institutionName, setInstitutionName] = useState("");
  const [institutionSlug, setInstitutionSlug] = useState("");
  const [slugManuallyEdited, setSlugManuallyEdited] = useState(false);

  // Helper to generate slug from name
  const generateSlug = (name: string) => {
    return name
      .toLowerCase()
      .trim()
      .replace(/[^\w\s-]/g, '') // Remove special characters
      .replace(/\s+/g, '-')     // Replace spaces with hyphens
      .replace(/-+/g, '-');     // Replace multiple hyphens with single
  };

  const handleNameChange = (name: string) => {
    setInstitutionName(name);
    // Auto-update slug only if user hasn't manually edited it
    if (!slugManuallyEdited) {
      setInstitutionSlug(generateSlug(name));
    }
  };

  const handleSlugChange = (slug: string) => {
    setInstitutionSlug(slug);
    setSlugManuallyEdited(true);
  };
  const [institutionLanguage, setInstitutionLanguage] = useState("el");
  const [institutionType, setInstitutionType] = useState<InstitutionType>("greek_school");
  const [schoolLevels, setSchoolLevels] = useState<SchoolLevel[]>(["dimotiko", "gymnasio", "lykeio"]);
  const [institutionDescription, setInstitutionDescription] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  
  // Delete confirmation
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [institutionToDelete, setInstitutionToDelete] = useState<Institution | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  useEffect(() => {
    if (!loading && !user) {
      navigate("/auth");
      return;
    }

    if (user) {
      checkSuperAdmin();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- check on user/loading change
  }, [user, loading, navigate]);

  const checkSuperAdmin = async () => {
    try {
      const { data, error } = await supabase.rpc("is_super_admin", {
        _user_id: user!.id,
      });

      if (error) {
        console.error("Error checking super admin status:", error);
        setIsSuperAdmin(false);
        return;
      }

      setIsSuperAdmin(data);

      if (data) {
        fetchInstitutions();
      } else {
        setLoadingData(false);
      }
    } catch (error) {
      console.error("Error:", error);
      setIsSuperAdmin(false);
      setLoadingData(false);
    }
  };

  const fetchInstitutions = async () => {
    try {
      const { data, error } = await supabase
        .from("institutions")
        .select("id, name, slug, logo_url, created_at, openai_store_enabled")
        .order("created_at", { ascending: false });

      if (error) throw error;
      setInstitutions(data || []);
    } catch (error) {
      console.error("Error fetching institutions:", error);
    } finally {
      setLoadingData(false);
    }
  };

  const handleCreateInstitution = async (e: React.FormEvent) => {
    e.preventDefault();

    if (institutionType === "greek_school" && schoolLevels.length === 0) {
      toast.error("Select at least one school level");
      return;
    }

    setIsCreating(true);

    try {
      // Create institution
      const { data: newInstitution, error: instError } = await supabase
        .from("institutions")
        .insert({
          name: institutionName,
          slug: institutionSlug.toLowerCase().replace(/\s+/g, "-"),
          default_language: institutionLanguage,
          country: "GR", // App is Greece-only for now; all institutions get GR
          description: institutionDescription || null,
          institution_type: institutionType,
          school_levels: institutionType === "greek_school" ? schoolLevels : [],
        })
        .select()
        .single();

      if (instError) throw instError;

      // Seed starter classes so the institution is usable immediately:
      // greek schools get year-level grades; generic institutions get a single
      // default "General" class.
      const classTemplates = buildStarterClasses(
        institutionType,
        schoolLevels,
        institutionLanguage,
        newInstitution.id,
        user!.id,
      );

      if (classTemplates.length > 0) {
        // The institution is unusable without its starter classes, so any
        // failure below unwinds it rather than leaving a half-built one behind.
        const rollbackInstitution = async (what: string): Promise<never> => {
          const { error: rollbackError } = await supabase
            .from("institutions")
            .delete()
            .eq("id", newInstitution.id);
          if (rollbackError) {
            console.error("Rollback failed:", rollbackError);
            throw new Error(`${what} Rollback also failed — please manually delete the institution.`);
          }
          throw new Error(`${what} Institution was not saved.`);
        };

        // `buildStarterClasses` returns templates keyed by grade CODE, and
        // `classes` has carried only the `grade_level_id` FK since #799 dropped
        // the TEXT column (20260710000000_grade_levels_contract.sql) — so every
        // code has to be resolved to a `grade_levels` row before the insert.
        // Inserting the raw templates made PostgREST reject the batch on the
        // unknown `grade_code` column and the rollback above then dropped the
        // institution, so creating one from this page always failed (#1068).
        //
        // A greek school's codes were already seeded by the AFTER INSERT
        // trigger on `institutions`, so those resolve to a SELECT; a generic
        // institution's "General" row is created here. Sequential on purpose:
        // ensureGradeLevel is a SELECT-or-INSERT, and concurrent inserts would
        // race on the (institution_id, code) unique constraint.
        const classesToCreate: (Omit<StarterClass, "grade_code"> & {
          grade_level_id: string;
        })[] = [];
        for (const { grade_code, ...cls } of classTemplates) {
          try {
            classesToCreate.push({
              ...cls,
              grade_level_id: await ensureGradeLevel(
                supabase,
                newInstitution.id,
                grade_code,
              ),
            });
          } catch (gradeError) {
            console.error("Error resolving starter grade levels:", gradeError);
            await rollbackInstitution("Failed to resolve starter grade levels.");
          }
        }

        const { error: classError } = await supabase
          .from("classes")
          .insert(classesToCreate);

        if (classError) {
          console.error("Error creating starter classes:", classError);
          await rollbackInstitution("Failed to create starter classes.");
        }
      }

      // Create vector store in OpenAI for the institution
      try {
        const { data: vectorStoreResult, error: vectorStoreError } = await supabase.functions.invoke(
          "manage-vector-store",
          {
            body: {
              action: "create",
              institutionId: newInstitution.id,
              institutionName: institutionName,
            },
          }
        );

        if (vectorStoreError) {
          console.error("Error creating vector store:", vectorStoreError);
          toast.error("Institution created but vector store creation failed");
        } else if (vectorStoreResult?.success) {
          console.log("Vector store created:", vectorStoreResult.vectorStoreId);
        }
      } catch (vsError) {
        console.error("Error invoking vector store function:", vsError);
      }

      // If admin email is provided, create invitation
      if (adminEmail) {
        const { error: invError } = await supabase.from("invitations").insert({
          email: adminEmail,
          institution_id: newInstitution.id,
          role: "admin",
          status: "pending",
        });

        if (invError && invError.code !== "23505") {
          console.error("Error creating admin invitation:", invError);
          toast.warning("Institution created but admin invitation could not be sent");
        }
      }

      toast.success("Institution created successfully!");
      setDialogOpen(false);
      setInstitutionName("");
      setInstitutionSlug("");
      setSlugManuallyEdited(false);
      setInstitutionLanguage("el");
      setInstitutionType("greek_school");
      setSchoolLevels(["dimotiko", "gymnasio", "lykeio"]);
      setInstitutionDescription("");
      setAdminEmail("");
      fetchInstitutions();
    } catch (error: any) {
      toast.error(error.message || "Failed to create institution");
    } finally {
      setIsCreating(false);
    }
  };

  // Super-admin-only toggle (a DB trigger rejects anyone else): whether this
  // institution's OpenAI requests are sent with store:true, i.e. retained in
  // the OpenAI dashboard. Off by default for every institution — see
  // supabase/functions/_shared/openai-retention.ts.
  const handleToggleOpenAIStore = async (institution: Institution, enabled: boolean) => {
    setInstitutions((prev) =>
      prev.map((i) => (i.id === institution.id ? { ...i, openai_store_enabled: enabled } : i))
    );

    const { error } = await supabase
      .from("institutions")
      .update({ openai_store_enabled: enabled })
      .eq("id", institution.id);

    if (error) {
      console.error("Error updating OpenAI retention flag:", error);
      // Revert only this institution's switch — a whole-list snapshot would
      // also undo an unrelated toggle that succeeded while this one was in
      // flight.
      setInstitutions((prev) =>
        prev.map((i) =>
          i.id === institution.id
            ? { ...i, openai_store_enabled: institution.openai_store_enabled }
            : i
        )
      );
      toast.error(error.message || "Failed to update AI data retention");
      return;
    }

    toast.success(
      enabled
        ? `AI data retention enabled for ${institution.name} — new OpenAI requests will be stored`
        : `AI data retention disabled for ${institution.name}`
    );
  };

  const openDeleteDialog = (institution: Institution) => {
    setInstitutionToDelete(institution);
    setDeleteDialogOpen(true);
  };

  const handleDeleteInstitution = async () => {
    if (!institutionToDelete) return;
    
    setIsDeleting(true);
    const institutionId = institutionToDelete.id;

    try {
      // Delete in order to respect foreign key constraints

      // Get all course IDs for this institution first
      const { data: courses } = await supabase
        .from("courses")
        .select("id")
        .eq("institution_id", institutionId);

      const courseIds = courses?.map(c => c.id) || [];

      // Get all class IDs for this institution
      const { data: classRows } = await supabase
        .from("classes")
        .select("id")
        .eq("institution_id", institutionId);
      const classIds = classRows?.map(c => c.id) || [];

      // Delete offerings (references both classes and courses)
      if (classIds.length > 0) {
        await supabase.from("offerings").delete().in("class_id", classIds);
      }
      if (courseIds.length > 0) {
        await supabase.from("offerings").delete().in("course_id", courseIds);
      }

      if (courseIds.length > 0) {
        // Delete quiz-related data
        await supabase.from("quiz_answers").delete().in("course_id", courseIds);
        await supabase.from("quiz_sessions").delete().in("course_id", courseIds);

        // Delete quiz_questions for quizzes in these courses
        const { data: quizzes } = await supabase
          .from("quizzes")
          .select("id")
          .in("course_id", courseIds);
        const quizIds = quizzes?.map(q => q.id) || [];
        if (quizIds.length > 0) {
          await supabase.from("quiz_questions").delete().in("quiz_id", quizIds);
        }
        await supabase.from("quizzes").delete().in("course_id", courseIds);

        // Delete questions and votes
        const { data: questions } = await supabase
          .from("questions")
          .select("id")
          .in("course_id", courseIds);
        const questionIds = questions?.map(q => q.id) || [];
        if (questionIds.length > 0) {
          await supabase.from("question_votes").delete().in("question_id", questionIds);
        }
        await supabase.from("questions").delete().in("course_id", courseIds);

        // Delete material chapters and materials
        const { data: materials } = await supabase
          .from("course_materials")
          .select("id")
          .in("course_id", courseIds);
        const materialIds = materials?.map(m => m.id) || [];
        if (materialIds.length > 0) {
          await supabase.from("material_chapters").delete().in("material_id", materialIds);
        }
        await supabase.from("course_materials").delete().in("course_id", courseIds);

        // Delete courses
        await supabase.from("courses").delete().eq("institution_id", institutionId);
      }

      // Delete classes and their child rows
      if (classIds.length > 0) {
        await supabase.from("class_enrollments").delete().in("class_id", classIds);
        await supabase.from("course_chapter_progress").delete().in("class_id", classIds);
        await supabase.from("classes").delete().eq("institution_id", institutionId);
      }

      // Delete invitations
      await supabase.from("invitations").delete().eq("institution_id", institutionId);

      // Delete user_institutions (memberships)
      await supabase.from("user_institutions").delete().eq("institution_id", institutionId);

      // Finally delete the institution
      const { error } = await supabase
        .from("institutions")
        .delete()
        .eq("id", institutionId);

      if (error) throw error;

      toast.success("Institution and all related data deleted");
      setInstitutions(institutions.filter((i) => i.id !== institutionId));
      setDeleteDialogOpen(false);
      setInstitutionToDelete(null);
    } catch (error: any) {
      console.error("Delete error:", error);
      toast.error(error.message || "Failed to delete institution");
    } finally {
      setIsDeleting(false);
    }
  };

  const handleSignOut = async () => {
    await signOut();
    navigate("/");
  };

  if (loading || loadingData) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (isSuperAdmin === false) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Card className="max-w-md w-full mx-4">
          <CardHeader className="text-center">
            <CardTitle className="text-destructive">Access Denied</CardTitle>
            <CardDescription>
              You do not have super admin privileges.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex justify-center">
            <Button onClick={() => navigate("/dashboard")}>
              Go to Dashboard
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Navigation */}
      <nav className="border-b border-border bg-card sticky top-0 z-50">
        <div className="container mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-primary flex items-center justify-center">
              <BookOpen className="w-6 h-6 text-primary-foreground" />
            </div>
            <div>
              <span className="text-xl font-display font-bold text-foreground">Noisis</span>
              <span className="ml-2 text-xs text-muted-foreground bg-secondary px-2 py-0.5 rounded">
                Super Admin
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <NotificationBell />
            <Button variant="ghost" onClick={handleSignOut}>
              <LogOut className="w-4 h-4 mr-2" />
              Sign Out
            </Button>
          </div>
        </div>
        {/* Navigation Items */}
        <div className="container mx-auto px-6 pb-4">
          <div className="flex items-center gap-2 flex-wrap">
            <Link to="/super-admin/users">
              <Button variant="outline" size="sm">
                <Users className="w-4 h-4 mr-2" />
                Users
              </Button>
            </Link>
            <Link to="/super-admin/stats">
              <Button variant="outline" size="sm">
                <BarChart3 className="w-4 h-4 mr-2" />
                View Stats
              </Button>
            </Link>
            <Link to="/super-admin/ai">
              <Button variant="outline" size="sm">
                <Zap className="w-4 h-4 mr-2" />
                Manage AI
              </Button>
            </Link>
            <Link to="/super-admin/export">
              <Button variant="outline" size="sm">
                <Download className="w-4 h-4 mr-2" />
                Export Data
              </Button>
            </Link>
            <Link to="/super-admin/bug-reports">
              <Button variant="outline" size="sm">
                <Bug className="w-4 h-4 mr-2" />
                Bug Reports
              </Button>
            </Link>
          </div>
        </div>
      </nav>

      <div className="container mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-display font-bold text-foreground">
              Institution Management
            </h1>
            <p className="text-muted-foreground mt-1">
              Manage all institutions on the platform
            </p>
          </div>
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger asChild>
              <Button variant="gold">
                <Plus className="w-4 h-4 mr-2" />
                Add Institution
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Create New Institution</DialogTitle>
                <DialogDescription>
                  Set up a new institution on the platform
                </DialogDescription>
              </DialogHeader>
              <form onSubmit={handleCreateInstitution} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="inst-name">Institution Name</Label>
                  <Input
                    id="inst-name"
                    placeholder="Athens Academy"
                    value={institutionName}
                    onChange={(e) => handleNameChange(e.target.value)}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="inst-slug">URL Slug</Label>
                  <Input
                    id="inst-slug"
                    placeholder="athens-academy"
                    value={institutionSlug}
                    onChange={(e) => handleSlugChange(e.target.value)}
                    required
                  />
                  <p className="text-xs text-muted-foreground">
                    This will be used for the institution's unique URL
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    {/* App is Greece-only for now; all institutions get Greek or English */}
                    <Label htmlFor="inst-language">Default Language</Label>
                    <Select value={institutionLanguage} onValueChange={setInstitutionLanguage}>
                      <SelectTrigger id="inst-language">
                        <SelectValue placeholder="Select language" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="el">Greek (Ελληνικά)</SelectItem>
                        <SelectItem value="en">English</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Country</Label>
                    <div className="flex h-10 items-center rounded-md border border-input bg-muted px-3 text-sm text-muted-foreground">
                      Greece
                    </div>
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>Institution Type</Label>
                  <div className="flex gap-4">
                    {([
                      { value: "generic" as InstitutionType, label: "Generic" },
                      { value: "greek_school" as InstitutionType, label: "Greek School" },
                    ]).map((t) => (
                      <label key={t.value} className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="radio"
                          name="institution-type"
                          value={t.value}
                          checked={institutionType === t.value}
                          onChange={() => setInstitutionType(t.value)}
                          className="accent-primary"
                        />
                        <span className="text-sm">{t.label}</span>
                      </label>
                    ))}
                  </div>
                </div>
                {institutionType === "greek_school" && (
                  <div className="space-y-2">
                    <Label>School Levels</Label>
                    <p className="text-xs text-muted-foreground">
                      Year-level classes will be created automatically for each selected level.
                    </p>
                    <div className="flex flex-col gap-2">
                      {GREEK_SCHOOL_LEVELS.map((level) => (
                        <label key={level.id} className="flex items-center gap-2 cursor-pointer">
                          <Checkbox
                            checked={schoolLevels.includes(level.id)}
                            onCheckedChange={(checked) => {
                              setSchoolLevels((prev) =>
                                checked
                                  ? [...prev, level.id]
                                  : prev.filter((l) => l !== level.id)
                              );
                            }}
                          />
                          <span className="text-sm">
                            {level.labelEl} ({level.labelEn}, {level.years} years)
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                )}
                <div className="space-y-2">
                  <Label htmlFor="inst-description">Description (Optional)</Label>
                  <Textarea
                    id="inst-description"
                    placeholder="A brief description of the institution..."
                    value={institutionDescription}
                    onChange={(e) => setInstitutionDescription(e.target.value)}
                    rows={3}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="admin-email">Admin Email (Optional)</Label>
                  <Input
                    id="admin-email"
                    type="email"
                    placeholder="admin@institution.edu"
                    value={adminEmail}
                    onChange={(e) => setAdminEmail(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    An invitation will be sent to this email as institution admin
                  </p>
                </div>
                <Button type="submit" className="w-full" disabled={isCreating}>
                  {isCreating ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin mr-2" />
                      Creating...
                    </>
                  ) : (
                    "Create Institution"
                  )}
                </Button>
              </form>
            </DialogContent>
          </Dialog>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-lg bg-primary/10 flex items-center justify-center">
                  <Building className="w-6 h-6 text-primary" />
                </div>
                <div>
                  <p className="text-2xl font-bold">{institutions.length}</p>
                  <p className="text-sm text-muted-foreground">Total Institutions</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Institutions List */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Building className="w-5 h-5" />
              All Institutions
            </CardTitle>
          </CardHeader>
          <CardContent>
            {institutions.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <Building className="w-12 h-12 mx-auto mb-4 opacity-50" />
                <p>No institutions yet</p>
                <p className="text-sm">Create your first institution to get started</p>
              </div>
            ) : (
              <div className="space-y-3">
                {institutions.map((institution) => (
                  <div
                    key={institution.id}
                    className="flex items-center justify-between p-4 bg-secondary/50 rounded-lg hover:bg-secondary transition-colors"
                  >
                    <div className="flex items-center gap-4">
                      <SafeImage
                        src={institution.logo_url || undefined}
                        alt={`${institution.name} institution logo`}
                        wrapperClassName="w-10 h-10"
                        className="w-full h-full rounded-lg object-contain"
                        fallback={
                          <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
                            <Building className="w-5 h-5 text-primary" />
                          </div>
                        }
                      />
                      <div>
                        <p className="font-medium text-foreground">{institution.name}</p>
                        <p className="text-sm text-muted-foreground">
                          /i/{institution.slug}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <label className="flex items-center gap-2 mr-2 cursor-pointer">
                        <span className="text-xs text-muted-foreground">
                          AI data retention
                        </span>
                        <Switch
                          checked={institution.openai_store_enabled}
                          onCheckedChange={(checked) =>
                            handleToggleOpenAIStore(institution, checked)
                          }
                          aria-label={`AI data retention for ${institution.name}`}
                        />
                      </label>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => navigate(`/dashboard?institution=${institution.slug}`)}
                      >
                        View
                      </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-destructive hover:text-destructive"
                          // Icon-only, so it had no accessible name at all —
                          // unreachable by screen reader and by name-based test
                          // selectors. Naming it per institution also makes the
                          // right row's trash unambiguous in a long list.
                          aria-label={`Delete ${institution.name}`}
                          onClick={() => openDeleteDialog(institution)}
                        >
                          <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="w-5 h-5" />
              Delete Institution
            </AlertDialogTitle>
            <AlertDialogDescription className="space-y-3">
              <p>
                Are you sure you want to delete <strong>{institutionToDelete?.name}</strong>?
              </p>
              <div className="bg-destructive/10 border border-destructive/20 rounded-lg p-3 text-sm">
                <p className="font-medium text-destructive mb-2">This will permanently delete:</p>
                <ul className="list-disc list-inside space-y-1 text-muted-foreground">
                  <li>All user memberships and access</li>
                  <li>All courses and course materials</li>
                  <li>All questions, quizzes, and quiz history</li>
                  <li>All pending invitations</li>
                </ul>
              </div>
              <p className="text-destructive font-medium">
                This action cannot be undone.
              </p>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteInstitution}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  Deleting...
                </>
              ) : (
                "Delete Institution"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default SuperAdminDashboard;
