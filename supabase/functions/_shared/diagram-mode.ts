/**
 * Shared helpers for the AI-generated SVG diagram feature (#627). Used by
 * every per-type generate-* edge function so the prompt block, the
 * Structured Output schema fragment, and the runtime validator stay in sync.
 */

export type DiagramMode = "off" | "auto" | "force";

/**
 * Parses the `diagramMode` field off a request body. Defaults to "off" so
 * existing batches that don't send the field behave exactly as today.
 */
export function parseDiagramMode(input: unknown): DiagramMode {
  if (input === "auto" || input === "force") return input;
  return "off";
}

/**
 * The prompt block to substitute into per-type prompt templates. Empty for
 * "off" — we still ask the model NOT to emit a diagram via a one-line
 * directive in the system prompt for belt-and-suspenders.
 */
export function diagramInstructions(mode: DiagramMode): string {
  if (mode === "off") {
    return "DIAGRAMS: For every question, set `diagram.source` to an empty string to indicate no diagram.";
  }
  const header = mode === "force"
    ? "DIAGRAMS (REQUIRED — TEST MODE)"
    : "DIAGRAMS (OPTIONAL)";
  const directive = mode === "force"
    ? "Emit a `diagram` for EVERY question. If the question is not visual, draw the simplest helpful sketch you can (a labelled line, a small chart, a number line). This is a test mode; quality on non-visual questions is expected to be lower than for genuinely geometric items."
    : "Emit a `diagram` ONLY when the question would be genuinely clearer with a figure (geometry: triangles, circles, angle relationships; function graphs; number lines; simple flowcharts). For purely textual questions, OMIT the field.";
  return `${header}
${directive}

When you emit a diagram, the \`diagram\` field MUST be an object with shape:
\t-\tformat: "svg"
\t-\tsource: raw SVG markup as a single string
\t-\talt:    1-sentence description of the figure (optional, for screen readers)

SVG rules:
\t-\tPlain SVG only. No <script>, no <foreignObject>, no inline event handlers.
\t-\tStart with <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"> (the renderer scales). Widen the viewBox (e.g. "0 0 600 400") when you need horizontal room for labels.
\t-\tOutline strokes preferred. No solid fills heavier than light gray.
\t-\tUse <text> for labels (e.g. vertex names A, B, Γ; angle measures like 50°).
\t-\tLabel content inside <text> MUST be PLAIN TEXT. Do NOT wrap labels in $…$ — KaTeX does not run inside SVG, so $v$ would render literally as the characters "$v$". Write "v", "t", "x²", "50°" directly.
\t-\tLabels MUST be in the source content's language (Greek for Greek content, English for English content).
\t-\tHard size cap: 50 KB of SVG source. Keep diagrams concise.
\t-\tIf the alt text or the question stem contains math, wrap it in $...$ (single-dollar, KaTeX-compatible) per the math-formatting rules above. (The alt text renders as HTML, not SVG, so $…$ is fine there.)

LABEL SPACING (anti-overlap — SVG <text> does NOT wrap or auto-resolve collisions, so the coordinates you emit MUST keep labels apart):
\t-\tKeep labels SHORT. Prefer ≤12 characters; abbreviate long words only when two adjacent labels on the same row would each exceed ~12 chars (e.g. if both "Αυτοκίνητο" and "αντίδραση" must share a row, shorten to "Αυτ." / "αντίδρ."). A single label alone in its y-band does not need abbreviation.
\t-\tMinimum horizontal gap between adjacent label centers on the same row: 80 user units (assuming default font-size). If two labels would land within 80 units of each other horizontally, EITHER shorten them OR move one to a different y row at least 18 units away.
\t-\tUse text-anchor="middle" for labels centered over a feature, text-anchor="end" for right-aligned labels, and the default (start) only when intentionally left-aligned. Without text-anchor a long label extends rightward from its x and easily overruns the next label.
\t-\tReserve horizontal "lanes" by y-coordinate so labels close in x never share a y row. Suggested lanes for a 400-tall viewBox: top band (object/scene names) at y≈30; phase/segment names above their arrow at y≈(arrow_y - 12); axis tick values below the axis at y≈(axis_y + 22); origin/zero labels at y≈(axis_y + 36). Adjust proportionally for taller viewBoxes.
\t-\tWhen multiple labels describe overlapping x ranges (e.g. two phases of a motion), STACK them: put one at y=lane_a, the other at y=lane_a-18 (or use a leader line). Do NOT place them at the same y.

CORRECT example for a triangle question:
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><polygon points="60,340 340,340 200,80" fill="none" stroke="#222" stroke-width="2"/><text x="55" y="360">A</text><text x="345" y="360">B</text><text x="195" y="70">C</text></svg>

CORRECT example for a labelled motion diagram (spaced lanes, short labels, text-anchor="middle"):
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 240"><text x="300" y="30" text-anchor="middle">Αυτοκίνητο</text><line x1="40" y1="140" x2="560" y2="140" stroke="#222" stroke-width="2"/><line x1="220" y1="135" x2="220" y2="145" stroke="#222"/><line x1="400" y1="135" x2="400" y2="145" stroke="#222"/><text x="130" y="128" text-anchor="middle">αντίδρ.</text><text x="310" y="128" text-anchor="middle">πέδηση</text><text x="480" y="128" text-anchor="middle">στάση</text><text x="220" y="170" text-anchor="middle">t₁</text><text x="400" y="170" text-anchor="middle">t₂</text></svg>

WRONG — label overlap (do NOT do this):
\t-\t<text x="100" y="120">Αυτοκίνητο</text><text x="160" y="120">αντίδραση</text>  ← "Αυτοκίνητο" is ~10 chars wide and runs straight into "αντίδραση"

WRONG — security (do NOT do this):
\t-\t<svg ... onload="alert(1)">         ← event handler
\t-\t<svg><script>...</script></svg>     ← script tag
\t-\t<svg><foreignObject>...</foreignObject></svg>
\t-\tA 200KB blob of base64-encoded raster data
`;
}

