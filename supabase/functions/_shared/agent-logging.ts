import { logger } from "./logger.ts";

// Interface for logging data — generalized for all agent functions
export interface InteractionLogData {
  function_name: string;
  trace_id?: string;
  question_id?: string;
  course_id?: string;
  user_id?: string;
  user_message?: string;
  incoming_state?: Record<string, unknown>;
  evaluator_output?: Record<string, unknown>;
  planner_output?: Record<string, unknown>;
  presenter_output?: string;
  final_response?: Record<string, unknown>;
  language?: string;
  is_first_message?: boolean;
  response_time_ms?: number;
}

// Check if verbose logging is enabled via system_config
export async function isVerboseLoggingEnabled(supabase: any): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from("system_config")
      .select("value")
      .eq("key", "agent_verbose_logging")
      .maybeSingle();

    if (error) {
      logger.warn("Failed to fetch logging config, defaulting to disabled", { error: error.message });
      return false;
    }

    const value = data?.value as { enabled?: boolean } | null;
    return value?.enabled === true;
  } catch (err) {
    logger.warn("Error checking verbose logging config", { error: (err as Error).message });
    return false;
  }
}

// Log interaction to database — non-blocking: failures are warned, never thrown
export async function logInteraction(
  supabase: any,
  logData: InteractionLogData
): Promise<void> {
  try {
    const { error } = await supabase.from("agent_interaction_logs").insert({
      function_name: logData.function_name,
      trace_id: logData.trace_id,
      question_id: logData.question_id,
      course_id: logData.course_id,
      user_id: logData.user_id,
      user_message: logData.user_message,
      incoming_state: logData.incoming_state,
      evaluator_output: logData.evaluator_output,
      planner_output: logData.planner_output,
      presenter_output: logData.presenter_output,
      final_response: logData.final_response,
      language: logData.language,
      is_first_message: logData.is_first_message,
      response_time_ms: logData.response_time_ms,
    });

    if (error) {
      logger.warn("Failed to log interaction", { error: error.message });
    } else {
      logger.info("Interaction logged successfully");
    }
  } catch (err) {
    logger.warn("Error logging interaction", { error: (err as Error).message });
  }
}
