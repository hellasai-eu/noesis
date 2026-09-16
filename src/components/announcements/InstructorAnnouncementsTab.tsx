import { useCallback, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
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
import { Plus, Pencil, Trash2, Megaphone, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { AnnouncementCard, type AnnouncementCardData } from "./AnnouncementCard";
import {
  AnnouncementEditorDialog,
  type AnnouncementEditorValues,
} from "./AnnouncementEditorDialog";

export interface InstructorSectionOption {
  id: string;
  offeringId: string;
  label: string;
}

interface InstructorAnnouncementsTabProps {
  courseId: string;
  sections: InstructorSectionOption[];
}

interface AnnouncementListItem {
  id: string;
  course_id: string;
  author_id: string | null;
  title: string;
  body: string;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  offeringIds: string[];
}

interface EditingState {
  id: string;
  title: string;
  body: string;
  offeringIds: string[];
  expiresAt: string | null;
}

export function InstructorAnnouncementsTab({
  courseId,
  sections,
}: InstructorAnnouncementsTabProps) {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<EditingState | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const queryKey = useMemo(
    () => ["class-announcements", "course", courseId] as const,
    [courseId],
  );

  const sectionLabelByOfferingId = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of sections) map.set(s.offeringId, s.label);
    return map;
  }, [sections]);

  const { data, isLoading } = useQuery({
    queryKey,
    enabled: Boolean(courseId),
    queryFn: async (): Promise<{
      items: AnnouncementListItem[];
      authorMap: Map<string, string>;
    }> => {
      const { data: rows, error } = await supabase
        .from("class_announcements")
        .select(
          "id, course_id, author_id, title, body, created_at, updated_at, expires_at, announcement_offerings(offering_id)",
        )
        .eq("course_id", courseId)
        .order("created_at", { ascending: false });
      if (error) throw error;

      const items: AnnouncementListItem[] = (rows ?? []).map((r) => ({
        id: r.id,
        course_id: r.course_id,
        author_id: r.author_id,
        title: r.title,
        body: r.body,
        created_at: r.created_at,
        updated_at: r.updated_at,
        expires_at: r.expires_at,
        offeringIds: (r.announcement_offerings ?? []).map(
          (ao: { offering_id: string }) => ao.offering_id,
        ),
      }));

      const authorIds = Array.from(
        new Set(items.map((r) => r.author_id).filter((id): id is string => Boolean(id))),
      );
      const authorMap = new Map<string, string>();
      if (authorIds.length > 0) {
        const { data: profiles } = await supabase
          .from("profiles")
          .select("user_id, full_name")
          .in("user_id", authorIds);
        for (const p of profiles ?? []) {
          authorMap.set(p.user_id, p.full_name ?? "");
        }
      }
      return { items, authorMap };
    },
  });

  const announcements = data?.items ?? [];
  const authorMap = data?.authorMap ?? new Map<string, string>();

  const openCreate = () => {
    setEditing(null);
    setEditorOpen(true);
  };

  const openEdit = (item: AnnouncementListItem) => {
    setEditing({
      id: item.id,
      title: item.title,
      body: item.body,
      offeringIds: item.offeringIds,
      expiresAt: item.expires_at,
    });
    setEditorOpen(true);
  };

  const writeTargets = useCallback(
    async (announcementId: string, desired: string[], existing: string[]) => {
      const desiredSet = new Set(desired);
      const existingSet = new Set(existing);
      const toAdd = desired.filter((id) => !existingSet.has(id));
      const toRemove = existing.filter((id) => !desiredSet.has(id));

      // Delete first: a transient failure leaves the announcement visible to
      // fewer sections rather than more, which is the safer failure mode.
      if (toRemove.length > 0) {
        const { error } = await supabase
          .from("announcement_offerings")
          .delete()
          .eq("announcement_id", announcementId)
          .in("offering_id", toRemove);
        if (error) throw error;
      }
      if (toAdd.length > 0) {
        const { error } = await supabase.from("announcement_offerings").insert(
          toAdd.map((offeringId) => ({
            announcement_id: announcementId,
            offering_id: offeringId,
          })),
        );
        if (error) throw error;
      }
    },
    [],
  );

  const handleSubmit = useCallback(
    async (values: AnnouncementEditorValues) => {
      setSubmitting(true);
      try {
        if (editing) {
          const { error } = await supabase
            .from("class_announcements")
            .update({
              title: values.title,
              body: values.body,
              expires_at: values.expiresAt,
            })
            .eq("id", editing.id);
          if (error) throw error;
          await writeTargets(editing.id, values.offeringIds, editing.offeringIds);
          toast.success("Announcement updated");
        } else {
          const { data: inserted, error } = await supabase
            .from("class_announcements")
            .insert({
              course_id: courseId,
              author_id: user?.id ?? null,
              title: values.title,
              body: values.body,
              expires_at: values.expiresAt,
            })
            .select("id")
            .single();
          if (error) throw error;
          if (inserted && values.offeringIds.length > 0) {
            await writeTargets(inserted.id, values.offeringIds, []);
          }
          toast.success("Announcement posted");
        }
        setEditorOpen(false);
        setEditing(null);
        await queryClient.invalidateQueries({ queryKey });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Failed to save announcement";
        toast.error(message);
      } finally {
        setSubmitting(false);
      }
    },
    [editing, courseId, user?.id, queryClient, queryKey, writeTargets],
  );

  const handleDelete = async () => {
    if (!confirmDeleteId) return;
    try {
      const { error } = await supabase
        .from("class_announcements")
        .delete()
        .eq("id", confirmDeleteId);
      if (error) throw error;
      toast.success("Announcement deleted");
      await queryClient.invalidateQueries({ queryKey });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to delete announcement";
      toast.error(message);
    } finally {
      setConfirmDeleteId(null);
    }
  };

  if (sections.length === 0) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-sm text-muted-foreground">
          No sections available. Assign this course to a section to post announcements.
        </CardContent>
      </Card>
    );
  }

  const editorSections = sections.map((s) => ({ offeringId: s.offeringId, label: s.label }));

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Megaphone className="w-5 h-5" />
              Announcements
            </CardTitle>
            <CardDescription>
              Post updates that students see on their course page. Assign to at least
              one section — leave all unchecked to hide from students (draft).
            </CardDescription>
          </div>
          <Button onClick={openCreate}>
            <Plus className="w-4 h-4 mr-2" />
            New announcement
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : announcements.length === 0 ? (
          <div className="py-10 text-center">
            <Megaphone className="w-10 h-10 mx-auto text-muted-foreground mb-3" />
            <p className="text-sm text-muted-foreground">
              No announcements yet. Post one to get started.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {announcements.map((a) => {
              const cardData: AnnouncementCardData = {
                id: a.id,
                title: a.title,
                body: a.body,
                created_at: a.created_at,
                updated_at: a.updated_at,
                expires_at: a.expires_at,
                author_name: a.author_id ? authorMap.get(a.author_id) ?? null : null,
              };
              const targetLabels = a.offeringIds
                .map((oid) => sectionLabelByOfferingId.get(oid))
                .filter((label): label is string => Boolean(label));
              return (
                <AnnouncementCard
                  key={a.id}
                  announcement={cardData}
                  targetLabels={targetLabels}
                  actions={
                    <>
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label="Edit announcement"
                        onClick={() => openEdit(a)}
                      >
                        <Pencil className="w-4 h-4" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label="Delete announcement"
                        onClick={() => setConfirmDeleteId(a.id)}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </>
                  }
                />
              );
            })}
          </div>
        )}
      </CardContent>

      <AnnouncementEditorDialog
        open={editorOpen}
        onOpenChange={(open) => {
          setEditorOpen(open);
          if (!open) setEditing(null);
        }}
        initialValues={
          editing
            ? {
                title: editing.title,
                body: editing.body,
                offeringIds: editing.offeringIds,
                expiresAt: editing.expiresAt,
              }
            : null
        }
        sections={editorSections}
        onSubmit={handleSubmit}
        submitting={submitting}
      />

      <AlertDialog
        open={confirmDeleteId !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmDeleteId(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete announcement?</AlertDialogTitle>
            <AlertDialogDescription>
              This cannot be undone. Students will no longer see this announcement.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
