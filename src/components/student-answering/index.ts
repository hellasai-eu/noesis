/**
 * Embeddable per-type single-question answering panels (#755).
 *
 * Each panel renders the answering view for ONE question by id, without a
 * surrounding list or selection UI. The unified Practice surface (#756)
 * embeds the right panel for the right `type` and uses the shared callbacks
 * to refresh its list and dispatch next-question.
 */
export { AnsweringChrome } from "./AnsweringChrome";
export { SingleMcqAnsweringPanel } from "./SingleMcqAnsweringPanel";
export { SingleOpenAnsweringPanel } from "./SingleOpenAnsweringPanel";
export { SingleFillGapsAnsweringPanel } from "./SingleFillGapsAnsweringPanel";
export { SingleOrderingAnsweringPanel } from "./SingleOrderingAnsweringPanel";
export { SingleClassificationAnsweringPanel } from "./SingleClassificationAnsweringPanel";
export type {
  SinglePanelProps,
  SinglePanelStatus,
  SinglePanelCompletion,
} from "./types";
