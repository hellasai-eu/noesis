import { useEffect, useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { SafeImage } from "@/components/SafeImage";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  LogOut,
  Loader2,
  Building,
  Users,
  GraduationCap,
  BookOpenCheck,
  MessageSquare,
  BarChart3,
  ArrowLeft,
  Clock,
  Globe,
} from "lucide-react";
import { format } from "date-fns";
import { BrandMark } from "@/components/BrandMark";

interface InstitutionStats {
  id: string;
  name: string;
  slug: string;
  logo_url: string | null;
  created_at: string;
  userCount: number;
  courseCount: number;
  questionCount: number;
  openQuestionCount: number;
  materialCount: number;
  adminCount: number;
  instructorCount: number;
  studentCount: number;
}

interface LoginHistoryEntry {
  id: string;
  user_id: string;
  ip_address: string | null;
  user_agent: string | null;
  login_at: string;
  user_email?: string;
  user_name?: string;
  institution_name?: string;
}

const SuperAdminStats = () => {
  const navigate = useNavigate();
  const { user, loading, signOut } = useAuth();
  const [isSuperAdmin, setIsSuperAdmin] = useState<boolean | null>(null);
  const [institutionStats, setInstitutionStats] = useState<InstitutionStats[]>([]);
  const [loginHistory, setLoginHistory] = useState<LoginHistoryEntry[]>([]);
  const [loadingData, setLoadingData] = useState(true);
  const [activeTab, setActiveTab] = useState<'institutions' | 'logins'>('institutions');

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
        await Promise.all([fetchInstitutionStats(), fetchLoginHistory()]);
      }
      setLoadingData(false);
    } catch (error) {
      console.error("Error:", error);
      setIsSuperAdmin(false);
      setLoadingData(false);
    }
  };

  const fetchInstitutionStats = async () => {
    try {
      // Fetch institutions
      const { data: institutions, error: instError } = await supabase
        .from("institutions")
        .select("id, name, slug, logo_url, created_at")
        .order("name");

      if (instError) throw instError;

      // Fetch all stats in parallel
      const statsPromises = (institutions || []).map(async (inst) => {
        const [
          usersResult,
          coursesResult,
          questionsResult,
          openQuestionsResult,
          materialsResult,
          roleCountsResult,
        ] = await Promise.all([
          supabase
            .from("user_institutions")
            .select("id", { count: "exact", head: true })
            .eq("institution_id", inst.id),
          supabase
            .from("courses")
            .select("id", { count: "exact", head: true })
            .eq("institution_id", inst.id),
          supabase
            .from("questions")
            .select("id, courses!inner(institution_id)", { count: "exact", head: true })
            .eq("courses.institution_id", inst.id),
          supabase
            .from("questions")
            .select("id, courses!inner(institution_id)", { count: "exact", head: true })
            .eq("courses.institution_id", inst.id)
            .eq("type", "open"),
          supabase
            .from("course_materials")
            .select("id, courses!inner(institution_id)", { count: "exact", head: true })
            .eq("courses.institution_id", inst.id),
          supabase
            .from("user_institutions")
            .select("role")
            .eq("institution_id", inst.id),
        ]);

        const roles = roleCountsResult.data || [];
        const adminCount = roles.filter((r) => r.role === "admin").length;
        const instructorCount = roles.filter((r) => r.role === "instructor").length;
        const studentCount = roles.filter((r) => r.role === "student").length;

        return {
          ...inst,
          userCount: usersResult.count || 0,
          courseCount: coursesResult.count || 0,
          questionCount: questionsResult.count || 0,
          openQuestionCount: openQuestionsResult.count || 0,
          materialCount: materialsResult.count || 0,
          adminCount,
          instructorCount,
          studentCount,
        };
      });

      const stats = await Promise.all(statsPromises);
      setInstitutionStats(stats);
    } catch (error) {
      console.error("Error fetching institution stats:", error);
    }
  };

  const fetchLoginHistory = async () => {
    try {
      // Fetch recent login history
      const { data: logins, error: loginsError } = await supabase
        .from("login_history")
        .select("*")
        .order("login_at", { ascending: false })
        .limit(100);

      if (loginsError) throw loginsError;

      // Get user profiles for the logins
      const userIds = [...new Set((logins || []).map((l) => l.user_id))];
      
      const { data: profiles } = await supabase
        .from("profiles")
        .select("user_id, full_name, email")
        .in("user_id", userIds);

      // Get user institutions
      const { data: userInsts } = await supabase
        .from("user_institutions")
        .select("user_id, institutions(name)")
        .in("user_id", userIds);

      // Get super admin emails to hide their institution
      const { data: superAdmins } = await supabase
        .from("super_admins")
        .select("email");
      
      const superAdminEmails = new Set((superAdmins || []).map((sa) => sa.email));

      const profileMap = new Map(
        (profiles || []).map((p) => [p.user_id, p])
      );
      const instMap = new Map(
        (userInsts || []).map((ui) => [ui.user_id, (ui.institutions as any)?.name])
      );

      const enrichedLogins = (logins || []).map((login) => {
        const userEmail = profileMap.get(login.user_id)?.email || "Unknown";
        const isSuperAdminUser = superAdminEmails.has(userEmail);
        return {
          ...login,
          user_email: userEmail,
          user_name: profileMap.get(login.user_id)?.full_name || "Unknown",
          institution_name: isSuperAdminUser ? "-" : (instMap.get(login.user_id) || "N/A"),
        };
      });

      setLoginHistory(enrichedLogins);
    } catch (error) {
      console.error("Error fetching login history:", error);
    }
  };

  const handleSignOut = async () => {
    await signOut();
    navigate("/");
  };

  const getTotalStats = () => {
    return {
      totalUsers: institutionStats.reduce((sum, i) => sum + i.userCount, 0),
      totalCourses: institutionStats.reduce((sum, i) => sum + i.courseCount, 0),
      totalQuestions: institutionStats.reduce((sum, i) => sum + i.questionCount + i.openQuestionCount, 0),
      totalMaterials: institutionStats.reduce((sum, i) => sum + i.materialCount, 0),
    };
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

  const totals = getTotalStats();

  return (
    <div className="min-h-screen bg-background">
      {/* Navigation */}
      <nav className="border-b border-border bg-card sticky top-0 z-50">
        <div className="container mx-auto px-6 py-4 flex items-center justify-between">
          <BrandMark
            badge={
              <span className="ml-2 text-xs text-muted-foreground bg-secondary px-2 py-0.5 rounded">
                Super Admin
              </span>
            }
          />
          <div className="flex items-center gap-4">
            <Link to="/super-admin">
              <Button variant="ghost" size="sm">
                <ArrowLeft className="w-4 h-4 mr-2" />
                Back to Management
              </Button>
            </Link>
            <Button variant="ghost" onClick={handleSignOut}>
              <LogOut className="w-4 h-4 mr-2" />
              Sign Out
            </Button>
          </div>
        </div>
      </nav>

      <div className="container mx-auto px-6 py-8">
        <div className="mb-8">
          <h1 className="text-3xl font-display font-bold text-foreground flex items-center gap-3">
            <BarChart3 className="w-8 h-8" />
            Platform Statistics
          </h1>
          <p className="text-muted-foreground mt-1">
            Overview of all institutions and platform activity
          </p>
        </div>

        {/* Global Stats */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-lg bg-primary/10 flex items-center justify-center">
                  <Building className="w-6 h-6 text-primary" />
                </div>
                <div>
                  <p className="text-2xl font-bold">{institutionStats.length}</p>
                  <p className="text-sm text-muted-foreground">Institutions</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-lg bg-blue-500/10 flex items-center justify-center">
                  <Users className="w-6 h-6 text-blue-500" />
                </div>
                <div>
                  <p className="text-2xl font-bold">{totals.totalUsers}</p>
                  <p className="text-sm text-muted-foreground">Total Users</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-lg bg-green-500/10 flex items-center justify-center">
                  <GraduationCap className="w-6 h-6 text-green-500" />
                </div>
                <div>
                  <p className="text-2xl font-bold">{totals.totalCourses}</p>
                  <p className="text-sm text-muted-foreground">Total Courses</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-lg bg-purple-500/10 flex items-center justify-center">
                  <MessageSquare className="w-6 h-6 text-purple-500" />
                </div>
                <div>
                  <p className="text-2xl font-bold">{totals.totalQuestions}</p>
                  <p className="text-sm text-muted-foreground">Total Questions</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Tabs */}
        <div className="flex gap-2 mb-6">
          <Button
            variant={activeTab === 'institutions' ? 'default' : 'outline'}
            onClick={() => setActiveTab('institutions')}
          >
            <Building className="w-4 h-4 mr-2" />
            Institution Stats
          </Button>
          <Button
            variant={activeTab === 'logins' ? 'default' : 'outline'}
            onClick={() => setActiveTab('logins')}
          >
            <Clock className="w-4 h-4 mr-2" />
            Login History
          </Button>
        </div>

        {activeTab === 'institutions' && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Building className="w-5 h-5" />
                Statistics by Institution
              </CardTitle>
              <CardDescription>
                Detailed breakdown of users, courses, and content per institution
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Institution</TableHead>
                      <TableHead className="text-center">Users</TableHead>
                      <TableHead className="text-center">Admins</TableHead>
                      <TableHead className="text-center">Instructors</TableHead>
                      <TableHead className="text-center">Students</TableHead>
                      <TableHead className="text-center">Courses</TableHead>
                      <TableHead className="text-center">MCQ</TableHead>
                      <TableHead className="text-center">Open Q</TableHead>
                      <TableHead className="text-center">Materials</TableHead>
                      <TableHead className="text-center">Created</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {institutionStats.map((inst) => (
                      <TableRow key={inst.id}>
                        <TableCell>
                          <div className="flex items-center gap-3">
                            <SafeImage
                              src={inst.logo_url || undefined}
                              alt={`${inst.name} institution logo`}
                              wrapperClassName="w-8 h-8"
                              className="w-full h-full rounded object-contain"
                              fallback={
                                <div className="w-8 h-8 rounded bg-primary/10 flex items-center justify-center">
                                  <Building className="w-4 h-4 text-primary" />
                                </div>
                              }
                            />
                            <div>
                              <p className="font-medium">{inst.name}</p>
                              <p className="text-xs text-muted-foreground">{inst.slug}</p>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="text-center font-medium">{inst.userCount}</TableCell>
                        <TableCell className="text-center">
                          <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-red-500/10 text-red-500 text-xs font-medium">
                            {inst.adminCount}
                          </span>
                        </TableCell>
                        <TableCell className="text-center">
                          <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-blue-500/10 text-blue-500 text-xs font-medium">
                            {inst.instructorCount}
                          </span>
                        </TableCell>
                        <TableCell className="text-center">
                          <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-green-500/10 text-green-500 text-xs font-medium">
                            {inst.studentCount}
                          </span>
                        </TableCell>
                        <TableCell className="text-center">{inst.courseCount}</TableCell>
                        <TableCell className="text-center">{inst.questionCount}</TableCell>
                        <TableCell className="text-center">{inst.openQuestionCount}</TableCell>
                        <TableCell className="text-center">{inst.materialCount}</TableCell>
                        <TableCell className="text-center text-muted-foreground text-sm">
                          {format(new Date(inst.created_at), "MMM d, yyyy")}
                        </TableCell>
                      </TableRow>
                    ))}
                    {institutionStats.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={10} className="text-center py-8 text-muted-foreground">
                          No institutions found
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        )}

        {activeTab === 'logins' && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Clock className="w-5 h-5" />
                Recent Login History
              </CardTitle>
              <CardDescription>
                Last 100 login events across all users
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>User</TableHead>
                      <TableHead>Institution</TableHead>
                      <TableHead>
                        <div className="flex items-center gap-1">
                          <Globe className="w-4 h-4" />
                          IP Address
                        </div>
                      </TableHead>
                      <TableHead>Device / Browser</TableHead>
                      <TableHead>Login Time</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {loginHistory.map((entry) => (
                      <TableRow key={entry.id}>
                        <TableCell>
                          <div>
                            <p className="font-medium">{entry.user_name}</p>
                            <p className="text-xs text-muted-foreground">{entry.user_email}</p>
                          </div>
                        </TableCell>
                        <TableCell>
                          <span className="text-sm">{entry.institution_name}</span>
                        </TableCell>
                        <TableCell>
                          <code className="text-xs bg-secondary px-2 py-1 rounded">
                            {entry.ip_address || "Unknown"}
                          </code>
                        </TableCell>
                        <TableCell>
                          <p className="text-xs text-muted-foreground max-w-[200px] truncate" title={entry.user_agent || undefined}>
                            {entry.user_agent ? parseUserAgent(entry.user_agent) : "Unknown"}
                          </p>
                        </TableCell>
                        <TableCell>
                          <div className="text-sm">
                            <p>{format(new Date(entry.login_at), "MMM d, yyyy")}</p>
                            <p className="text-xs text-muted-foreground">
                              {format(new Date(entry.login_at), "h:mm a")}
                            </p>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                    {loginHistory.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={5} className="text-center py-8 text-muted-foreground">
                          No login history found
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
};

// Helper function to parse user agent into a readable format
function parseUserAgent(ua: string): string {
  if (ua.includes("Chrome")) return "Chrome";
  if (ua.includes("Firefox")) return "Firefox";
  if (ua.includes("Safari") && !ua.includes("Chrome")) return "Safari";
  if (ua.includes("Edge")) return "Edge";
  if (ua.includes("Mobile")) return "Mobile Browser";
  return "Browser";
}

export default SuperAdminStats;