const SCRIPT_RE = /<script\b[^>]*>/i;
const FOREIGN_OBJECT_RE = /<foreignObject\b/i;
const EVENT_HANDLER_RE = /<[^>]*\son[a-z]+\s*=/i;
const JAVASCRIPT_URL_RE = /javascript:/i;
const SVG_ROOT_RE = /<svg\b/i;

export interface RawDiagram {
  format?: unknown;
  source?: unknown;
  alt?: unknown;
}

export interface ValidatedDiagram {
  source: string;
  alt?: string;
}

/**
 * Coarse server-side validator. DOMPurify is not available in Deno, so the
 * authoritative sanitizer runs on the frontend; this is a structural +
 * deny-list pre-filter so we never store an obviously malicious blob.
 *
 * Returns null when the input is missing, malformed, oversize, or contains
 * disallowed constructs. The handler drops the diagram and keeps the
 * question — diagrams are best-effort by design.
 */
export function validateDiagram(
  diagram: RawDiagram | null | undefined,
  maxSourceLength = 50_000,
): ValidatedDiagram | null {
  if (!diagram || typeof diagram !== "object") return null;
  if (diagram.format !== "svg") return null;
  const source = diagram.source;
  if (typeof source !== "string") return null;
  const trimmed = source.trim();
  if (trimmed.length === 0 || trimmed.length > maxSourceLength) return null;
  if (!SVG_ROOT_RE.test(trimmed)) return null;
  if (SCRIPT_RE.test(trimmed)) return null;
  if (FOREIGN_OBJECT_RE.test(trimmed)) return null;
  if (EVENT_HANDLER_RE.test(trimmed)) return null;
  if (JAVASCRIPT_URL_RE.test(trimmed)) return null;
  const alt = typeof diagram.alt === "string" && diagram.alt.length > 0
    ? diagram.alt.slice(0, 500)
    : undefined;
  return alt ? { source: trimmed, alt } : { source: trimmed };
}

/**
 * Structured Output schema fragment for the per-question `diagram` field.
 * Inserted into each generator's per-question schema. Strict-mode
 * compatible: every property is in `required`; absence is expressed via the
 * nullable-string fallback handled by the validator (`source: ""` becomes
 * "no diagram").
 *
 * Even when the prompt forbids diagrams ("off"), the schema permits the
 * field — the validator drops it. This keeps a single static schema across
 * modes so OpenAI's prefix cache hits on it.
 */
export const DIAGRAM_SCHEMA_FRAGMENT = {
  type: "object",
  description:
    "Optional SVG figure to render above the question stem. Only emit when the question is genuinely clearer with a diagram (per the DIAGRAMS section in the prompt). Set source to empty string if omitting.",
  properties: {
    format: { type: "string", enum: ["svg"] },
    source: {
      type: "string",
      description:
        "Raw SVG markup, or empty string to indicate no diagram. Max 50000 chars.",
    },
    alt: {
      type: "string",
      description:
        "1-sentence description of the figure for screen readers. Use empty string when not needed.",
    },
  },
  required: ["format", "source", "alt"],
  additionalProperties: false,
} as const;
