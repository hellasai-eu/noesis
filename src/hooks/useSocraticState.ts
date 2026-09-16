import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/types";
import type { TutorState } from "@/types/tutor-state";

interface UseSocraticStateOptions {
  userId: string | null;
  openQuestionId: string | null;
  courseId: string | null;
}

interface UseSocraticStateResult {
  /** Current tutor state */
  state: TutorState | null;
  /** Whether state is currently loading */
  isLoading: boolean;
  /** Error if state fetch failed */
  error: Error | null;
  /** Update the state (upserts to database) */
  updateState: (newState: TutorState) => Promise<void>;
  /** Refresh state from database */
  refreshState: () => Promise<void>;
}

/**
 * Tutor state for one student's work on one open question.
 *
 * State now hangs off the unified `chat_sessions` row rather than being keyed
 * by (user, question) on a table of its own, so this resolves the session
 * first and works from its id. That is also what makes the realtime filter
 * exact: `chat_session_state` carries no user column, so a filter on it has to
 * be `session_id`, and subscribing unfiltered would hand us other students'
 * rows to discard.
 */
export function useSocraticState({
  userId,
  openQuestionId,
  courseId,
}: UseSocraticStateOptions): UseSocraticStateResult {
  const [state, setState] = useState<TutorState | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetchState = useCallback(async () => {
    if (!userId || !openQuestionId || !courseId) {
      setState(null);
      setSessionId(null);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const { data: session, error: sessionError } = await supabase
        .from("chat_sessions")
        .select("id")
        .eq("user_id", userId)
        .eq("open_question_id", openQuestionId)
        .maybeSingle();

      if (sessionError) throw sessionError;

      // No session yet is the ordinary state of a question nobody has opened.
      if (!session) {
        setSessionId(null);
        setState(null);
        return;
      }

      setSessionId(session.id);

      const { data, error: fetchError } = await supabase
        .from("chat_session_state")
        .select("current_state")
        .eq("session_id", session.id)
        .maybeSingle();

      if (fetchError) throw fetchError;

      setState(data ? (data.current_state as unknown as TutorState) : null);
    } catch (err) {
      console.error("Error fetching socratic state:", err);
      setError(err instanceof Error ? err : new Error("Failed to fetch state"));
    } finally {
      setIsLoading(false);
    }
  }, [userId, openQuestionId, courseId]);

  useEffect(() => {
    fetchState();
  }, [fetchState]);

  // Realtime, filtered to this session. Nothing to subscribe to before the
  // session exists; `fetchState` sets `sessionId` and re-arms this.
  useEffect(() => {
    if (!sessionId) return;

    const channel = supabase
      .channel(`chat-session-state-${sessionId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "chat_session_state",
          filter: `session_id=eq.${sessionId}`,
        },
        (payload) => {
          const next = payload.new as { current_state?: unknown } | undefined;
          if (next?.current_state) {
            setState(next.current_state as TutorState);
          }
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [sessionId]);

  const updateState = useCallback(
    async (newState: TutorState) => {
      if (!userId || !openQuestionId || !courseId) {
        throw new Error("Missing required parameters for state update");
      }

      try {
        // The session may not exist yet on the first turn. Resolving it here
        // rather than creating one keeps session creation in the edge
        // function, which is the only writer that knows the authorised
        // offering to scope it to.
        let id = sessionId;
        if (!id) {
          const { data: session, error: sessionError } = await supabase
            .from("chat_sessions")
            .select("id")
            .eq("user_id", userId)
            .eq("open_question_id", openQuestionId)
            .maybeSingle();

          if (sessionError) throw sessionError;
          if (!session) return;

          id = session.id;
          setSessionId(id);
        }

        const { data, error: upsertError } = await supabase
          .from("chat_session_state")
          .upsert(
            {
              session_id: id,
              current_state: newState as unknown as Json,
              updated_at: new Date().toISOString(),
            },
            { onConflict: "session_id" },
          )
          .select("current_state")
          .single();

        if (upsertError) throw upsertError;
        if (data) setState(data.current_state as unknown as TutorState);
      } catch (err) {
        console.error("Error updating socratic state:", err);
        throw err;
      }
    },
    [userId, openQuestionId, courseId, sessionId],
  );

  return {
    state,
    isLoading,
    error,
    updateState,
    refreshState: fetchState,
  };
}
