/**
 * Single import point for every concrete job handler.
 *
 * The worker function (`run-jobs`) imports this module, and each handler
 * module side-effect-registers itself via `registerJobHandler()`. Adding a
 * new job type (e.g. #697 bulk question generation) is a one-line change
 * here — no runner changes.
 *
 * Empty for now: handlers are tracked in separate issues (#697).
 */

import "./job-handlers/bulk-question-generation.ts";
import "./job-handlers/followup-practice-generation.ts";
export {};
