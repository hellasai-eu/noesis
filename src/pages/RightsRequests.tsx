import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, CalendarClock, Loader2, Plus, Scale } from "lucide-react";
import { toast } from "sonner";
import { compareCode, compareText, useFormatters } from "@/i18n/formatters";

/**
 * GDPR rights-request register (Art. 12(3)) — the institution admin's
 * worksheet for data-subject requests. One row per request; the one-month
 * deadline is computed by the schema (`due_at` is generated from
 * `received_at`), extension is the only lawful change to the clock, and
 * completing an erasure request scrubs the subject's name from the register
 * itself. The erasure procedure it implements is the operator's private
 * compliance record (`docs/compliance/README.md`); the enforcement lives in
 * migration 20260913090000.
 */

interface RightsRequest {
  id: string;
  institution_id: string;
  subject_user_id: string | null;
  subject_label: string | null;
  request_type: string;
  details: string | null;
  received_at: string;
  due_at: string;
  extended_due_at: string | null;
  extension_reason: string | null;
  status: string;
  resolution_note: string | null;
  closed_at: string | null;
  created_at: string;
}

interface MemberOption {
  user_id: string;
  full_name: string | null;
  email: string | null;
}

const REQUEST_TYPES = [
  { value: "access", label: "Access (Art. 15)" },
  { value: "export", label: "Portability / export (Art. 20)" },
  { value: "erasure", label: "Erasure (Art. 17)" },
  { value: "rectification", label: "Rectification (Art. 16)" },
  { value: "restriction", label: "Restriction (Art. 18)" },
  { value: "objection", label: "Objection (Art. 21)" },
] as const;

const TYPE_LABELS: Record<string, string> = Object.fromEntries(
  REQUEST_TYPES.map((t) => [t.value, t.label]),
);

/** Days from today to `date` (calendar days, local time). Parsed by parts:
 * `new Date("YYYY-MM-DD")` would read the Postgres date as midnight UTC and
 * show the prior day — "overdue" a day early — west of UTC. */
const daysUntil = (date: string) => {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const [y, m, d] = date.split("-").map(Number);
  const due = new Date(y, m - 1, d);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((due.getTime() - today.getTime()) / MS_PER_DAY);
};

