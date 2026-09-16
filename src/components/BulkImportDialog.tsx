import { useMemo, useState } from "react";
import Papa from "papaparse";
import { supabase } from "@/integrations/supabase/client";
import { useInstitutionGradeLevels } from "@/hooks/useInstitutionGradeLevels";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Loader2, Upload, AlertTriangle, CheckCircle, XCircle, FileText } from "lucide-react";
import { toast } from "sonner";

export type BulkImportRole = "student" | "instructor";

interface BulkImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  role: BulkImportRole;
  institutionId: string | null;
  institutionName: string;
  inviterName: string;
  existingMemberEmails: Set<string>;
  existingInvitationEmails: Set<string>;
  classes: Array<{ id: string; grade_level_id: string | null; section_name: string | null }>;
  onComplete?: () => void;
}

interface ParsedStudentRow {
  email: string;
  firstName?: string;
  lastName?: string;
  fatherName?: string;
  dateOfBirth?: string;
  sectionName?: string;
  rawRow: number;
}

interface ParsedInstructorRow {
  email: string;
  firstName?: string;
  lastName?: string;
  gradeLevels?: string[];
  rawRow: number;
}

type ParsedRow = ParsedStudentRow | ParsedInstructorRow;

interface RowValidation {
  status: "ready" | "skip" | "error";
  reason?: string;
}

