/**
 * Helpers for the per-section due-date inputs in the shared assign dialog
 * (`ContentAssignDialog.perOfferingControls`), used by the study-guide and
 * quiz managers so both surfaces convert deadlines the same way.
 */

/** ISO timestamp → the local values `<input type="date/time">` wants. */
export function isoToLocalInputs(iso: string): { date: string; time: string } {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

/** Date/time inputs → ISO, defaulting a time-less date to end of day. Empty
 *  date means no due date. */
export function localInputsToIso(date: string, time: string): string | null {
  if (!date) return null;
  return new Date(`${date}T${time || "23:59"}`).toISOString();
}
