import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { CourseClass } from "@/types/content-assignments";
import { buildClassDisplayName } from "@/lib/greek-school";
import { StickyNote } from "lucide-react";
import { useFormatters } from "@/i18n/formatters";

export interface GroupOption {
  offering_id: string;
  group_id: string;
  label: string;
  description: string | null;
}

export type AudienceSelection =
  | { kind: "none" }
  | {
      kind: "group";
      groupId: string;
      offeringId: string;
      label: string;
      description: string | null;
    }
  | {
      kind: "student";
      studentUserId: string;
      label: string;
      offeringId: string;
      hasAdminNotes: boolean;
    };

interface RosterEntry {
  user_id: string;
  full_name: string | null;
  email: string | null;
  offering_id: string;
  class_label: string;
  hasNotes: boolean;
}

interface TargetAudienceSelectorProps {
  id: string;
  classes: CourseClass[];
  groupOptions: GroupOption[];
  value: AudienceSelection;
  onChange: (next: AudienceSelection) => void;
  /** When true, fetch roster + admin-note flags. Pass `true` only while a dialog is open. */
  enabled: boolean;
}

const NONE_VALUE = "__none__";
const studentValue = (uid: string) => `student:${uid}`;
const groupValue = (gid: string) => `group:${gid}`;

export function TargetAudienceSelector({
  id,
  classes,
  groupOptions,
  value,
  onChange,
  enabled,
}: TargetAudienceSelectorProps) {
  const { compareText } = useFormatters();
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [loadingRoster, setLoadingRoster] = useState(false);

  // Stable join key for the effect — avoids re-fetching when the parent
  // recreates the classes array on every render.
  const classKey = useMemo(() => classes.map((c) => c.id).sort().join(","), [classes]);

  useEffect(() => {
    if (!enabled || classes.length === 0) {
      setRoster([]);
      return;
    }

    let cancelled = false;
    const load = async () => {
      setLoadingRoster(true);
      try {
        const classIds = classes.map((c) => c.id);
        const classLabelById = new Map(classes.map((c) => [c.id, buildClassDisplayName(c)]));
        const offeringIdByClassId = new Map(classes.map((c) => [c.id, c.offering_id]));

        const { data: enrollments, error: enErr } = await supabase
          .from("class_enrollments")
          .select("user_id, class_id, role")
          .in("class_id", classIds)
          .eq("role", "student");
        if (enErr) throw enErr;
        const enrolledUserIds = Array.from(
          new Set(((enrollments as { user_id: string }[]) || []).map((r) => r.user_id)),
        );

        if (enrolledUserIds.length === 0) {
          if (!cancelled) setRoster([]);
          return;
        }

        const [{ data: profileRows, error: pErr }, notesResult] = await Promise.all([
          supabase
            .from("profiles")
            .select("user_id, full_name, email")
            .in("user_id", enrolledUserIds),
          // student_admin_notes may not exist on environments where #519 hasn't
          // been deployed — swallow the error and treat as no notes.
          supabase
            .from("student_admin_notes" as any)
            .select("student_user_id")
            .in("student_user_id", enrolledUserIds)
            .then(
              (r) => r,
              () => ({ data: [], error: null }),
            ),
        ]);
        if (pErr) throw pErr;

        const profileByUserId = new Map(
          ((profileRows as { user_id: string; full_name: string | null; email: string | null }[]) || []).map((p) => [
            p.user_id,
            p,
          ]),
        );
        const notesStudentIds = new Set<string>(
          (((notesResult?.data as { student_user_id: string }[] | null) ?? []) || []).map((r) => r.student_user_id),
        );

        const entries: RosterEntry[] = [];
        const seenForOffering = new Set<string>();
        for (const enrollment of (enrollments as { user_id: string; class_id: string }[]) || []) {
          const offeringId = offeringIdByClassId.get(enrollment.class_id);
          if (!offeringId) continue;
          const key = `${offeringId}:${enrollment.user_id}`;
          if (seenForOffering.has(key)) continue;
          seenForOffering.add(key);
          const profile = profileByUserId.get(enrollment.user_id);
          entries.push({
            user_id: enrollment.user_id,
            full_name: profile?.full_name ?? null,
            email: profile?.email ?? null,
            offering_id: offeringId,
            class_label: classLabelById.get(enrollment.class_id) ?? "Class",
            hasNotes: notesStudentIds.has(enrollment.user_id),
          });
        }
        entries.sort((a, b) => {
          const aName = a.full_name || a.email || "";
          const bName = b.full_name || b.email || "";
          return compareText(aName, bName);
        });
        if (!cancelled) setRoster(entries);
      } catch (e) {
        console.error("TargetAudienceSelector: roster load failed", e);
        if (!cancelled) setRoster([]);
      } finally {
        if (!cancelled) setLoadingRoster(false);
      }
    };

    load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally watching classKey only
  }, [enabled, classKey]);

  const selectedValue =
    value.kind === "none"
      ? NONE_VALUE
      : value.kind === "group"
      ? groupValue(value.groupId)
      : studentValue(value.studentUserId);

  const handleChange = (v: string) => {
    if (v === NONE_VALUE) {
      onChange({ kind: "none" });
      return;
    }
    if (v.startsWith("group:")) {
      const groupId = v.slice("group:".length);
      const opt = groupOptions.find((g) => g.group_id === groupId);
      if (!opt) return;
      onChange({
        kind: "group",
        groupId: opt.group_id,
        offeringId: opt.offering_id,
        label: opt.label,
        description: opt.description,
      });
      return;
    }
    if (v.startsWith("student:")) {
      const studentUserId = v.slice("student:".length);
      const entry = roster.find((r) => r.user_id === studentUserId);
      if (!entry) return;
      const name = entry.full_name || entry.email || "Student";
      onChange({
        kind: "student",
        studentUserId,
        label: `${entry.class_label} → ${name}`,
        offeringId: entry.offering_id,
        hasAdminNotes: entry.hasNotes,
      });
    }
  };

  const helper = (() => {
    if (value.kind === "group") {
      // The description IS the steer — questions are aimed at the weakness it
      // names — so show it back verbatim rather than a paraphrase of it.
      return value.description
        ? `Questions will target this group's description: "${value.description}". They are tagged with the group in the bank, not assigned to it.`
        : "This group has no description, so there is no weakness to aim at. Add one on the group to steer generation. Questions are tagged with the group in the bank, not assigned to it.";
    }
    if (value.kind === "student") {
      return "AI tailors questions to this student's mastery, recent quiz history, and (if available) admin notes; questions are auto-assigned to that student via a hidden singleton group.";
    }
    return "Pick a group or a single student to personalise generation, or leave as 'Whole class' for an untargeted batch.";
  })();

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>Target audience (optional)</Label>
      <Select value={selectedValue} onValueChange={handleChange}>
        <SelectTrigger id={id}>
          <SelectValue placeholder="Whole class" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE_VALUE}>Whole class (no targeting)</SelectItem>
          {groupOptions.length > 0 && (
            <SelectGroup>
              <SelectLabel>Groups</SelectLabel>
              {groupOptions.map((opt) => (
                <SelectItem
                  key={opt.group_id}
                  value={groupValue(opt.group_id)}
                  title={opt.description || undefined}
                >
                  {opt.label}
                </SelectItem>
              ))}
            </SelectGroup>
          )}
          {roster.length > 0 && (
            <SelectGroup>
              <SelectLabel>Students</SelectLabel>
              {roster.map((s) => {
                const name = s.full_name || s.email || "Student";
                return (
                  <SelectItem key={`${s.offering_id}-${s.user_id}`} value={studentValue(s.user_id)}>
                    <span className="inline-flex items-center gap-1.5">
                      {s.class_label} → {name}
                      {s.hasNotes && <StickyNote className="w-3 h-3 text-muted-foreground" />}
                    </span>
                  </SelectItem>
                );
              })}
            </SelectGroup>
          )}
          {loadingRoster && roster.length === 0 && (
            <div className="px-2 py-1 text-xs text-muted-foreground">Loading roster…</div>
          )}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">{helper}</p>
      {value.kind === "student" && value.hasAdminNotes && (
        <p className="text-xs text-amber-700 dark:text-amber-300 inline-flex items-center gap-1">
          <StickyNote className="w-3.5 h-3.5" />
          This student's admin notes will be included in the AI prompt for personalised generation.
        </p>
      )}
    </div>
  );
}