const RightsRequests = () => {
  const navigate = useNavigate();
  const { user, loading } = useAuth();
  const { formatDate } = useFormatters();

  const effectiveInstitutionId = sessionStorage.getItem("selectedInstitutionId");

  const [requests, setRequests] = useState<RightsRequest[]>([]);
  const [members, setMembers] = useState<MemberOption[]>([]);
  const [loadingData, setLoadingData] = useState(true);

  // Create dialog
  const [createOpen, setCreateOpen] = useState(false);
  const [newType, setNewType] = useState("access");
  const [newSubjectUserId, setNewSubjectUserId] = useState<string>("none");
  const [newLabel, setNewLabel] = useState("");
  const [newReceivedAt, setNewReceivedAt] = useState(
    new Date().toISOString().slice(0, 10),
  );
  const [newDetails, setNewDetails] = useState("");
  const [isCreating, setIsCreating] = useState(false);

  // Close dialog (complete / refuse)
  const [closeTarget, setCloseTarget] = useState<RightsRequest | null>(null);
  const [closeStatus, setCloseStatus] = useState<"completed" | "refused">("completed");
  const [closeNote, setCloseNote] = useState("");
  const [isClosing, setIsClosing] = useState(false);

  // Extend dialog
  const [extendTarget, setExtendTarget] = useState<RightsRequest | null>(null);
  const [extendDate, setExtendDate] = useState("");
  const [extendReason, setExtendReason] = useState("");
  const [isExtending, setIsExtending] = useState(false);

  useEffect(() => {
    const checkAccess = async () => {
      if (!user) return;
      if (!effectiveInstitutionId) {
        navigate("/select-institution");
        return;
      }
      const [{ data: isAdmin }, { data: isSuper }] = await Promise.all([
        supabase.rpc("is_institution_admin", {
          _user_id: user.id,
          _institution_id: effectiveInstitutionId,
        }),
        supabase.rpc("is_super_admin", { _user_id: user.id }),
      ]);
      if (!isAdmin && !isSuper) {
        toast.error("Access denied. Admins only.");
        navigate("/dashboard");
      }
    };

    if (!loading && !user) {
      navigate("/auth");
    } else if (user) {
      checkAccess();
    }
  }, [user, loading, navigate, effectiveInstitutionId]);

  const fetchData = useCallback(async () => {
    if (!effectiveInstitutionId) return;
    setLoadingData(true);
    try {
      const { data: reqData, error } = await supabase
        .from("rights_requests")
        .select("*")
        .eq("institution_id", effectiveInstitutionId)
        .order("received_at", { ascending: false });
      if (error) throw error;
      setRequests(reqData ?? []);

      // Members for the optional account link. Split queries on purpose:
      // class_enrollments/user_institutions carry no FK to profiles, so a
      // PostgREST embed cannot join them.
      const { data: memberships } = await supabase
        .from("user_institutions")
        .select("user_id")
        .eq("institution_id", effectiveInstitutionId);
      const userIds = [...new Set((memberships ?? []).map((m) => m.user_id))];
      if (userIds.length > 0) {
        const { data: profiles } = await supabase
          .from("profiles")
          .select("user_id, full_name, email")
          .in("user_id", userIds);
        setMembers(
          (profiles ?? []).sort((a, b) =>
            compareText(a.full_name ?? a.email ?? "", b.full_name ?? b.email ?? ""),
          ),
        );
      } else {
        setMembers([]);
      }
    } catch (error: unknown) {
      console.error("Error loading rights requests:", error);
      toast.error("Failed to load rights requests");
    } finally {
      setLoadingData(false);
    }
  }, [effectiveInstitutionId]);

  useEffect(() => {
    if (user && effectiveInstitutionId) fetchData();
  }, [user, effectiveInstitutionId, fetchData]);

  const memberName = useCallback(
    (userId: string | null) => {
      if (!userId) return null;
      const m = members.find((x) => x.user_id === userId);
      return m ? (m.full_name || m.email) : null;
    },
    [members],
  );

  /** Open first (soonest effective deadline first), then closed, newest first. */
  const sorted = useMemo(() => {
    const effectiveDue = (r: RightsRequest) => r.extended_due_at ?? r.due_at;
    return [...requests].sort((a, b) => {
      if ((a.status === "open") !== (b.status === "open")) {
        return a.status === "open" ? -1 : 1;
      }
      if (a.status === "open") {
        return compareCode(effectiveDue(a), effectiveDue(b));
      }
      return compareCode(b.closed_at ?? b.created_at, a.closed_at ?? a.created_at);
    });
  }, [requests]);

  const openOverdue = useMemo(
    () =>
      requests.filter(
        (r) => r.status === "open" && daysUntil(r.extended_due_at ?? r.due_at) < 0,
      ).length,
    [requests],
  );

  const handleCreate = async () => {
    if (!effectiveInstitutionId || !user) return;
    const label = newLabel.trim();
    if (!label && newSubjectUserId === "none") {
      toast.error("Name the subject: pick an account or enter a label.");
      return;
    }
    setIsCreating(true);
    try {
      const { error } = await supabase.from("rights_requests").insert({
        institution_id: effectiveInstitutionId,
        subject_user_id: newSubjectUserId === "none" ? null : newSubjectUserId,
        subject_label: label || null,
        request_type: newType,
        received_at: newReceivedAt,
        details: newDetails.trim() || null,
        created_by: user.id,
      });
      if (error) throw error;
      toast.success("Request recorded — the one-month clock runs from receipt.");
      setCreateOpen(false);
      setNewLabel("");
      setNewDetails("");
      setNewSubjectUserId("none");
      setNewType("access");
      setNewReceivedAt(new Date().toISOString().slice(0, 10));
      fetchData();
    } catch (error: unknown) {
      console.error("Error recording request:", error);
      toast.error(error instanceof Error ? error.message : "Failed to record the request");
    } finally {
      setIsCreating(false);
    }
  };

  const handleClose = async () => {
    if (!closeTarget) return;
    const note = closeNote.trim();
    if (!note) {
      toast.error(
        closeStatus === "refused"
          ? "State the reasons for refusal — Art. 12(4) requires them."
          : "State what was done to fulfil the request.",
      );
      return;
    }
    setIsClosing(true);
    try {
      const { error } = await supabase
        .from("rights_requests")
        .update({ status: closeStatus, resolution_note: note })
        .eq("id", closeTarget.id);
      if (error) throw error;
      toast.success(closeStatus === "completed" ? "Request completed" : "Refusal recorded");
      setCloseTarget(null);
      setCloseNote("");
      fetchData();
    } catch (error: unknown) {
      console.error("Error closing request:", error);
      toast.error(error instanceof Error ? error.message : "Failed to update the request");
    } finally {
      setIsClosing(false);
    }
  };

  const handleExtend = async () => {
    if (!extendTarget) return;
    if (!extendDate || !extendReason.trim()) {
      toast.error("An extension needs a new date and its reasons (Art. 12(3)).");
      return;
    }
    setIsExtending(true);
    try {
      const { error } = await supabase
        .from("rights_requests")
        .update({ extended_due_at: extendDate, extension_reason: extendReason.trim() })
        .eq("id", extendTarget.id);
      if (error) throw error;
      toast.success("Deadline extended — inform the subject of the extension and its reasons.");
      setExtendTarget(null);
      setExtendDate("");
      setExtendReason("");
      fetchData();
    } catch (error: unknown) {
      console.error("Error extending request:", error);
      // The schema refuses extensions beyond three months from receipt.
      toast.error(
        error instanceof Error && error.message.includes("art12")
          ? "Beyond the legal maximum: at most three months from receipt, with reasons."
          : error instanceof Error
            ? error.message
            : "Failed to extend the deadline",
      );
    } finally {
      setIsExtending(false);
    }
  };

  const handleReopen = async (request: RightsRequest) => {
    try {
      const { error } = await supabase
        .from("rights_requests")
        .update({ status: "open" })
        .eq("id", request.id);
      if (error) throw error;
      toast.success("Request reopened");
      fetchData();
    } catch (error: unknown) {
      console.error("Error reopening request:", error);
      toast.error(error instanceof Error ? error.message : "Failed to reopen the request");
    }
  };

  const deadlineBadge = (r: RightsRequest) => {
    if (r.status !== "open") {
      return (
        <Badge variant={r.status === "completed" ? "secondary" : "outline"}>
          {r.status === "completed" ? "Completed" : "Refused"}
        </Badge>
      );
    }
    const days = daysUntil(r.extended_due_at ?? r.due_at);
    if (days < 0) {
      return <Badge variant="destructive">Overdue by {-days}d</Badge>;
    }
    if (days <= 7) {
      return (
        <Badge className="bg-yellow-500/15 text-yellow-700 hover:bg-yellow-500/15">
          Due in {days}d
        </Badge>
      );
    }
    return <Badge variant="outline">Due in {days}d</Badge>;
  };

  const subjectCell = (r: RightsRequest) => {
    const linked = memberName(r.subject_user_id);
    if (linked) return linked;
    if (r.subject_user_id) return <span className="text-muted-foreground">erased account</span>;
    if (r.subject_label) return r.subject_label;
    // An erasure request whose label was scrubbed on completion.
    return <span className="text-muted-foreground">erased subject</span>;
  };

  return (
    <div className="min-h-screen bg-background">
      <nav className="border-b border-border bg-card sticky top-0 z-50">
        <div className="container mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="icon" onClick={() => navigate("/users")}>
              <ArrowLeft className="w-5 h-5" />
            </Button>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-primary flex items-center justify-center">
                <Scale className="w-6 h-6 text-primary-foreground" />
              </div>
              <div>
                <span className="text-xl font-display font-bold text-foreground">
                  Rights Requests
                </span>
                <p className="text-xs text-muted-foreground">
                  GDPR data-subject requests — one month from receipt (Art. 12(3))
                </p>
              </div>
            </div>
          </div>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="w-4 h-4 mr-2" />
            Record request
          </Button>
        </div>
      </nav>

      <main className="container mx-auto px-6 py-8">
        {openOverdue > 0 && (
          <Card className="mb-6 border-destructive">
            <CardContent className="pt-6 flex items-center gap-3">
              <CalendarClock className="w-5 h-5 text-destructive" />
              <p className="text-sm">
                <strong>{openOverdue}</strong> open request{openOverdue > 1 ? "s are" : " is"}{" "}
                past the statutory deadline.
              </p>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardContent className="pt-6">
            {loadingData ? (
              <div className="flex justify-center py-12">
                <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
              </div>
            ) : sorted.length === 0 ? (
              <p className="text-center text-sm text-muted-foreground py-12">
                No rights requests recorded. When a parent or student asks for access,
                export, correction or erasure of personal data, record it here — the
                one-month clock starts at receipt, not at recording.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Subject</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Received</TableHead>
                    <TableHead>Deadline</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sorted.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell>
                        <div>{subjectCell(r)}</div>
                        {r.details && (
                          <p className="text-xs text-muted-foreground line-clamp-2 max-w-md">
                            {r.details}
                          </p>
                        )}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        {TYPE_LABELS[r.request_type] ?? r.request_type}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        {formatDate(r.received_at)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        {formatDate(r.extended_due_at ?? r.due_at)}
                        {r.extended_due_at && (
                          <p className="text-xs text-muted-foreground" title={r.extension_reason ?? undefined}>
                            extended
                          </p>
                        )}
                      </TableCell>
                      <TableCell>{deadlineBadge(r)}</TableCell>
                      <TableCell className="text-right space-x-2 whitespace-nowrap">
                        {r.status === "open" ? (
                          <>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => {
                                setExtendTarget(r);
                                setExtendDate("");
                                setExtendReason("");
                              }}
                            >
                              Extend
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => {
                                setCloseTarget(r);
                                setCloseStatus("refused");
                                setCloseNote("");
                              }}
                            >
                              Refuse
                            </Button>
                            <Button
                              size="sm"
                              onClick={() => {
                                setCloseTarget(r);
                                setCloseStatus("completed");
                                setCloseNote("");
                              }}
                            >
                              Complete
                            </Button>
                          </>
                        ) : (
                          <Button variant="ghost" size="sm" onClick={() => handleReopen(r)}>
                            Reopen
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </main>

      {/* Record request */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Record a rights request</DialogTitle>
            <DialogDescription>
              The response deadline is one month from the date received — it is computed
              automatically and can only be changed by a documented extension.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Request type</Label>
              <Select value={newType} onValueChange={setNewType}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {REQUEST_TYPES.map((t) => (
                    <SelectItem key={t.value} value={t.value}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Linked account (optional)</Label>
              <Select value={newSubjectUserId} onValueChange={setNewSubjectUserId}>
                <SelectTrigger>
                  <SelectValue placeholder="No account link" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No account link</SelectItem>
                  {members.map((m) => (
                    <SelectItem key={m.user_id} value={m.user_id}>
                      {m.full_name || m.email || m.user_id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Subject, as received</Label>
              <Input
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                placeholder='e.g. "Parent of Γ. Παπαδόπουλος, B2"'
                maxLength={200}
              />
            </div>
            <div className="space-y-2">
              <Label>Date received</Label>
              <Input
                type="date"
                value={newReceivedAt}
                max={new Date().toISOString().slice(0, 10)}
                onChange={(e) => setNewReceivedAt(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>Details (optional)</Label>
              <Textarea
                value={newDetails}
                onChange={(e) => setNewDetails(e.target.value)}
                placeholder="What exactly was requested, and through which channel."
                maxLength={2000}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={isCreating}>
                Cancel
              </Button>
              <Button onClick={handleCreate} disabled={isCreating}>
                {isCreating ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                Record
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Complete / refuse */}
      <Dialog open={!!closeTarget} onOpenChange={(open) => !open && setCloseTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {closeStatus === "completed" ? "Complete request" : "Refuse request"}
            </DialogTitle>
            <DialogDescription>
              {closeStatus === "completed"
                ? closeTarget?.request_type === "erasure"
                  ? "Confirm only after the erasure ran AND the typed-name review list came back clean — the subject's name is removed from this register on completion."
                  : "State what was done; the note is the register's evidence."
                : "State the reasons and the subject's right to complain to the supervisory authority (Art. 12(4))."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Resolution note</Label>
              <Textarea
                value={closeNote}
                onChange={(e) => setCloseNote(e.target.value)}
                maxLength={2000}
                placeholder={
                  closeStatus === "completed"
                    ? "e.g. Export generated and handed to the school on …"
                    : "e.g. Refused because …; the requester was informed of …"
                }
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setCloseTarget(null)} disabled={isClosing}>
                Cancel
              </Button>
              <Button
                onClick={handleClose}
                disabled={isClosing}
                variant={closeStatus === "refused" ? "destructive" : "default"}
              >
                {isClosing ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                {closeStatus === "completed" ? "Mark completed" : "Record refusal"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Extend */}
      <Dialog open={!!extendTarget} onOpenChange={(open) => !open && setExtendTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Extend the deadline</DialogTitle>
            <DialogDescription>
              Art. 12(3) allows up to two further months for complex or numerous requests.
              The subject must be informed of the extension and its reasons within the
              first month.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>New deadline</Label>
              <Input type="date" value={extendDate} onChange={(e) => setExtendDate(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Reasons</Label>
              <Textarea
                value={extendReason}
                onChange={(e) => setExtendReason(e.target.value)}
                maxLength={1000}
                placeholder="Why one month is not enough for this request."
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setExtendTarget(null)} disabled={isExtending}>
                Cancel
              </Button>
              <Button onClick={handleExtend} disabled={isExtending}>
                {isExtending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                Extend
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default RightsRequests;
