import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { ChevronDown, ChevronRight, Loader2, Plus, Trash2, Users, Edit2, Sparkles, StickyNote } from "lucide-react";
import type { CourseClass, OfferingGroup } from "@/types/content-assignments";
import { buildClassDisplayName } from "@/lib/greek-school";
import { AutoClusterDialog } from "@/components/AutoClusterDialog";
import { StudentNotesDialog } from "@/components/StudentNotesDialog";
import { UnifiedGenerateDialog } from "@/components/UnifiedGenerateDialog";
import type { AudienceSelection } from "@/components/TargetAudienceSelector";
import { useFormatters } from "@/i18n/formatters";

interface OfferingGroupsPanelProps {
  courseId: string;
  classes: CourseClass[];
}

interface Student {
  user_id: string;
  full_name: string | null;
  email: string | null;
  hasNotes: boolean;
}

interface GroupRow extends OfferingGroup {
  member_count: number;
}

export function OfferingGroupsPanel({ courseId, classes }: OfferingGroupsPanelProps) {
  const { compareText } = useFormatters();
  const offeringIds = useMemo(() => classes.map(c => c.offering_id), [classes]);
  const [groupsByOffering, setGroupsByOffering] = useState<Record<string, GroupRow[]>>({});
  const [loading, setLoading] = useState(false);
  // Sections are open by default; the set tracks the ones the user folded, so
  // classes that arrive later still start open.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  // Create dialog state
  const [createOpen, setCreateOpen] = useState(false);
  const [createClassId, setCreateClassId] = useState<string | null>(null);
  const [createName, setCreateName] = useState("");
  const [createDescription, setCreateDescription] = useState("");
  const [creating, setCreating] = useState(false);
  const createClass = useMemo(
    () => classes.find(c => c.id === createClassId) ?? null,
    [classes, createClassId],
  );

  // Rename dialog state
  const [renameTarget, setRenameTarget] = useState<GroupRow | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameDescription, setRenameDescription] = useState("");
  const [renaming, setRenaming] = useState(false);

  // Delete dialog state
  const [deleteTarget, setDeleteTarget] = useState<GroupRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Membership dialog state
  const [membersGroup, setMembersGroup] = useState<GroupRow | null>(null);
  const [membersClass, setMembersClass] = useState<CourseClass | null>(null);
  const [roster, setRoster] = useState<Student[]>([]);
  const [memberIds, setMemberIds] = useState<Set<string>>(new Set());
  const [membersLoading, setMembersLoading] = useState(false);
  const [savingMembers, setSavingMembers] = useState(false);

  // Auto-cluster dialog state
  const [autoClusterOpen, setAutoClusterOpen] = useState(false);

  // Per-group "Generate questions" dialog state
  const [generateAudience, setGenerateAudience] = useState<AudienceSelection | null>(null);

  // Student notes (read-only) state
  const [notesStudent, setNotesStudent] = useState<{ user_id: string; full_name: string | null } | null>(null);
  const [notesInstitutionId, setNotesInstitutionId] = useState<string | null>(null);

  const fetchGroups = async () => {
    if (offeringIds.length === 0) {
      setGroupsByOffering({});
      return;
    }
    setLoading(true);
    try {
      const { data: groupRows, error } = await supabase
        .from("offering_groups" as any)
        .select("id, offering_id, name, description, is_individual")
        .in("offering_id", offeringIds);
      if (error) throw error;

      // Hide singleton individual groups — they back per-student targeting,
      // not manual/auto-cluster grouping.
      const groups: OfferingGroup[] = ((groupRows as any[]) || [])
        .filter(g => !g.is_individual)
        .map(g => ({
          id: g.id,
          offering_id: g.offering_id,
          name: g.name,
          description: g.description ?? null,
        }));

      const groupIds = groups.map(g => g.id);
      const countByGroup = new Map<string, number>();
      if (groupIds.length > 0) {
        const { data: members, error: mErr } = await supabase
          .from("offering_group_members" as any)
          .select("group_id")
          .in("group_id", groupIds);
        if (mErr) throw mErr;
        for (const row of (members as any[]) || []) {
          countByGroup.set(row.group_id, (countByGroup.get(row.group_id) ?? 0) + 1);
        }
      }

      const map: Record<string, GroupRow[]> = {};
      for (const g of groups) {
        if (!map[g.offering_id]) map[g.offering_id] = [];
        map[g.offering_id].push({ ...g, member_count: countByGroup.get(g.id) ?? 0 });
      }
      for (const oid of Object.keys(map)) {
        map[oid].sort((a, b) => compareText(a.name, b.name));
      }
      setGroupsByOffering(map);
    } catch (error: any) {
      console.error("Error loading offering groups:", error);
      toast.error(error.message || "Failed to load groups");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchGroups();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offeringIds.join(",")]);

  const toggleExpanded = (classId: string) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(classId)) next.delete(classId);
      else next.add(classId);
      return next;
    });
  };

  const handleCreate = async () => {
    if (!createClass) return;
    const name = createName.trim();
    if (!name) {
      toast.error("Group name is required");
      return;
    }
    setCreating(true);
    try {
      const { error } = await supabase
        .from("offering_groups" as any)
        .insert({
          offering_id: createClass.offering_id,
          name,
          description: createDescription.trim() || null,
        });
      if (error) throw error;
      toast.success("Group created");
      setCreateOpen(false);
      setCreateName("");
      setCreateDescription("");
      await fetchGroups();
    } catch (error: any) {
      console.error("Error creating group:", error);
      toast.error(error.message || "Failed to create group");
    } finally {
      setCreating(false);
    }
  };

  const handleRename = async () => {
    if (!renameTarget) return;
    const newName = renameValue.trim();
    if (!newName) {
      toast.error("Group name is required");
      return;
    }
    const newDescription = renameDescription.trim();
    setRenaming(true);
    try {
      const { error } = await supabase
        .from("offering_groups" as any)
        .update({ name: newName, description: newDescription || null })
        .eq("id", renameTarget.id);
      if (error) throw error;
      toast.success("Group updated");
      setRenameTarget(null);
      await fetchGroups();
    } catch (error: any) {
      console.error("Error updating group:", error);
      toast.error(error.message || "Failed to update group");
    } finally {
      setRenaming(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const { error } = await supabase
        .from("offering_groups" as any)
        .delete()
        .eq("id", deleteTarget.id);
      if (error) throw error;
      toast.success("Group deleted");
      setDeleteTarget(null);
      await fetchGroups();
    } catch (error: any) {
      console.error("Error deleting group:", error);
      toast.error(error.message || "Failed to delete group");
    } finally {
      setDeleting(false);
    }
  };

  const openMembers = async (cls: CourseClass, group: GroupRow) => {
    setMembersClass(cls);
    setMembersGroup(group);
    setMembersLoading(true);
    try {
      const [
        { data: enrollments, error: eErr },
        { data: members, error: mErr },
        { data: classRow, error: cErr },
      ] = await Promise.all([
        supabase
          .from("class_enrollments")
          .select("user_id, role")
          .eq("class_id", cls.id)
          .eq("role", "student"),
        supabase
          .from("offering_group_members" as any)
          .select("user_id")
          .eq("group_id", group.id),
        supabase
          .from("classes")
          .select("institution_id")
          .eq("id", cls.id)
          .maybeSingle(),
      ]);
      if (eErr) throw eErr;
      if (mErr) throw mErr;
      if (cErr) throw cErr;

      const classInstitutionId = (classRow as any)?.institution_id ?? null;
      setNotesInstitutionId(classInstitutionId);

      const enrolledUserIds = ((enrollments as any[]) || []).map(r => r.user_id);
      let profilesByUserId = new Map<string, { full_name: string | null; email: string | null }>();
      let studentsWithNotes = new Set<string>();
      if (enrolledUserIds.length > 0) {
        const [{ data: profileRows, error: pErr }, { data: noteRows, error: nErr }] = await Promise.all([
          supabase
            .from("profiles")
            .select("user_id, full_name, email")
            .in("user_id", enrolledUserIds),
          classInstitutionId
            ? supabase
                .from("student_admin_notes" as any)
                .select("student_user_id")
                .eq("institution_id", classInstitutionId)
                .in("student_user_id", enrolledUserIds)
            : Promise.resolve({ data: [] as any[], error: null }),
        ]);
        if (pErr) throw pErr;
        if (nErr) throw nErr;
        profilesByUserId = new Map(
          (profileRows || []).map(p => [p.user_id, { full_name: p.full_name, email: p.email }])
        );
        studentsWithNotes = new Set(
          ((noteRows as any[]) || []).map(r => r.student_user_id),
        );
      }

      const students: Student[] = enrolledUserIds.map(uid => {
        const p = profilesByUserId.get(uid);
        return {
          user_id: uid,
          full_name: p?.full_name ?? null,
          email: p?.email ?? null,
          hasNotes: studentsWithNotes.has(uid),
        };
      });
      students.sort((a, b) => compareText((a.full_name || a.email || ""), b.full_name || b.email || ""));
      setRoster(students);
      setMemberIds(new Set(((members as any[]) || []).map(m => m.user_id)));
    } catch (error: any) {
      console.error("Error loading roster:", error);
      toast.error(error.message || "Failed to load class roster");
      setMembersGroup(null);
      setMembersClass(null);
    } finally {
      setMembersLoading(false);
    }
  };

  const toggleMember = (userId: string) => {
    setMemberIds(prev => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  };

  const saveMembers = async () => {
    if (!membersGroup) return;
    setSavingMembers(true);
    try {
      const { data: existingRows, error: exErr } = await supabase
        .from("offering_group_members" as any)
        .select("user_id")
        .eq("group_id", membersGroup.id);
      if (exErr) throw exErr;
      const existing = new Set(((existingRows as any[]) || []).map(r => r.user_id));

      const toAdd = [...memberIds].filter(id => !existing.has(id));
      const toRemove = [...existing].filter(id => !memberIds.has(id));

      if (toAdd.length > 0) {
        const { error } = await supabase
          .from("offering_group_members" as any)
          .insert(toAdd.map(uid => ({ group_id: membersGroup.id, user_id: uid })));
        if (error) throw error;
      }
      if (toRemove.length > 0) {
        const { error } = await supabase
          .from("offering_group_members" as any)
          .delete()
          .eq("group_id", membersGroup.id)
          .in("user_id", toRemove);
        if (error) throw error;
      }

      toast.success("Members updated");
      setMembersGroup(null);
      setMembersClass(null);
      await fetchGroups();
    } catch (error: any) {
      console.error("Error saving members:", error);
      toast.error(error.message || "Failed to update members");
    } finally {
      setSavingMembers(false);
    }
  };

  if (classes.length === 0) return null;

  return (
    <>
      <div className="mb-3 flex justify-end gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setCreateClassId(classes[0]?.id ?? null);
            setCreateName("");
            setCreateDescription("");
            setCreateOpen(true);
          }}
          disabled={loading}
        >
          <Plus className="w-3.5 h-3.5 mr-1.5" />
          New group
        </Button>
        <Button
          size="sm"
          onClick={() => setAutoClusterOpen(true)}
          disabled={loading}
        >
          <Sparkles className="w-3.5 h-3.5 mr-1.5" />
          Auto-cluster students
        </Button>
      </div>
      <div className="space-y-2">
        {loading ? (
          <div className="flex items-center justify-center py-4">
            <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
          </div>
        ) : (
          classes.map(cls => {
            const groups = groupsByOffering[cls.offering_id] ?? [];
            const isOpen = !collapsed.has(cls.id);
            return (
              <Collapsible key={cls.id} open={isOpen} onOpenChange={() => toggleExpanded(cls.id)}>
                <div className="rounded-lg border bg-card">
                  <CollapsibleTrigger asChild>
                    <button
                      type="button"
                      className="flex w-full items-center justify-between gap-2 p-2 text-left hover:bg-muted/50 rounded-lg"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        {isOpen ? (
                          <ChevronDown className="w-4 h-4 shrink-0" />
                        ) : (
                          <ChevronRight className="w-4 h-4 shrink-0" />
                        )}
                        <span className="text-sm font-medium truncate">
                          {buildClassDisplayName(cls)}
                        </span>
                      </div>
                      <Badge variant="secondary" className="text-[10px]">
                        {groups.length} {groups.length === 1 ? "group" : "groups"}
                      </Badge>
                    </button>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="border-t px-2 py-2 space-y-1.5">
                      {groups.length === 0 ? (
                        <p className="text-xs text-muted-foreground py-1 px-1">
                          No groups yet — use "New group" or "Auto-cluster students" above.
                        </p>
                      ) : (
                        groups.map(g => (
                          <div
                            key={g.id}
                            className="flex items-center justify-between gap-2 rounded-md border bg-muted/30 px-2 py-1.5"
                          >
                            <div className="min-w-0">
                              <p className="text-xs font-medium break-words">{g.name}</p>
                              <p className="text-[10px] text-muted-foreground">
                                {g.member_count} {g.member_count === 1 ? "member" : "members"}
                              </p>
                              {g.description && (
                                <p className="text-[11px] text-muted-foreground mt-0.5">
                                  {g.description}
                                </p>
                              )}
                            </div>
                            <div className="flex items-center gap-1 shrink-0">
                              <Button
                                size="sm"
                                className="h-7 px-2 text-xs"
                                title="Generate questions targeted at this group"
                                onClick={() =>
                                  setGenerateAudience({
                                    kind: "group",
                                    groupId: g.id,
                                    offeringId: cls.offering_id,
                                    label: `${buildClassDisplayName(cls)} → ${g.name}`,
                                    description: g.description ?? null,
                                  })
                                }
                              >
                                <Sparkles className="w-3.5 h-3.5 mr-1" />
                                Generate questions
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 px-2"
                                title="Manage members"
                                onClick={() => openMembers(cls, g)}
                              >
                                <Users className="w-3.5 h-3.5" />
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 px-2"
                                title="Edit group"
                                onClick={() => {
                                  setRenameTarget(g);
                                  setRenameValue(g.name);
                                  setRenameDescription(g.description || "");
                                }}
                              >
                                <Edit2 className="w-3.5 h-3.5" />
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 px-2 text-destructive hover:text-destructive"
                                title="Delete"
                                onClick={() => setDeleteTarget(g)}
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </Button>
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </CollapsibleContent>
                </div>
              </Collapsible>
            );
          })
        )}
      </div>

      {/* Create dialog */}
      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          if (!open && !creating) setCreateOpen(false);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>New group</DialogTitle>
            <DialogDescription>
              {classes.length === 1 && createClass
                ? `In ${buildClassDisplayName(createClass)}`
                : "Pick the class the group belongs to."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {classes.length > 1 && (
              <div>
                <Label>Class</Label>
                <Select
                  value={createClassId ?? undefined}
                  onValueChange={(v) => setCreateClassId(v)}
                  disabled={creating}
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
            )}
            <div>
              <Label htmlFor="group-name">Name</Label>
              <Input
                id="group-name"
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                placeholder="e.g. Advanced Track"
              />
            </div>
            <div>
              <Label htmlFor="group-desc">Description (optional)</Label>
              <Textarea
                id="group-desc"
                value={createDescription}
                onChange={(e) => setCreateDescription(e.target.value)}
                rows={3}
                placeholder="e.g. Wednesday lab cohort"
                className="resize-none"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={creating}>
              Cancel
            </Button>
            <Button onClick={handleCreate} disabled={creating || !createClass}>
              {creating && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rename dialog */}
      <Dialog
        open={!!renameTarget}
        onOpenChange={(open) => {
          if (!open && !renaming) setRenameTarget(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Edit group</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label htmlFor="group-rename">Name</Label>
              <Input
                id="group-rename"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="group-rename-desc">Description (optional)</Label>
              <Textarea
                id="group-rename-desc"
                value={renameDescription}
                onChange={(e) => setRenameDescription(e.target.value)}
                rows={3}
                placeholder="Shared strengths, gaps, and a differentiation focus for this group."
                className="resize-none"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameTarget(null)} disabled={renaming}>
              Cancel
            </Button>
            <Button onClick={handleRename} disabled={renaming}>
              {renaming && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open && !deleting) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete group?</AlertDialogTitle>
            <AlertDialogDescription>
              Deleting <strong>{deleteTarget?.name}</strong> also removes all of its
              memberships and any content assignments scoped to this group.
              This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                handleDelete();
              }}
              disabled={deleting}
            >
              {deleting && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Membership dialog */}
      <Dialog
        open={!!membersGroup}
        onOpenChange={(open) => {
          if (!open && !savingMembers) {
            setMembersGroup(null);
            setMembersClass(null);
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Manage members</DialogTitle>
            <DialogDescription>
              {membersGroup ? `${membersGroup.name} — pick students from the class roster.` : ""}
            </DialogDescription>
          </DialogHeader>
          {membersLoading ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
            </div>
          ) : roster.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No students enrolled in {membersClass ? buildClassDisplayName(membersClass) : "this class"}.
            </p>
          ) : (
            <ScrollArea className="max-h-[360px]">
              <div className="space-y-1">
                {roster.map(s => {
                  const checked = memberIds.has(s.user_id);
                  return (
                    <div
                      key={s.user_id}
                      className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-muted/50"
                    >
                      <label className="flex items-center gap-2 flex-1 min-w-0 cursor-pointer">
                        <Checkbox
                          checked={checked}
                          onCheckedChange={() => toggleMember(s.user_id)}
                        />
                        <div className="min-w-0">
                          <p className="text-sm truncate">{s.full_name || s.email || "Unnamed"}</p>
                          {s.full_name && s.email && (
                            <p className="text-[11px] text-muted-foreground truncate">{s.email}</p>
                          )}
                        </div>
                      </label>
                      {s.hasNotes && (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2 shrink-0"
                          title="View notes"
                          onClick={() =>
                            setNotesStudent({ user_id: s.user_id, full_name: s.full_name })
                          }
                        >
                          <StickyNote className="w-3.5 h-3.5" />
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>
            </ScrollArea>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={savingMembers}
              onClick={() => {
                setMembersGroup(null);
                setMembersClass(null);
              }}
            >
              Cancel
            </Button>
            <Button onClick={saveMembers} disabled={savingMembers || membersLoading}>
              {savingMembers && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AutoClusterDialog
        open={autoClusterOpen}
        onOpenChange={setAutoClusterOpen}
        classes={classes}
        onPersisted={fetchGroups}
      />

      {generateAudience && (
        <UnifiedGenerateDialog
          open
          onOpenChange={(open) => {
            if (!open) setGenerateAudience(null);
          }}
          courseId={courseId}
          classes={classes}
          materials={[]}
          groupsByOffering={groupsByOffering}
          initialAudience={generateAudience}
        />
      )}

      {notesStudent && notesInstitutionId && (
        <StudentNotesDialog
          open={!!notesStudent}
          onOpenChange={(open) => {
            if (!open) setNotesStudent(null);
          }}
          studentUserId={notesStudent.user_id}
          studentFullName={notesStudent.full_name}
          institutionId={notesInstitutionId}
          mode="read-only"
        />
      )}
    </>
  );
}