interface RowResult {
  email: string;
  status: "invited" | "skipped" | "failed";
  reason?: string;
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Step = "configure" | "preview" | "summary";

function normalizeEmail(value: string | undefined | null): string {
  return (value ?? "").trim().toLowerCase();
}

function pickColumn(row: Record<string, string>, keys: string[]): string | undefined {
  for (const key of keys) {
    const exact = row[key];
    if (exact !== undefined && exact !== null && exact !== "") return exact;
  }
  // case-insensitive fallback
  const lowered: Record<string, string> = {};
  for (const k of Object.keys(row)) lowered[k.toLowerCase().trim()] = row[k];
  for (const key of keys) {
    const v = lowered[key.toLowerCase()];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

function parseCsv(text: string, role: BulkImportRole): { rows: ParsedRow[]; parseErrors: string[] } {
  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  });

  const parseErrors: string[] = [];
  for (const err of parsed.errors ?? []) {
    parseErrors.push(`Row ${err.row ?? "?"}: ${err.message}`);
  }

  const rows: ParsedRow[] = [];
  (parsed.data ?? []).forEach((rawRecord, idx) => {
    const rawRow = idx + 2; // header + 1-based
    const email = (pickColumn(rawRecord, ["email"]) ?? "").trim();
    const firstName = (pickColumn(rawRecord, ["first_name", "firstName", "first name"]) ?? "").trim();
    const lastName = (pickColumn(rawRecord, ["last_name", "lastName", "last name"]) ?? "").trim();

    if (role === "student") {
      const fatherName = (pickColumn(rawRecord, ["father_name", "fatherName", "father name"]) ?? "").trim();
      const dateOfBirth = (pickColumn(rawRecord, ["date_of_birth", "dateOfBirth", "dob", "date of birth"]) ?? "").trim();
      const sectionName = (pickColumn(rawRecord, ["section_name", "section", "sectionName"]) ?? "").trim();
      rows.push({
        email,
        firstName: firstName || undefined,
        lastName: lastName || undefined,
        fatherName: fatherName || undefined,
        dateOfBirth: dateOfBirth || undefined,
        sectionName: sectionName || undefined,
        rawRow,
      });
    } else {
      const gradeLevelsRaw = (pickColumn(rawRecord, ["grade_levels", "gradeLevels", "grades"]) ?? "").trim();
      const gradeLevels = gradeLevelsRaw
        ? gradeLevelsRaw.split(/[,;|]/).map((g) => g.trim()).filter(Boolean)
        : undefined;
      rows.push({
        email,
        firstName: firstName || undefined,
        lastName: lastName || undefined,
        gradeLevels,
        rawRow,
      });
    }
  });

  return { rows, parseErrors };
}

function validateRows(
  rows: ParsedRow[],
  opts: {
    role: BulkImportRole;
    sectionStrategy: "same" | "per-row";
    sharedSectionName: string;
    sectionNamesForGrade: Set<string>;
    existingMemberEmails: Set<string>;
    existingInvitationEmails: Set<string>;
    allowedGradeLevels: Set<string>;
  },
): RowValidation[] {
  const seenInBatch = new Set<string>();
  return rows.map((row) => {
    const email = normalizeEmail(row.email);
    if (!email) return { status: "error", reason: "Missing email" };
    if (!EMAIL_REGEX.test(email)) return { status: "error", reason: "Invalid email format" };
    if (seenInBatch.has(email)) return { status: "error", reason: "Duplicate email within batch" };
    seenInBatch.add(email);

    if (opts.existingMemberEmails.has(email)) {
      return { status: "skip", reason: "Already a member of this institution" };
    }
    if (opts.existingInvitationEmails.has(email)) {
      return { status: "skip", reason: "Existing invitation for this email" };
    }

    if (opts.role === "student") {
      const r = row as ParsedStudentRow;
      const sectionName = opts.sectionStrategy === "same" ? opts.sharedSectionName : (r.sectionName ?? "").trim();
      if (!sectionName) {
        return { status: "error", reason: "Missing section_name (per-row mode)" };
      }
      if (!opts.sectionNamesForGrade.has(sectionName)) {
        return { status: "error", reason: `Unknown section "${sectionName}" for selected grade level` };
      }
    } else {
      const r = row as ParsedInstructorRow;
      if (r.gradeLevels && r.gradeLevels.length > 0) {
        const bad = r.gradeLevels.filter((g) => !opts.allowedGradeLevels.has(g));
        if (bad.length > 0) {
          return { status: "error", reason: `Unknown grade_levels: ${bad.join(", ")}` };
        }
      }
    }

    return { status: "ready" };
  });
}

export const BulkImportDialog = ({
  open,
  onOpenChange,
  role,
  institutionId,
  institutionName,
  inviterName,
  existingMemberEmails,
  existingInvitationEmails,
  classes,
  onComplete,
}: BulkImportDialogProps) => {
  const [step, setStep] = useState<Step>("configure");
  const [csvText, setCsvText] = useState("");
  const [parseErrors, setParseErrors] = useState<string[]>([]);
  const [parsedRows, setParsedRows] = useState<ParsedRow[]>([]);
  const [gradeLevel, setGradeLevel] = useState<string>("");
  const [sectionStrategy, setSectionStrategy] = useState<"same" | "per-row">("same");
  const [sharedSectionName, setSharedSectionName] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [results, setResults] = useState<RowResult[]>([]);

  const gradeLevels = useInstitutionGradeLevels(institutionId);
  const filteredGradeOptions = gradeLevels.options;
  const allowedGradeLevels = useMemo(
    () => new Set(filteredGradeOptions.map((g) => g.value)),
    [filteredGradeOptions],
  );

  const sectionsForGrade = useMemo(() => {
    // FK identity match — the TEXT column no longer exists after #799.
    const gradeLevelId = gradeLevel ? gradeLevels.findIdByCode(gradeLevel) : null;
    if (!gradeLevelId) return [];
    return classes
      .filter((c) => !!c.section_name && c.grade_level_id === gradeLevelId)
      .map((c) => c.section_name as string);
  }, [classes, gradeLevel, gradeLevels]);

  const sectionNamesForGrade = useMemo(() => new Set(sectionsForGrade), [sectionsForGrade]);

  const validations = useMemo(() => {
    if (step !== "preview") return [] as RowValidation[];
    return validateRows(parsedRows, {
      role,
      sectionStrategy,
      sharedSectionName,
      sectionNamesForGrade,
      existingMemberEmails,
      existingInvitationEmails,
      allowedGradeLevels,
    });
  }, [
    step,
    parsedRows,
    role,
    sectionStrategy,
    sharedSectionName,
    sectionNamesForGrade,
    existingMemberEmails,
    existingInvitationEmails,
    allowedGradeLevels,
  ]);

  const counts = useMemo(() => {
    return {
      ready: validations.filter((v) => v.status === "ready").length,
      skip: validations.filter((v) => v.status === "skip").length,
      error: validations.filter((v) => v.status === "error").length,
    };
  }, [validations]);

  const reset = () => {
    setStep("configure");
    setCsvText("");
    setParseErrors([]);
    setParsedRows([]);
    setGradeLevel("");
    setSectionStrategy("same");
    setSharedSectionName("");
    setResults([]);
    setSubmitting(false);
  };

  const handleClose = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  const handleFile = async (file: File) => {
    const text = await file.text();
    setCsvText(text);
  };

  const handlePreview = () => {
    if (role === "student") {
      if (!gradeLevel) {
        toast.error("Pick a grade level first");
        return;
      }
      if (sectionStrategy === "same" && !sharedSectionName) {
        toast.error("Pick a section for all students");
        return;
      }
    }
    if (!csvText.trim()) {
      toast.error("Upload a CSV file or paste rows first");
      return;
    }
    const { rows, parseErrors: errs } = parseCsv(csvText, role);
    if (rows.length === 0) {
      toast.error("No rows found in CSV");
      setParseErrors(errs);
      return;
    }
    setParsedRows(rows);
    setParseErrors(errs);
    setStep("preview");
  };

  const handleCommit = async () => {
    if (!institutionId) return;
    const readyRows = parsedRows.filter((_r, i) => validations[i]?.status === "ready");
    if (readyRows.length === 0) {
      toast.error("No rows to commit — fix errors first");
      return;
    }

    setSubmitting(true);
    try {
      const payloadRows = readyRows.map((r) => {
        if (role === "student") {
          const sr = r as ParsedStudentRow;
          return {
            email: sr.email,
            firstName: sr.firstName,
            lastName: sr.lastName,
            fatherName: sr.fatherName,
            dateOfBirth: sr.dateOfBirth,
            sectionName: sectionStrategy === "same" ? sharedSectionName : sr.sectionName,
          };
        }
        const ir = r as ParsedInstructorRow;
        return {
          email: ir.email,
          firstName: ir.firstName,
          lastName: ir.lastName,
          gradeLevels: ir.gradeLevels,
        };
      });

      const { data, error } = await supabase.functions.invoke("bulk-invite-users", {
        body: {
          institutionId,
          role,
          gradeLevel: role === "student" ? gradeLevel : undefined,
          sectionStrategy: role === "student" ? sectionStrategy : undefined,
          sharedSectionName: role === "student" && sectionStrategy === "same" ? sharedSectionName : undefined,
          rows: payloadRows,
          institutionName,
          inviterName,
        },
      });

      if (error) throw error;
      if (data?.error) throw new Error(data.error);

      const serverResults: RowResult[] = data?.results ?? [];

      // Merge server results with client-side skips (rows the server never saw)
      const merged: RowResult[] = [...serverResults];
      parsedRows.forEach((r, i) => {
        const v = validations[i];
        if (v?.status === "skip" || v?.status === "error") {
          merged.push({
            email: normalizeEmail(r.email) || r.email,
            status: v.status === "skip" ? "skipped" : "failed",
            reason: v.reason,
          });
        }
      });

      setResults(merged);
      setStep("summary");
      onComplete?.();
      const summary = data?.summary ?? {
        invited: serverResults.filter((r) => r.status === "invited").length,
        skipped: serverResults.filter((r) => r.status === "skipped").length,
        failed: serverResults.filter((r) => r.status === "failed").length,
      };
      toast.success(`Imported ${summary.invited} user${summary.invited === 1 ? "" : "s"}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Bulk import failed";
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  };

  const renderConfigure = () => (
    <div className="space-y-5">
      {role === "student" && (
        <>
          <div className="space-y-2">
            <Label>Grade level</Label>
            <Select value={gradeLevel} onValueChange={setGradeLevel}>
              <SelectTrigger>
                <SelectValue placeholder="Select a grade level" />
              </SelectTrigger>
              <SelectContent>
                {filteredGradeOptions.map((g) => (
                  <SelectItem key={g.value} value={g.value}>
                    {g.labelEl} ({g.labelEn})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Applied to every row in this batch.
            </p>
          </div>

          <div className="space-y-2">
            <Label>Assign all students to the same section?</Label>
            <RadioGroup
              value={sectionStrategy}
              onValueChange={(v) => setSectionStrategy(v as "same" | "per-row")}
            >
              <div className="flex items-center gap-2">
                <RadioGroupItem value="same" id="strategy-same" />
                <Label htmlFor="strategy-same" className="font-normal cursor-pointer">
                  Yes — one section for everyone
                </Label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem value="per-row" id="strategy-per-row" />
                <Label htmlFor="strategy-per-row" className="font-normal cursor-pointer">
                  No — each row's <code className="text-xs">section_name</code> column decides
                </Label>
              </div>
            </RadioGroup>
          </div>

          {sectionStrategy === "same" && (
            <div className="space-y-2">
              <Label>Section</Label>
              <Select
                value={sharedSectionName}
                onValueChange={setSharedSectionName}
                disabled={!gradeLevel || sectionsForGrade.length === 0}
              >
                <SelectTrigger>
                  <SelectValue
                    placeholder={
                      !gradeLevel
                        ? "Pick a grade level first"
                        : sectionsForGrade.length === 0
                        ? "No sections exist for this grade"
                        : "Select a section"
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {sectionsForGrade.map((s) => (
                    <SelectItem key={s} value={s}>
                      Τμήμα {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {gradeLevel && sectionsForGrade.length === 0 && (
                <p className="text-xs text-destructive">
                  No sections exist for {gradeLevels.getLabel(gradeLevel, "el")}. Create one in Classes first.
                </p>
              )}
            </div>
          )}
        </>
      )}

      <div className="space-y-2">
        <Label>CSV file</Label>
        <Input
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleFile(file);
          }}
        />
        <p className="text-xs text-muted-foreground">
          Required header: <code>email</code>. Optional:{" "}
          {role === "student" ? (
            <>
              <code>first_name</code>, <code>last_name</code>, <code>father_name</code>,{" "}
              <code>date_of_birth</code>
              {sectionStrategy === "per-row" && (
                <>
                  , <code>section_name</code>
                </>
              )}
              .
            </>
          ) : (
            <>
              <code>first_name</code>, <code>last_name</code>, <code>grade_levels</code>{" "}
              (comma-separated).
            </>
          )}
        </p>
      </div>

      <div className="space-y-2">
        <Label>Or paste CSV rows</Label>
        <Textarea
          rows={6}
          placeholder={
            role === "student"
              ? "email,first_name,last_name\nada@example.com,Ada,Lovelace"
              : "email,first_name,last_name,grade_levels\ngeorge@example.com,George,Boole,gymnasio_2,lykeio_1"
          }
          value={csvText}
          onChange={(e) => setCsvText(e.target.value)}
        />
      </div>

      {parseErrors.length > 0 && (
        <div className="rounded border border-destructive/40 bg-destructive/5 p-3 text-xs">
          <p className="font-medium text-destructive mb-1">CSV parse warnings</p>
          <ul className="list-disc list-inside text-destructive/80 space-y-0.5">
            {parseErrors.slice(0, 5).map((e, i) => (
              <li key={i}>{e}</li>
            ))}
            {parseErrors.length > 5 && <li>…and {parseErrors.length - 5} more</li>}
          </ul>
        </div>
      )}
    </div>
  );

  const renderPreview = () => (
    <div className="space-y-3">
      <div className="flex items-center gap-3 text-sm">
        <span className="inline-flex items-center gap-1 text-green-600">
          <CheckCircle className="w-4 h-4" /> {counts.ready} ready
        </span>
        <span className="inline-flex items-center gap-1 text-amber-600">
          <AlertTriangle className="w-4 h-4" /> {counts.skip} skip
        </span>
        <span className="inline-flex items-center gap-1 text-destructive">
          <XCircle className="w-4 h-4" /> {counts.error} error
        </span>
      </div>

      <div className="max-h-[420px] overflow-auto rounded border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8">#</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Name</TableHead>
              {role === "student" && <TableHead>Section</TableHead>}
              {role === "instructor" && <TableHead>Grade levels</TableHead>}
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {parsedRows.map((row, i) => {
              const v = validations[i];
              const isStudent = role === "student";
              const sr = row as ParsedStudentRow;
              const ir = row as ParsedInstructorRow;
              const fullName = [row.firstName, row.lastName].filter(Boolean).join(" ");
              return (
                <TableRow key={i}>
                  <TableCell className="text-xs text-muted-foreground">{row.rawRow}</TableCell>
                  <TableCell className="font-mono text-xs">{row.email || "(empty)"}</TableCell>
                  <TableCell className="text-xs">{fullName || "—"}</TableCell>
                  {isStudent && (
                    <TableCell className="text-xs">
                      {sectionStrategy === "same"
                        ? sharedSectionName
                        : sr.sectionName || <span className="text-muted-foreground italic">missing</span>}
                    </TableCell>
                  )}
                  {!isStudent && (
                    <TableCell className="text-xs">
                      {ir.gradeLevels && ir.gradeLevels.length > 0
                        ? ir.gradeLevels.join(", ")
                        : "—"}
                    </TableCell>
                  )}
                  <TableCell className="text-xs">
                    {v?.status === "ready" && (
                      <span className="inline-flex items-center gap-1 text-green-600">
                        <CheckCircle className="w-3 h-3" /> ready
                      </span>
                    )}
                    {v?.status === "skip" && (
                      <span
                        className="inline-flex items-center gap-1 text-amber-600"
                        title={v.reason}
                      >
                        <AlertTriangle className="w-3 h-3" /> {v.reason ?? "skip"}
                      </span>
                    )}
                    {v?.status === "error" && (
                      <span
                        className="inline-flex items-center gap-1 text-destructive"
                        title={v.reason}
                      >
                        <XCircle className="w-3 h-3" /> {v.reason ?? "error"}
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {role === "instructor" && parsedRows.some((r) => (r as ParsedInstructorRow).gradeLevels?.length) && (
        <p className="text-xs text-muted-foreground">
          Instructor <code>grade_levels</code> are noted but not applied to{" "}
          <code>user_institution_grades</code> until accepted — assign them from the Users tab after
          first sign-in.
        </p>
      )}
    </div>
  );

  const renderSummary = () => {
    const invited = results.filter((r) => r.status === "invited");
    const skipped = results.filter((r) => r.status === "skipped");
    const failed = results.filter((r) => r.status === "failed");
    return (
      <div className="space-y-3">
        <div className="grid grid-cols-3 gap-2 text-center">
          <div className="rounded border p-3">
            <p className="text-2xl font-bold text-green-600">{invited.length}</p>
            <p className="text-xs text-muted-foreground">Invited</p>
          </div>
          <div className="rounded border p-3">
            <p className="text-2xl font-bold text-amber-600">{skipped.length}</p>
            <p className="text-xs text-muted-foreground">Skipped</p>
          </div>
          <div className="rounded border p-3">
            <p className="text-2xl font-bold text-destructive">{failed.length}</p>
            <p className="text-xs text-muted-foreground">Failed</p>
          </div>
        </div>
        {(skipped.length > 0 || failed.length > 0) && (
          <div className="max-h-[300px] overflow-auto rounded border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Email</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Reason</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {[...skipped, ...failed].map((r, i) => (
                  <TableRow key={i}>
                    <TableCell className="font-mono text-xs">{r.email}</TableCell>
                    <TableCell className="text-xs">
                      {r.status === "skipped" ? (
                        <span className="text-amber-600">skipped</span>
                      ) : (
                        <span className="text-destructive">failed</span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs">{r.reason ?? "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    );
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {step === "summary" ? <FileText className="w-5 h-5" /> : <Upload className="w-5 h-5" />}
            Bulk import {role === "student" ? "students" : "instructors"}
          </DialogTitle>
          <DialogDescription>
            {step === "configure" &&
              `Upload or paste a CSV with one row per ${role}. We'll preview before sending anything.`}
            {step === "preview" && "Review each row and fix any errors before committing."}
            {step === "summary" && "Import complete. Here's what happened."}
          </DialogDescription>
        </DialogHeader>

        {step === "configure" && renderConfigure()}
        {step === "preview" && renderPreview()}
        {step === "summary" && renderSummary()}

        <DialogFooter className="gap-2">
          {step === "configure" && (
            <>
              <Button variant="outline" onClick={() => handleClose(false)}>
                Cancel
              </Button>
              <Button onClick={handlePreview}>Preview</Button>
            </>
          )}
          {step === "preview" && (
            <>
              <Button variant="outline" onClick={() => setStep("configure")} disabled={submitting}>
                Back
              </Button>
              <Button onClick={handleCommit} disabled={submitting || counts.ready === 0}>
                {submitting ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin mr-2" />
                    Sending invitations…
                  </>
                ) : (
                  `Invite ${counts.ready} ${role}${counts.ready === 1 ? "" : "s"}`
                )}
              </Button>
            </>
          )}
          {step === "summary" && <Button onClick={() => handleClose(false)}>Close</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default BulkImportDialog;
