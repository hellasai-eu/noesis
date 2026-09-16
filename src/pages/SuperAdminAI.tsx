import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  LogOut,
  Loader2,
  ArrowLeft,
  Zap,
  Database,
  ScrollText,
  Sparkles,
} from "lucide-react";
import { Link } from "react-router-dom";

const SuperAdminAI = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { user, loading, signOut } = useAuth();
  const [isSuperAdmin, setIsSuperAdmin] = useState<boolean | null>(null);
  const [loadingData, setLoadingData] = useState(true);

  const currentTab = searchParams.get("tab") || "usage";

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
    } catch (error) {
      console.error("Error:", error);
      setIsSuperAdmin(false);
    } finally {
      setLoadingData(false);
    }
  };

  const handleSignOut = async () => {
    await signOut();
    navigate("/auth");
  };

  const handleTabChange = (value: string) => {
    // Navigate to the appropriate page based on tab
    switch (value) {
      case "usage":
        navigate("/super-admin/usage");
        break;
      case "cloud":
        navigate("/super-admin/vector-stores");
        break;
      case "logs":
        navigate("/super-admin/agent-logs");
        break;
    }
  };

  if (loading || loadingData) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!isSuperAdmin) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-foreground mb-4">Access Denied</h1>
          <p className="text-muted-foreground mb-4">
            You don't have permission to access this page.
          </p>
          <Button onClick={() => navigate("/dashboard")}>Go to Dashboard</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Navigation */}
      <nav className="border-b border-border bg-card">
        <div className="container mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link to="/super-admin">
              <Button variant="ghost" size="icon">
                <ArrowLeft className="w-5 h-5" />
              </Button>
            </Link>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-primary flex items-center justify-center">
                <Sparkles className="w-6 h-6 text-primary-foreground" />
              </div>
              <div>
                <span className="text-xl font-display font-bold text-foreground">Manage AI</span>
                <span className="ml-2 text-xs text-muted-foreground bg-secondary px-2 py-0.5 rounded">
                  Super Admin
                </span>
              </div>
            </div>
          </div>
          <Button variant="ghost" onClick={handleSignOut}>
            <LogOut className="w-4 h-4 mr-2" />
            Sign Out
          </Button>
        </div>
      </nav>

      <div className="container mx-auto px-6 py-8">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-display font-bold text-foreground mb-2">
            AI Management
          </h1>
          <p className="text-muted-foreground">
            Monitor and manage AI features across the platform
          </p>
        </div>

        <Tabs value={currentTab} onValueChange={handleTabChange} className="space-y-6">
          <TabsList className="grid w-full max-w-2xl mx-auto grid-cols-3">
            <TabsTrigger value="usage" className="flex items-center gap-2">
              <Zap className="w-4 h-4" />
              <span className="hidden sm:inline">AI Usage</span>
            </TabsTrigger>
            <TabsTrigger value="cloud" className="flex items-center gap-2">
              <Database className="w-4 h-4" />
              <span className="hidden sm:inline">AI Cloud</span>
            </TabsTrigger>
            <TabsTrigger value="logs" className="flex items-center gap-2">
              <ScrollText className="w-4 h-4" />
              <span className="hidden sm:inline">Agent Logs</span>
            </TabsTrigger>
          </TabsList>
        </Tabs>

        {/* Quick access cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mt-8">
          <Link to="/super-admin/usage" className="block">
            <div className="p-6 rounded-lg border border-border bg-card hover:bg-secondary/50 transition-colors cursor-pointer">
              <div className="w-12 h-12 rounded-lg bg-primary/10 flex items-center justify-center mb-4">
                <Zap className="w-6 h-6 text-primary" />
              </div>
              <h3 className="font-semibold text-foreground mb-1">AI Usage</h3>
              <p className="text-sm text-muted-foreground">
                Monitor API usage, tokens, and costs across institutions
              </p>
            </div>
          </Link>

          <Link to="/super-admin/vector-stores" className="block">
            <div className="p-6 rounded-lg border border-border bg-card hover:bg-secondary/50 transition-colors cursor-pointer">
              <div className="w-12 h-12 rounded-lg bg-blue-500/10 flex items-center justify-center mb-4">
                <Database className="w-6 h-6 text-blue-500" />
              </div>
              <h3 className="font-semibold text-foreground mb-1">AI Cloud</h3>
              <p className="text-sm text-muted-foreground">
                Manage vector stores and material synchronization
              </p>
            </div>
          </Link>

          <Link to="/super-admin/agent-logs" className="block">
            <div className="p-6 rounded-lg border border-border bg-card hover:bg-secondary/50 transition-colors cursor-pointer">
              <div className="w-12 h-12 rounded-lg bg-amber-500/10 flex items-center justify-center mb-4">
                <ScrollText className="w-6 h-6 text-amber-500" />
              </div>
              <h3 className="font-semibold text-foreground mb-1">Agent Logs</h3>
              <p className="text-sm text-muted-foreground">
                View AI agent interaction logs and debugging info
              </p>
            </div>
          </Link>
        </div>
      </div>
    </div>
  );
};

export default SuperAdminAI;
