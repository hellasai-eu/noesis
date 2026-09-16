/**
 * Sampling-decision persistence for evaluator sessions (#682).
 *
 * The cognitive-level sampling block fires on ~20% of questions (`Math.random()
 * < SAMPLING_PROBABILITY`); the decision is made on first view and must stay
 * stable for the rest of the session — otherwise a reload would re-roll and
 * a question that opened a sampled block could quietly stop asking for the
 * specialist ratings (or vice-versa) mid-session.
 *
 * Before #682 the decisions lived in a `useRef<Map>`, which resets on reload.
 * Now we mirror them to localStorage keyed by session id so a refresh / tab
 * close / accidental navigation finds the same sampling pattern on resume.
 *
 * A single key per session (not per question) keeps writes cheap and the
 * key surface small. Stored shape: `Record<questionId, boolean>`.
 */

const PREFIX = "evaluator:sampling";

function key(sessionId: string): string {
  return `${PREFIX}:${sessionId}`;
}

export function loadSamplingDecisions(
  sessionId: string,
): Record<string, boolean> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(key(sessionId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "boolean") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function saveSamplingDecisions(
  sessionId: string,
  decisions: Record<string, boolean>,
): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key(sessionId), JSON.stringify(decisions));
  } catch {
    // ignore — sampling persistence is best-effort
  }
}

export function clearSamplingDecisions(sessionId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(key(sessionId));
  } catch {
    // ignore
  }
}
