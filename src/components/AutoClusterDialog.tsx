import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { ScrollableDialogBody } from "@/components/ui/scrollable-dialog-body";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, Sparkles, Users } from "lucide-react";
import type { CourseClass } from "@/types/content-assignments";
import { buildClassDisplayName } from "@/lib/greek-school";

interface AutoClusterDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  classes: CourseClass[];
  onPersisted: () => void;
}

interface ProposedMember {
  user_id: string;
  full_name: string | null;
}

interface ProposedGroup {
  name: string;
  rationale: string;
  description: string;
  members: ProposedMember[];
}

interface ClusterResponse {
  groups: ProposedGroup[];
  unassigned: ProposedMember[];
  stats: { roster_size: number; with_data?: number; without_data?: number };
  warning?: string;
}

// "u-" prefixed reserved id for the Unassigned pseudo-group selector value
const UNASSIGNED_KEY = "__unassigned__";

const MAX_GROUP_OPTIONS = [2, 3, 4, 5, 6];
const DEFAULT_MAX_GROUPS = 5;

export function AutoClusterDialog({
  open,
  onOpenChange,
  classes,
  onPersisted,
}: AutoClusterDialogProps) {
  const [selectedClassId, setSelectedClassId] = useState<string | null>(null);
  const [maxGroups, setMaxGroups] = useState<number>(DEFAULT_MAX_GROUPS);
  const [avoidExisting, setAvoidExisting] = useState(true);
  const [specialInstructions, setSpecialInstructions] = useState("");
  const [loading, setLoading] = useState(false);
  const [proposal, setProposal] = useState<ClusterResponse | null>(null);
  const [groupNames, setGroupNames] = useState<string[]>([]);
  // Map of user_id -> group index (or UNASSIGNED_KEY)
  const [assignment, setAssignment] = useState<Record<string, string>>({});
  const [persisting, setPersisting] = useState(false);
  // Incremented on each reset/close to discard responses from in-flight requests
  const requestGenRef = useRef(0);

  useEffect(() => {
    if (!open) return;
    if (selectedClassId === null && classes.length > 0) {
      setSelectedClassId(classes[0].id);
    }
  }, [open, classes, selectedClassId]);

  const reset = () => {
    requestGenRef.current++; // invalidate any in-flight clustering request
    setProposal(null);
    setGroupNames([]);
    setAssignment({});
    setLoading(false);
    setPersisting(false);
  };

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      if (persisting) return;
      reset(); // increments requestGenRef, discarding any in-flight clustering response
      setSelectedClassId(null);
      setMaxGroups(DEFAULT_MAX_GROUPS);
      setAvoidExisting(true);
      setSpecialInstructions("");
    }
    onOpenChange(next);
  };

  const selectedClass = useMemo(
    () => classes.find((c) => c.id === selectedClassId) ?? null,
    [classes, selectedClassId],
  );

  const runClustering = async () => {
    if (!selectedClass) {
      toast.error("Pick a class first");
      return;
    }
    const gen = ++requestGenRef.current;
    setLoading(true);
    setProposal(null);
    try {
      const { data, error } = await supabase.functions.invoke<ClusterResponse>(
        "cluster-students-by-performance",
        {
          body: {
            offering_id: selectedClass.offering_id,
            class_id: selectedClass.id,
            max_group_count: maxGroups,
            // Legacy alias so an older deployed function still honors the count.
            target_group_count: maxGroups,
            avoid_existing_groups: avoidExisting,
            special_instructions: specialInstructions.trim() || undefined,
          },
        },
      );
      if (gen !== requestGenRef.current) return; // dialog was closed/reset — discard stale response
      if (error) throw error;
      const resp = data as ClusterResponse;
      if (!resp) throw new Error("Empty response from clustering function");

      // No proposal possible (empty roster, target_count > roster, etc.):
      // surface the warning inline and keep the picker visible so the user can adjust.
      if (resp.groups.length === 0) {
        if (resp.warning) toast.warning(resp.warning);
        else toast.warning("No groups could be proposed for this class.");
        return;
      }

      if (resp.warning) toast.warning(resp.warning);

      setProposal(resp);
      setGroupNames(resp.groups.map((g) => g.name));
      const nextAssignment: Record<string, string> = {};
      resp.groups.forEach((g, idx) => {
        for (const m of g.members) nextAssignment[m.user_id] = String(idx);
      });
      for (const m of resp.unassigned) nextAssignment[m.user_id] = UNASSIGNED_KEY;
      setAssignment(nextAssignment);
    } catch (error: any) {
      if (gen !== requestGenRef.current) return;
      console.error("Auto-cluster failed:", error);
      // FunctionsHttpError stashes the raw Response on .context; pull the real message out
      // so we don't show the generic "Edge Function returned a non-2xx status code".
      let message = error?.message || "Failed to generate clusters";
      const ctx = error?.context;
      if (ctx && typeof ctx.json === "function") {
        try {
          const body = await ctx.json();
          if (body?.error) message = body.error;
          else if (body?.warning) message = body.warning;
        } catch {
          /* body wasn't JSON — keep the default message */
        }
      }
      toast.error(message);
    } finally {
      if (gen === requestGenRef.current) setLoading(false);
    }
  };

  const renameGroup = (idx: number, value: string) => {
    setGroupNames((prev) => {
      const next = [...prev];
      next[idx] = value;
      return next;
    });
  };

  const moveStudent = (userId: string, nextGroupKey: string) => {
    setAssignment((prev) => ({ ...prev, [userId]: nextGroupKey }));
  };

  // Members grouped by the live (post-edit) assignment
  const liveGroups = useMemo(() => {
    if (!proposal) return [] as ProposedMember[][];
    const buckets: ProposedMember[][] = proposal.groups.map(() => []);
    for (const g of proposal.groups) {
      for (const m of g.members) {
        const key = assignment[m.user_id];
        const idx = key === UNASSIGNED_KEY ? -1 : Number(key);
        if (idx >= 0 && idx < buckets.length) buckets[idx].push(m);
      }
    }
    for (const m of proposal.unassigned) {
      const key = assignment[m.user_id];
      const idx = key === UNASSIGNED_KEY ? -1 : Number(key);
      if (idx >= 0 && idx < buckets.length) buckets[idx].push(m);
    }
    return buckets;
  }, [proposal, assignment]);

  const liveUnassigned = useMemo(() => {
    if (!proposal) return [] as ProposedMember[];
    const all = [...proposal.groups.flatMap((g) => g.members), ...proposal.unassigned];
    return all.filter((m) => assignment[m.user_id] === UNASSIGNED_KEY);
  }, [proposal, assignment]);

  const allMembersById = useMemo(() => {
    const map = new Map<string, ProposedMember>();
    if (proposal) {
      for (const g of proposal.groups) for (const m of g.members) map.set(m.user_id, m);
      for (const m of proposal.unassigned) map.set(m.user_id, m);
    }
    return map;
  }, [proposal]);

  const handlePersist = async () => {
    if (!selectedClass || !proposal) return;
    const trimmedNames = groupNames.map((n) => n.trim());
    if (trimmedNames.some((n) => n.length === 0)) {
      toast.error("Every group needs a name");
      return;
    }
    if (new Set(trimmedNames).size !== trimmedNames.length) {
      toast.error("Group names must be unique");
      return;
    }
    const nonEmptyIndices = liveGroups
      .map((members, idx) => (members.length > 0 ? idx : -1))
      .filter((idx) => idx >= 0);
    if (nonEmptyIndices.length === 0) {
      toast.error("At least one group must have members");
      return;
    }

    setPersisting(true);
    const createdGroupIds: string[] = [];
    try {
      for (const idx of nonEmptyIndices) {
        const name = trimmedNames[idx];
        const description = proposal.groups[idx]?.description?.trim() || null;
        const { data: created, error: createErr } = await supabase
          .from("offering_groups" as any)
          .insert({
            offering_id: selectedClass.offering_id,
            name,
            description,
          })
          .select("id")
          .single();
        if (createErr) throw createErr;
        const groupId = (created as any).id as string;
        createdGroupIds.push(groupId);

        const members = liveGroups[idx];
        if (members.length > 0) {
          const { error: memberErr } = await supabase
            .from("offering_group_members" as any)
            .insert(members.map((m) => ({ group_id: groupId, user_id: m.user_id })));
          if (memberErr) throw memberErr;
        }
      }

      toast.success(`Created ${nonEmptyIndices.length} group${nonEmptyIndices.length === 1 ? "" : "s"}`);
      onPersisted();
      reset();
      setSelectedClassId(null);
      setMaxGroups(DEFAULT_MAX_GROUPS);
      setAvoidExisting(true);
      setSpecialInstructions("");
      onOpenChange(false);
    } catch (error: any) {
      console.error("Failed to persist groups:", error);
      // Best-effort rollback: remove any groups (and their members) already committed
      if (createdGroupIds.length > 0) {
        await supabase.from("offering_group_members" as any).delete().in("group_id", createdGroupIds);
        await supabase.from("offering_groups" as any).delete().in("id", createdGroupIds);
      }
      // 23505 = unique violation on (offering_id, name): a group with that
      // name already exists in this class.
      if (error?.code === "23505") {
        toast.error("A group with one of these names already exists in this class — rename it and try again.");
      } else {
        toast.error(error?.message || "Failed to create groups");
      }
    } finally {
      setPersisting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="w-4 h-4" />
            Auto-cluster students by performance
          </DialogTitle>
          <DialogDescription>
            Pick a class and a maximum group count, then review the AI proposal before creating groups.
          </DialogDescription>
        </DialogHeader>

        {!proposal ? (
          <div className="space-y-4 py-2">
            <div className="space-y-1">
              <Label>Class</Label>
              <Select
                value={selectedClassId ?? undefined}
                onValueChange={(v) => setSelectedClassId(v)}
                disabled={loading}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Pick a class" />
                </SelectTrigger>
                <SelectContent>
                  {classes.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {buildClassDisplayName(c)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <Label>Maximum number of groups</Label>
              <Select
                value={String(maxGroups)}
                onValueChange={(v) => setMaxGroups(Number(v))}
                disabled={loading}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MAX_GROUP_OPTIONS.map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      Up to {n} groups
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                The AI may propose fewer groups when the data supports fewer meaningful clusters.
              </p>
            </div>

            <div className="flex items-start gap-2">
              <Checkbox
                id="avoid-existing-groups"
                checked={avoidExisting}
                onCheckedChange={(v) => setAvoidExisting(v === true)}
                disabled={loading}
                className="mt-0.5"
              />
              <div className="space-y-0.5">
                <Label htmlFor="avoid-existing-groups" className="cursor-pointer">
                  Avoid duplicating existing groups
                </Label>
                <p className="text-xs text-muted-foreground">
                  The AI is shown this class's existing group names and descriptions and asked to
                  propose only new, distinct groups. Uncheck to cluster from scratch, ignoring
                  existing groups.
                </p>
              </div>
            </div>

            <div className="space-y-1">
              <Label htmlFor="cluster-instructions">Special instructions (optional)</Label>
              <Textarea
                id="cluster-instructions"
                value={specialInstructions}
                onChange={(e) => setSpecialInstructions(e.target.value)}
                rows={3}
                maxLength={2000}
                placeholder="e.g. Focus the grouping on essay-writing skills, or keep advanced students together."
                className="resize-none"
                disabled={loading}
              />
              <p className="text-xs text-muted-foreground">
                Passed to the AI alongside performance data to steer how groups are formed.
                Don't reference individual students by name — student names are never sent
                to the AI, and any roster names in this text are redacted first.
              </p>
            </div>

            <p className="text-xs text-muted-foreground">
              We aggregate each student's quiz performance and latest competency mastery, then ask the
              AI to suggest skill-based groupings. Nothing is saved until you click <strong>Create groups</strong>.
            </p>
          </div>
        ) : (
          <ScrollableDialogBody className="-mx-6 px-6">
            <div className="space-y-4 py-2">
              {proposal.groups.map((g, idx) => {
                const members = liveGroups[idx] ?? [];
                return (
                  <div key={idx} className="rounded-lg border p-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <Input
                        value={groupNames[idx] ?? ""}
                        onChange={(e) => renameGroup(idx, e.target.value)}
                        className="font-medium"
                        disabled={persisting}
                      />
                      <Badge variant="secondary">
                        {members.length} {members.length === 1 ? "member" : "members"}
                      </Badge>
                    </div>
                    {g.rationale && (
                      <p className="text-xs text-muted-foreground italic">{g.rationale}</p>
                    )}
                    <div className="space-y-1">
                      {members.length === 0 ? (
                        <p className="text-xs text-muted-foreground py-2 px-1">
                          No members. Reassign students from another group.
                        </p>
                      ) : (
                        members.map((m) => (
                          <MemberRow
                            key={m.user_id}
                            member={m}
                            currentKey={String(idx)}
                            groupNames={groupNames}
                            disabled={persisting}
                            onChange={(v) => moveStudent(m.user_id, v)}
                          />
                        ))
                      )}
                    </div>
                  </div>
                );
              })}

              <div className="rounded-lg border border-dashed p-3 space-y-2 bg-muted/30">
                <div className="flex items-center gap-2">
                  <Users className="w-4 h-4 text-muted-foreground" />
                  <span className="font-medium text-sm">Unassigned</span>
                  <Badge variant="outline">{liveUnassigned.length}</Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  Students with insufficient performance data, or any you choose not to include. They
                  will not be added to any group on confirm — you can slot them later from the panel.
                </p>
                <div className="space-y-1">
                  {liveUnassigned.length === 0 ? (
                    <p className="text-xs text-muted-foreground py-2 px-1">No unassigned students.</p>
                  ) : (
                    liveUnassigned.map((m) => {
                      const member = allMembersById.get(m.user_id) ?? m;
                      return (
                        <MemberRow
                          key={m.user_id}
                          member={member}
                          currentKey={UNASSIGNED_KEY}
                          groupNames={groupNames}
                          disabled={persisting}
                          onChange={(v) => moveStudent(m.user_id, v)}
                        />
                      );
                    })
                  )}
                </div>
              </div>
            </div>
          </ScrollableDialogBody>
        )}

        <DialogFooter className="gap-2 sm:gap-2">
          {proposal ? (
            <>
              <Button
                variant="outline"
                onClick={reset}
                disabled={persisting}
              >
                Discard proposal
              </Button>
              <Button onClick={handlePersist} disabled={persisting}>
                {persisting && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                Create groups
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="outline"
                onClick={() => handleOpenChange(false)}
                disabled={loading}
              >
                Cancel
              </Button>
              <Button onClick={runClustering} disabled={loading || !selectedClassId}>
                {loading && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                <Sparkles className="w-4 h-4 mr-2" />
                Generate proposal
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface MemberRowProps {
  member: ProposedMember;
  currentKey: string;
  groupNames: string[];
  disabled: boolean;
  onChange: (next: string) => void;
}

function MemberRow({ member, currentKey, groupNames, disabled, onChange }: MemberRowProps) {
  return (
    <div className="flex items-center gap-2 rounded-md bg-background px-2 py-1.5 border">
      <div className="min-w-0 flex-1">
        <p className="text-sm truncate">{member.full_name || "Unnamed"}</p>
      </div>
      <Select value={currentKey} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger className="h-7 w-[180px] text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {groupNames.map((name, i) => (
            <SelectItem key={i} value={String(i)} className="text-xs">
              {name.trim() || `Group ${i + 1}`}
            </SelectItem>
          ))}
          <SelectItem value={UNASSIGNED_KEY} className="text-xs">
            Unassigned
          </SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
