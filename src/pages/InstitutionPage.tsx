import { useEffect, useState } from "react";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import { validateNewPassword } from "@/lib/password-policy";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CourseDetail } from "@/components/CourseDetail";
import {
  BookOpen,
  Loader2,
  LogOut,
  FileText,
  Mail,
  Lock,
  User,
} from "lucide-react";
import { toast } from "sonner";

interface Institution {
  id: string;
  name: string;
  slug: string;
  logo_url: string | null;
}

interface Course {
  id: string;
  title: string;
  description: string | null;
  theme: string | null;
  institution_id: string;
}

interface UserMembership {
  institution_id: string;
  role: string;
  is_suspended: boolean;
}

const InstitutionPage = () => {
  const { slug } = useParams<{ slug: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { user, profile, loading: authLoading, signIn, signUp, signOut } = useAuth();
  
  const [institution, setInstitution] = useState<Institution | null>(null);
  const [courses, setCourses] = useState<Course[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [membership, setMembership] = useState<UserMembership | null>(null);
  const [membershipLoading, setMembershipLoading] = useState(true);
  
  // Auth form state
  const [isLogin, setIsLogin] = useState(true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  
  // Course detail
  const [selectedCourse, setSelectedCourse] = useState<Course | null>(null);
  const [courseDetailOpen, setCourseDetailOpen] = useState(false);

  // Check if user came from invitation email
  const inviteParam = searchParams.get("invite");

  // Check if user belongs to a different institution (must be declared before early returns)
  const [hasOtherMembership, setHasOtherMembership] = useState(false);

  useEffect(() => {
    if (slug) {
      fetchInstitution();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch on slug change
  }, [slug]);

  // Check user's membership in this institution
  useEffect(() => {
    const checkMembership = async () => {
      if (!user || !institution) {
        setMembershipLoading(false);
        return;
      }

      const { data } = await supabase
        .from("user_institutions")
        .select("institution_id, role, is_suspended")
        .eq("user_id", user.id)
        .eq("institution_id", institution.id)
        .maybeSingle();

      setMembership(data);
      setMembershipLoading(false);
    };

    if (user && institution) {
      checkMembership();
    } else {
      setMembershipLoading(false);
    }
  }, [user, institution]);

  useEffect(() => {
    // If user is logged in and is a member of this institution, fetch courses
    if (user && membership && institution) {
      fetchCourses();
    }
    // If user is logged in but not part of this institution, try to join via invitation
    if (user && institution && !membership && !membershipLoading && inviteParam) {
      handleJoinInstitution();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally only runs when membership state changes
  }, [user, membership, institution, membershipLoading]);

  // Check if user belongs to a different institution (must be before early returns)
  useEffect(() => {
    const checkOtherMemberships = async () => {
      if (!user || membership) return;
      
      const { data } = await supabase
        .from("user_institutions")
        .select("institution_id")
        .eq("user_id", user.id)
        .limit(1);
      
      setHasOtherMembership((data?.length || 0) > 0);
    };

    checkOtherMemberships();
  }, [user, membership]);

  const fetchInstitution = async () => {
    try {
      // Fetch institution by slug (public query)
      const { data, error } = await supabase
        .from("institutions")
        .select("*")
        .eq("slug", slug)
        .maybeSingle();

      if (error) throw error;

      if (!data) {
        setNotFound(true);
      } else {
        setInstitution(data);
      }
    } catch (error) {
      console.error("Error fetching institution:", error);
      setNotFound(true);
    } finally {
      setLoading(false);
    }
  };

  const fetchCourses = async () => {
    if (!institution) return;
    
    try {
      const { data, error } = await supabase
        .from("courses")
        .select("*")
        .eq("institution_id", institution.id)
        .order("created_at", { ascending: false });

      if (error) throw error;
      setCourses(data || []);
    } catch (error) {
      console.error("Error fetching courses:", error);
    }
  };

  const handleJoinInstitution = async () => {
    if (!institution || !user) return;

    try {
      // Check if there's a pending invitation for this user
      if (user.email) {
        const { data: inviteData } = await supabase
          .from("invitations")
          .select("id, role")
          .eq("institution_id", institution.id)
          .eq("email", user.email)
          .eq("status", "pending")
          .maybeSingle();
        
        if (inviteData) {
          // Use edge function to process invitation with tags
          const { data, error: fnError } = await supabase.functions.invoke('accept-invitation', {
            body: { invitationId: inviteData.id }
          });

          if (fnError) {
            console.error("Error accepting invitation:", fnError);
            throw new Error(fnError.message || "Failed to process invitation");
          }

          console.log("Invitation accepted:", data);
          toast.success(`Welcome to ${institution.name}!`);
          window.location.reload();
          return;
        }
      }

      // No invitation found - create basic membership
      const { error } = await supabase
        .from("user_institutions")
        .insert({
          user_id: user.id,
          institution_id: institution.id,
          role: "student",
        });

      if (error) throw error;

      toast.success(`Welcome to ${institution.name}!`);
      window.location.reload();
    } catch (error: any) {
      console.error("Error joining institution:", error);
      toast.error("Failed to join institution");
    }
  };

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);

    try {
      if (isLogin) {
        const { error } = await signIn(email, password);
        if (error) throw error;
        toast.success("Signed in successfully!");
      } else {
        // Shared mirror of the server-enforced Supabase Auth policy — only
        // for sign-UP; existing accounts may predate the stricter rules.
        const policyError = validateNewPassword(password);
        if (policyError) throw new Error(policyError);
        const { error } = await signUp(email, password, fullName);
        if (error) throw error;
        toast.success("Account created! Joining institution...");
      }
    } catch (error: any) {
      toast.error(error.message || "Authentication failed");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSignOut = async () => {
    await signOut();
  };

  if (loading || authLoading || membershipLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (notFound) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-center">
          <h1 className="text-4xl font-display font-bold text-foreground mb-4">
            Institution Not Found
          </h1>
          <p className="text-muted-foreground mb-6">
            The institution you're looking for doesn't exist.
          </p>
          <Button onClick={() => navigate("/")}>Go Home</Button>
        </div>
      </div>
    );
  }

  // Check if user is part of this institution
  const isMember = user && membership && !membership.is_suspended;
  const isSuspended = user && membership && membership.is_suspended;
  const needsToJoin = user && !membership;

  // Show suspended message
  if (isSuspended) {
    return (
      <div className="min-h-screen bg-background">
        <nav className="border-b border-border bg-card">
          <div className="container mx-auto px-6 py-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-primary flex items-center justify-center">
                <BookOpen className="w-6 h-6 text-primary-foreground" />
              </div>
              <div>
                <span className="text-xl font-display font-bold text-foreground">
                  {institution?.name}
                </span>
                <p className="text-xs text-muted-foreground">Powered by Noesis</p>
              </div>
            </div>
            <Button variant="ghost" size="sm" onClick={handleSignOut}>
              <LogOut className="w-4 h-4" />
            </Button>
          </div>
        </nav>
        <div className="container mx-auto px-6 py-16">
          <div className="max-w-md mx-auto text-center">
            <div className="w-16 h-16 rounded-full bg-yellow-500/20 flex items-center justify-center mx-auto mb-6">
              <Lock className="w-8 h-8 text-yellow-600" />
            </div>
            <h1 className="text-2xl font-display font-bold text-foreground mb-4">
              Account Suspended
            </h1>
            <p className="text-muted-foreground">
              Your access to {institution?.name} has been suspended. 
              Please contact an administrator for more information.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <nav className="border-b border-border bg-card">
        <div className="container mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-primary flex items-center justify-center">
              <BookOpen className="w-6 h-6 text-primary-foreground" />
            </div>
            <div>
              <span className="text-xl font-display font-bold text-foreground">
                {institution?.name}
              </span>
              <p className="text-xs text-muted-foreground">Powered by Noesis</p>
            </div>
          </div>
          {user && (
            <div className="flex items-center gap-4">
              <span className="text-sm text-muted-foreground">
                {profile?.full_name || profile?.email}
              </span>
              <Button variant="ghost" size="sm" onClick={handleSignOut}>
                <LogOut className="w-4 h-4" />
              </Button>
            </div>
          )}
        </div>
      </nav>

      <main className="container mx-auto px-6 py-12">
        {/* Not logged in - show auth form */}
        {!user && (
          <div className="max-w-md mx-auto">
            <div className="text-center mb-8">
              <h1 className="text-3xl font-display font-bold text-foreground mb-2">
                {isLogin ? "Welcome Back" : "Join"} {institution?.name}
              </h1>
              <p className="text-muted-foreground">
                {isLogin
                  ? "Sign in to access your courses"
                  : "Create an account to start learning"}
              </p>
            </div>

            <Card>
              <CardContent className="pt-6">
                <form onSubmit={handleAuth} className="space-y-4">
                  {!isLogin && (
                    <div className="space-y-2">
                      <Label htmlFor="fullName">Full Name</Label>
                      <div className="relative">
                        <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                        <Input
                          id="fullName"
                          placeholder="Your name"
                          value={fullName}
                          onChange={(e) => setFullName(e.target.value)}
                          className="pl-10"
                          required={!isLogin}
                        />
                      </div>
                    </div>
                  )}
                  <div className="space-y-2">
                    <Label htmlFor="email">Email</Label>
                    <div className="relative">
                      <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                      <Input
                        id="email"
                        type="email"
                        placeholder="you@example.com"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        className="pl-10"
                        required
                      />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="password">Password</Label>
                    <div className="relative">
                      <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                      <Input
                        id="password"
                        type="password"
                        placeholder="••••••••"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        className="pl-10"
                        required
                        minLength={6}
                      />
                    </div>
                  </div>
                  <Button type="submit" className="w-full" disabled={isSubmitting}>
                    {isSubmitting ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        {isLogin ? "Signing in..." : "Creating account..."}
                      </>
                    ) : isLogin ? (
                      "Sign In"
                    ) : (
                      "Create Account"
                    )}
                  </Button>
                </form>

                <div className="mt-6 text-center">
                  <button
                    type="button"
                    onClick={() => setIsLogin(!isLogin)}
                    className="text-sm text-primary hover:underline"
                  >
                    {isLogin
                      ? "Don't have an account? Sign up"
                      : "Already have an account? Sign in"}
                  </button>
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Logged in but needs to join */}
        {needsToJoin && !hasOtherMembership && (
          <div className="max-w-md mx-auto text-center">
            <h1 className="text-3xl font-display font-bold text-foreground mb-4">
              Join {institution?.name}
            </h1>
            <p className="text-muted-foreground mb-6">
              Click below to join this institution and access courses.
            </p>
            <Button onClick={handleJoinInstitution} size="lg">
              Join Institution
            </Button>
          </div>
        )}

        {/* Logged in and is member - show courses */}
        {isMember && (
          <>
            <h2 className="text-2xl font-display font-bold text-foreground mb-6">
              Your Courses
            </h2>

            {courses.length === 0 ? (
              <Card className="border-dashed">
                <CardContent className="py-12 text-center">
                  <BookOpen className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
                  <h3 className="text-lg font-medium text-foreground mb-2">
                    No courses available
                  </h3>
                  <p className="text-muted-foreground">
                    Courses will appear here once created by your instructor.
                  </p>
                </CardContent>
              </Card>
            ) : (
              <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
                {courses.map((course) => (
                  <Card
                    key={course.id}
                    className="group hover:shadow-elegant transition-all cursor-pointer"
                    onClick={() => {
                      setSelectedCourse(course);
                      setCourseDetailOpen(true);
                    }}
                  >
                    <CardHeader>
                      {course.theme && (
                        <span className="text-xs px-2 py-1 bg-gold/10 text-gold-dark rounded-full mb-2 inline-block w-fit">
                          {course.theme}
                        </span>
                      )}
                      <CardTitle className="text-lg">{course.title}</CardTitle>
                      <CardDescription className="line-clamp-2">
                        {course.description || "No description provided"}
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      <Button variant="outline" size="sm" className="w-full">
                        <FileText className="w-4 h-4 mr-2" />
                        View Materials
                      </Button>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}

            <CourseDetail
              course={selectedCourse}
              open={courseDetailOpen}
              onOpenChange={setCourseDetailOpen}
              isAdmin={false}
            />
          </>
        )}

        {/* Logged in but part of different institution */}
        {user && hasOtherMembership && !membership && (
          <div className="max-w-md mx-auto text-center">
            <h1 className="text-2xl font-display font-bold text-foreground mb-4">
              Already Part of Another Institution
            </h1>
            <p className="text-muted-foreground mb-6">
              You're currently a member of a different institution. 
              Please contact your administrator if you need to switch.
            </p>
            <Button onClick={() => navigate("/dashboard")}>
              Go to Your Dashboard
            </Button>
          </div>
        )}
      </main>
    </div>
  );
};

export default InstitutionPage;