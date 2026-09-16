import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  ArrowLeft,
  BookOpen,
  Bug,
  Loader2,
  LogOut,
  Paperclip,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { useFormatters } from "@/i18n/formatters";

const STATUS_VALUES = ["new", "in_progress", "resolved", "wont_fix"] as const;
type BugReportStatus = (typeof STATUS_VALUES)[number];

interface BugReportRow {
  id: string;
  reporter_id: string | null;
  reporter_email: string | null;
  reporter_role: string | null;
  institution_id: string | null;
  title: string;
  description: string;
  page_url: string | null;
  user_agent: string | null;
  viewport: string | null;
  os: string | null;
  screenshot_paths: string[];
  status: BugReportStatus;
  created_at: string;
  updated_at: string;
}

const STATUS_LABEL: Record<BugReportStatus, string> = {
  new: "New",
  in_progress: "In progress",
  resolved: "Resolved",
  wont_fix: "Won't fix",
};

function statusBadgeClass(status: BugReportStatus): string {
  switch (status) {
    case "new":
      return "bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/30";
    case "in_progress":
      return "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30";
    case "resolved":
      return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30";
    case "wont_fix":
      return "bg-muted text-muted-foreground border-border";
  }
}

const SuperAdminBugReports = () => {
  const { formatDate, formatTime } = useFormatters();
  const formatTimestamp = (iso: string) =>
    `${formatDate(iso)} ${formatTime(iso, { hour: "2-digit", minute: "2-digit" })}`;
  const navigate = useNavigate();
  const { user, loading, signOut } = useAuth();
  const [isSuperAdmin, setIsSuperAdmin] = useState<boolean | null>(null);
  const [reports, setReports] = useState<BugReportRow[]>([]);
  const [loadingData, setLoadingData] = useState(true);
  const [selectedReport, setSelectedReport] = useState<BugReportRow | null>(null);
  const [screenshotUrls, setScreenshotUrls] = useState<Record<string, string>>({});
  const [updatingStatus, setUpdatingStatus] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<BugReportRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (!loading && !user) {
      navigate("/auth");
      return;
    }
    if (user) {
      void checkSuperAdmin();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, loading, navigate]);

  const checkSuperAdmin = async () => {
    try {
      const { data, error } = await supabase.rpc("is_super_admin", { _user_id: user!.id });
      if (error) throw error;
      setIsSuperAdmin(Boolean(data));
      if (data) {
        await fetchReports();
      } else {
        setLoadingData(false);
      }
    } catch (err) {
      console.error("Error checking super admin status:", err);
      setIsSuperAdmin(false);
      setLoadingData(false);
    }
  };

  const fetchReports = async () => {
    setLoadingData(true);
    try {
      const { data, error } = await (supabase.from("bug_reports" as any) as any)
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      setReports(((data as BugReportRow[]) || []));
    } catch (err: any) {
      console.error("Error fetching bug reports:", err);
      toast.error(err?.message || "Failed to load bug reports");
    } finally {
      setLoadingData(false);
    }
  };

  // Generate signed URLs (1h) for the detail dialog's screenshots.
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (!selectedReport || selectedReport.screenshot_paths.length === 0) {
        setScreenshotUrls({});
        return;
      }
      try {
        const { data, error } = await supabase.storage
          .from("bug-reports")
          .createSignedUrls(selectedReport.screenshot_paths, 3600);
        if (error) throw error;
        if (cancelled) return;
        const map: Record<string, string> = {};
        data?.forEach((item, idx) => {
          const path = selectedReport.screenshot_paths[idx];
          if (item.signedUrl) map[path] = item.signedUrl;
        });
        setScreenshotUrls(map);
      } catch (err) {
        console.error("Failed to sign bug report screenshots:", err);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [selectedReport]);

  const handleStatusChange = async (status: BugReportStatus) => {
    if (!selectedReport) return;
    setUpdatingStatus(true);
    try {
      const { error } = await (supabase.from("bug_reports" as any) as any)
        .update({ status })
        .eq("id", selectedReport.id);
      if (error) throw error;
      const updated = { ...selectedReport, status };
      setSelectedReport(updated);
      setReports((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
      toast.success("Status updated");
    } catch (err: any) {
      console.error("Failed to update bug report status:", err);
      toast.error(err?.message || "Failed to update status");
    } finally {
      setUpdatingStatus(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      // Best-effort: remove uploaded screenshots first so we don't leak files.
      if (deleteTarget.screenshot_paths.length > 0) {
        const { error: rmError } = await supabase.storage
          .from("bug-reports")
          .remove(deleteTarget.screenshot_paths);
        if (rmError) {
          console.warn("Failed to remove screenshots:", rmError);
        }
      }
      const { error } = await (supabase.from("bug_reports" as any) as any)
        .delete()
        .eq("id", deleteTarget.id);
      if (error) throw error;
      setReports((prev) => prev.filter((r) => r.id !== deleteTarget.id));
      if (selectedReport?.id === deleteTarget.id) setSelectedReport(null);
      toast.success("Bug report deleted");
      setDeleteTarget(null);
    } catch (err: any) {
      console.error("Failed to delete bug report:", err);
      toast.error(err?.message || "Failed to delete report");
    } finally {
      setDeleting(false);
    }
  };

  const handleSignOut = async () => {
    await signOut();
    navigate("/");
  };

  const stats = useMemo(() => {
    const counts: Record<BugReportStatus, number> = {
      new: 0,
      in_progress: 0,
      resolved: 0,
      wont_fix: 0,
    };
    for (const r of reports) counts[r.status] = (counts[r.status] ?? 0) + 1;
    return counts;
  }, [reports]);

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
          </CardHeader>
          <CardContent className="flex justify-center">
            <Button onClick={() => navigate("/dashboard")}>Go to Dashboard</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
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
          <div className="flex items-center gap-4">
            <Link to="/super-admin">
              <Button variant="outline">
                <ArrowLeft className="w-4 h-4 mr-2" />
                Back to Dashboard
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
          <h1 className="text-3xl font-display font-bold text-foreground flex items-center gap-2">
            <Bug className="w-7 h-7" />
            Bug Reports
          </h1>
          <p className="text-muted-foreground mt-1">
            User-submitted reports from the dashboard.
          </p>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          {STATUS_VALUES.map((s) => (
            <Card key={s}>
              <CardContent className="pt-6">
                <p className="text-2xl font-bold">{stats[s]}</p>
                <p className="text-sm text-muted-foreground">{STATUS_LABEL[s]}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        <Card>
          <CardHeader>
            <CardTitle>All Reports ({reports.length})</CardTitle>
          </CardHeader>
          <CardContent>
            {reports.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <Bug className="w-12 h-12 mx-auto mb-4 opacity-50" />
                <p>No bug reports yet</p>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Title</TableHead>
                    <TableHead>Reporter</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Attachments</TableHead>
                    <TableHead>Submitted</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {reports.map((r) => (
                    <TableRow
                      key={r.id}
                      className="cursor-pointer"
                      onClick={() => setSelectedReport(r)}
                    >
                      <TableCell className="font-medium max-w-xs truncate">
                        {r.title}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {r.reporter_email || "—"}
                      </TableCell>
                      <TableCell className="text-sm">{r.reporter_role || "—"}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className={statusBadgeClass(r.status)}>
                          {STATUS_LABEL[r.status]}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {r.screenshot_paths.length > 0 ? (
                          <span className="inline-flex items-center gap-1">
                            <Paperclip className="w-3 h-3" />
                            {r.screenshot_paths.length}
                          </span>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                        {formatTimestamp(r.created_at)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      <Dialog
        open={!!selectedReport}
        onOpenChange={(open) => {
          if (!open) setSelectedReport(null);
        }}
      >
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          {selectedReport && (
            <>
              <DialogHeader>
                <DialogTitle className="pr-8">{selectedReport.title}</DialogTitle>
                <DialogDescription>
                  Submitted {formatTimestamp(selectedReport.created_at)} by{" "}
                  {selectedReport.reporter_email || "unknown"}
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-6">
                <div className="flex items-center gap-3">
                  <Select
                    value={selectedReport.status}
                    onValueChange={(v) => handleStatusChange(v as BugReportStatus)}
                    disabled={updatingStatus}
                  >
                    <SelectTrigger className="w-48">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {STATUS_VALUES.map((s) => (
                        <SelectItem key={s} value={s}>
                          {STATUS_LABEL[s]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {updatingStatus && <Loader2 className="w-4 h-4 animate-spin" />}
                  <div className="flex-1" />
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    onClick={() => setDeleteTarget(selectedReport)}
                  >
                    <Trash2 className="w-4 h-4 mr-2" />
                    Delete
                  </Button>
                </div>

                <div>
                  <h3 className="text-sm font-semibold mb-2">Description</h3>
                  <p className="text-sm whitespace-pre-wrap bg-secondary/40 rounded-md p-3">
                    {selectedReport.description}
                  </p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3 text-sm">
                  <div>
                    <p className="text-muted-foreground">Reporter role</p>
                    <p>{selectedReport.reporter_role || "—"}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Institution ID</p>
                    <p className="font-mono text-xs break-all">
                      {selectedReport.institution_id || "—"}
                    </p>
                  </div>
                  <div className="md:col-span-2">
                    <p className="text-muted-foreground">Page URL</p>
                    <p className="font-mono text-xs break-all">
                      {selectedReport.page_url || "—"}
                    </p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Viewport</p>
                    <p>{selectedReport.viewport || "—"}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">OS</p>
                    <p>{selectedReport.os || "—"}</p>
                  </div>
                  <div className="md:col-span-2">
                    <p className="text-muted-foreground">User agent</p>
                    <p className="font-mono text-xs break-all">
                      {selectedReport.user_agent || "—"}
                    </p>
                  </div>
                </div>

                {selectedReport.screenshot_paths.length > 0 && (
                  <div>
                    <h3 className="text-sm font-semibold mb-2">
                      Screenshots ({selectedReport.screenshot_paths.length})
                    </h3>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {selectedReport.screenshot_paths.map((path) => {
                        const url = screenshotUrls[path];
                        return (
                          <div
                            key={path}
                            className="rounded-md overflow-hidden border bg-secondary/40"
                          >
                            {url ? (
                              <a href={url} target="_blank" rel="noreferrer">
                                <img
                                  src={url}
                                  alt={path}
                                  className="w-full h-auto object-contain max-h-80"
                                />
                              </a>
                            ) : (
                              <div className="aspect-video flex items-center justify-center">
                                <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open && !deleting) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete bug report?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the report and any uploaded screenshots.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Deleting...
                </>
              ) : (
                "Delete"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default SuperAdminBugReports;
