export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      admin_notifications: {
        Row: {
          course_id: string
          created_at: string
          id: string
          link: string | null
          message: string
          read: boolean
          student_id: string
          title: string
          type: string
        }
        Insert: {
          course_id: string
          created_at?: string
          id?: string
          link?: string | null
          message: string
          read?: boolean
          student_id: string
          title: string
          type?: string
        }
        Update: {
          course_id?: string
          created_at?: string
          id?: string
          link?: string | null
          message?: string
          read?: boolean
          student_id?: string
          title?: string
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "admin_notifications_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_interaction_logs: {
        Row: {
          course_id: string | null
          created_at: string | null
          evaluator_output: Json | null
          final_response: Json | null
          function_name: string
          id: string
          incoming_state: Json | null
          is_first_message: boolean | null
          language: string | null
          planner_output: Json | null
          presenter_output: string | null
          question_id: string | null
          response_time_ms: number | null
          trace_id: string | null
          user_id: string | null
          user_message: string | null
        }
        Insert: {
          course_id?: string | null
          created_at?: string | null
          evaluator_output?: Json | null
          final_response?: Json | null
          function_name: string
          id?: string
          incoming_state?: Json | null
          is_first_message?: boolean | null
          language?: string | null
          planner_output?: Json | null
          presenter_output?: string | null
          question_id?: string | null
          response_time_ms?: number | null
          trace_id?: string | null
          user_id?: string | null
          user_message?: string | null
        }
        Update: {
          course_id?: string | null
          created_at?: string | null
          evaluator_output?: Json | null
          final_response?: Json | null
          function_name?: string
          id?: string
          incoming_state?: Json | null
          is_first_message?: boolean | null
          language?: string | null
          planner_output?: Json | null
          presenter_output?: string | null
          question_id?: string | null
          response_time_ms?: number | null
          trace_id?: string | null
          user_id?: string | null
          user_message?: string | null
        }
        Relationships: []
      }
      ai_rate_limit_events: {
        Row: {
          course_id: string | null
          created_at: string
          delay_before_retry_ms: number | null
          error_message: string | null
          event_type: Database["public"]["Enums"]["rate_limit_event_type"]
          eventual_success: boolean | null
          function_name: string
          http_status: number | null
          id: string
          institution_id: string | null
          limit_requests: number | null
          limit_tokens: number | null
          max_retries: number | null
          model: string | null
          prompt_key: string | null
          remaining_requests: number | null
          remaining_tokens: number | null
          reset_requests: string | null
          reset_tokens: string | null
          retry_attempt: number | null
          total_retry_time_ms: number | null
          trace_id: string | null
          user_id: string | null
        }
        Insert: {
          course_id?: string | null
          created_at?: string
          delay_before_retry_ms?: number | null
          error_message?: string | null
          event_type: Database["public"]["Enums"]["rate_limit_event_type"]
          eventual_success?: boolean | null
          function_name: string
          http_status?: number | null
          id?: string
          institution_id?: string | null
          limit_requests?: number | null
          limit_tokens?: number | null
          max_retries?: number | null
          model?: string | null
          prompt_key?: string | null
          remaining_requests?: number | null
          remaining_tokens?: number | null
          reset_requests?: string | null
          reset_tokens?: string | null
          retry_attempt?: number | null
          total_retry_time_ms?: number | null
          trace_id?: string | null
          user_id?: string | null
        }
        Update: {
          course_id?: string | null
          created_at?: string
          delay_before_retry_ms?: number | null
          error_message?: string | null
          event_type?: Database["public"]["Enums"]["rate_limit_event_type"]
          eventual_success?: boolean | null
          function_name?: string
          http_status?: number | null
          id?: string
          institution_id?: string | null
          limit_requests?: number | null
          limit_tokens?: number | null
          max_retries?: number | null
          model?: string | null
          prompt_key?: string | null
          remaining_requests?: number | null
          remaining_tokens?: number | null
          reset_requests?: string | null
          reset_tokens?: string | null
          retry_attempt?: number | null
          total_retry_time_ms?: number | null
          trace_id?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ai_rate_limit_events_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_rate_limit_events_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_usage_logs: {
        Row: {
          api_latency_ms: number | null
          attempt_number: number | null
          background_mode: boolean | null
          course_id: string | null
          created_at: string
          error_message: string | null
          feature: string | null
          file_count: number | null
          function_name: string
          http_status: number | null
          id: string
          input_tokens: number
          input_tokens_cached: number | null
          institution_id: string | null
          model: string
          model_requested: string | null
          model_tier: string | null
          outcome: string | null
          output_tokens: number
          output_tokens_reasoning: number | null
          policy_key: string | null
          policy_version: number | null
          poll_wait_ms: number | null
          prompt_id: string | null
          prompt_key: string | null
          prompt_version: string | null
          reasoning_effort: string | null
          response_id: string | null
          response_time_ms: number | null
          status: string | null
          total_tokens: number
          trace_id: string | null
          user_id: string | null
        }
        Insert: {
          api_latency_ms?: number | null
          attempt_number?: number | null
          background_mode?: boolean | null
          course_id?: string | null
          created_at?: string
          error_message?: string | null
          feature?: string | null
          file_count?: number | null
          function_name: string
          http_status?: number | null
          id?: string
          input_tokens?: number
          input_tokens_cached?: number | null
          institution_id?: string | null
          model: string
          model_requested?: string | null
          model_tier?: string | null
          outcome?: string | null
          output_tokens?: number
          output_tokens_reasoning?: number | null
          policy_key?: string | null
          policy_version?: number | null
          poll_wait_ms?: number | null
          prompt_id?: string | null
          prompt_key?: string | null
          prompt_version?: string | null
          reasoning_effort?: string | null
          response_id?: string | null
          response_time_ms?: number | null
          status?: string | null
          total_tokens?: number
          trace_id?: string | null
          user_id?: string | null
        }
        Update: {
          api_latency_ms?: number | null
          attempt_number?: number | null
          background_mode?: boolean | null
          course_id?: string | null
          created_at?: string
          error_message?: string | null
          feature?: string | null
          file_count?: number | null
          function_name?: string
          http_status?: number | null
          id?: string
          input_tokens?: number
          input_tokens_cached?: number | null
          institution_id?: string | null
          model?: string
          model_requested?: string | null
          model_tier?: string | null
          outcome?: string | null
          output_tokens?: number
          output_tokens_reasoning?: number | null
          policy_key?: string | null
          policy_version?: number | null
          poll_wait_ms?: number | null
          prompt_id?: string | null
          prompt_key?: string | null
          prompt_version?: string | null
          reasoning_effort?: string | null
          response_id?: string | null
          response_time_ms?: number | null
          status?: string | null
          total_tokens?: number
          trace_id?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ai_usage_logs_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_usage_logs_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
        ]
      }
      announcement_offerings: {
        Row: {
          announcement_id: string
          created_at: string
          offering_id: string
        }
        Insert: {
          announcement_id: string
          created_at?: string
          offering_id: string
        }
        Update: {
          announcement_id?: string
          created_at?: string
          offering_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "announcement_offerings_announcement_id_fkey"
            columns: ["announcement_id"]
            isOneToOne: false
            referencedRelation: "class_announcements"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "announcement_offerings_offering_id_fkey"
            columns: ["offering_id"]
            isOneToOne: false
            referencedRelation: "offerings"
            referencedColumns: ["id"]
          },
        ]
      }
      announcement_reads: {
        Row: {
          announcement_id: string
          read_at: string
          user_id: string
        }
        Insert: {
          announcement_id: string
          read_at?: string
          user_id: string
        }
        Update: {
          announcement_id?: string
          read_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "announcement_reads_announcement_id_fkey"
            columns: ["announcement_id"]
            isOneToOne: false
            referencedRelation: "class_announcements"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_logs: {
        Row: {
          action: string
          actor_email: string | null
          actor_user_id: string | null
          created_at: string
          id: string
          institution_id: string | null
          metadata: Json
          target_entity_id: string | null
          target_entity_type: string | null
          target_user_id: string | null
        }
        Insert: {
          action: string
          actor_email?: string | null
          actor_user_id?: string | null
          created_at?: string
          id?: string
          institution_id?: string | null
          metadata?: Json
          target_entity_id?: string | null
          target_entity_type?: string | null
          target_user_id?: string | null
        }
        Update: {
          action?: string
          actor_email?: string | null
          actor_user_id?: string | null
          created_at?: string
          id?: string
          institution_id?: string | null
          metadata?: Json
          target_entity_id?: string | null
          target_entity_type?: string | null
          target_user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_logs_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
        ]
      }
      bug_reports: {
        Row: {
          created_at: string
          description: string
          id: string
          institution_id: string | null
          os: string | null
          page_url: string | null
          reporter_email: string | null
          reporter_id: string | null
          reporter_role: string | null
          screenshot_paths: string[]
          status: string
          title: string
          updated_at: string
          user_agent: string | null
          viewport: string | null
        }
        Insert: {
          created_at?: string
          description: string
          id?: string
          institution_id?: string | null
          os?: string | null
          page_url?: string | null
          reporter_email?: string | null
          reporter_id?: string | null
          reporter_role?: string | null
          screenshot_paths?: string[]
          status?: string
          title: string
          updated_at?: string
          user_agent?: string | null
          viewport?: string | null
        }
        Update: {
          created_at?: string
          description?: string
          id?: string
          institution_id?: string | null
          os?: string | null
          page_url?: string | null
          reporter_email?: string | null
          reporter_id?: string | null
          reporter_role?: string | null
          screenshot_paths?: string[]
          status?: string
          title?: string
          updated_at?: string
          user_agent?: string | null
          viewport?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "bug_reports_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
        ]
      }
      chat_messages: {
        Row: {
          content: string
          created_at: string
          flagged_offensive: boolean | null
          id: string
          in_reply_to: string | null
          role: string
          sender_user_id: string | null
          session_id: string
        }
        Insert: {
          content: string
          created_at?: string
          flagged_offensive?: boolean | null
          id?: string
          in_reply_to?: string | null
          role: string
          sender_user_id?: string | null
          session_id: string
        }
        Update: {
          content?: string
          created_at?: string
          flagged_offensive?: boolean | null
          id?: string
          in_reply_to?: string | null
          role?: string
          sender_user_id?: string | null
          session_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "chat_messages_in_reply_to_fkey"
            columns: ["in_reply_to"]
            isOneToOne: false
            referencedRelation: "chat_messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "chat_messages_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "chat_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      chat_session_state: {
        Row: {
          created_at: string
          current_state: Json
          id: string
          schema_version: number
          session_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          current_state?: Json
          id?: string
          schema_version?: number
          session_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          current_state?: Json
          id?: string
          schema_version?: number
          session_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "chat_session_state_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: true
            referencedRelation: "chat_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      chat_sessions: {
        Row: {
          completed_at: string | null
          course_id: string
          created_at: string
          id: string
          last_instructor_message_at: string | null
          offering_id: string | null
          open_question_id: string | null
          pause_reason: string | null
          started_at: string | null
          status: string
          study_session_id: string | null
          subject_kind: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          completed_at?: string | null
          course_id: string
          created_at?: string
          id?: string
          last_instructor_message_at?: string | null
          offering_id?: string | null
          open_question_id?: string | null
          pause_reason?: string | null
          started_at?: string | null
          status?: string
          study_session_id?: string | null
          subject_kind?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          completed_at?: string | null
          course_id?: string
          created_at?: string
          id?: string
          last_instructor_message_at?: string | null
          offering_id?: string | null
          open_question_id?: string | null
          pause_reason?: string | null
          started_at?: string | null
          status?: string
          study_session_id?: string | null
          subject_kind?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "chat_sessions_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "chat_sessions_offering_id_fkey"
            columns: ["offering_id"]
            isOneToOne: false
            referencedRelation: "offerings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "chat_sessions_open_question_id_fkey"
            columns: ["open_question_id"]
            isOneToOne: false
            referencedRelation: "questions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "chat_sessions_study_session_id_fkey"
            columns: ["study_session_id"]
            isOneToOne: false
            referencedRelation: "study_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      chat_state_history: {
        Row: {
          created_at: string
          id: string
          llm_confidence: number | null
          llm_decision: string | null
          llm_judgement: string | null
          session_id: string
          state_after: Json
          state_before: Json | null
          transition_type: string
          trigger_message_id: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          llm_confidence?: number | null
          llm_decision?: string | null
          llm_judgement?: string | null
          session_id: string
          state_after: Json
          state_before?: Json | null
          transition_type: string
          trigger_message_id?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          llm_confidence?: number | null
          llm_decision?: string | null
          llm_judgement?: string | null
          session_id?: string
          state_after?: Json
          state_before?: Json | null
          transition_type?: string
          trigger_message_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "chat_state_history_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "chat_sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "chat_state_history_trigger_message_id_fkey"
            columns: ["trigger_message_id"]
            isOneToOne: false
            referencedRelation: "chat_messages"
            referencedColumns: ["id"]
          },
        ]
      }
      class_announcements: {
        Row: {
          author_id: string | null
          body: string
          course_id: string
          created_at: string
          expires_at: string | null
          id: string
          title: string
          updated_at: string
        }
        Insert: {
          author_id?: string | null
          body: string
          course_id: string
          created_at?: string
          expires_at?: string | null
          id?: string
          title: string
          updated_at?: string
        }
        Update: {
          author_id?: string | null
          body?: string
          course_id?: string
          created_at?: string
          expires_at?: string | null
          id?: string
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "class_announcements_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
        ]
      }
      class_enrollments: {
        Row: {
          class_id: string
          enrolled_at: string | null
          role: string
          user_id: string
        }
        Insert: {
          class_id: string
          enrolled_at?: string | null
          role: string
          user_id: string
        }
        Update: {
          class_id?: string
          enrolled_at?: string | null
          role?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "class_enrollments_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
        ]
      }
      classes: {
        Row: {
          academic_period: string | null
          allow_self_enrollment: boolean
          category: string | null
          created_at: string | null
          created_by: string | null
          grade_level_id: string | null
          id: string
          institution_id: string
          is_active: boolean | null
          name: string
          section_name: string | null
          updated_at: string | null
        }
        Insert: {
          academic_period?: string | null
          allow_self_enrollment?: boolean
          category?: string | null
          created_at?: string | null
          created_by?: string | null
          grade_level_id?: string | null
          id?: string
          institution_id: string
          is_active?: boolean | null
          name: string
          section_name?: string | null
          updated_at?: string | null
        }
        Update: {
          academic_period?: string | null
          allow_self_enrollment?: boolean
          category?: string | null
          created_at?: string | null
          created_by?: string | null
          grade_level_id?: string | null
          id?: string
          institution_id?: string
          is_active?: boolean | null
          name?: string
          section_name?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "classes_grade_level_id_fkey"
            columns: ["grade_level_id"]
            isOneToOne: false
            referencedRelation: "grade_levels"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "classes_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
        ]
      }
      competency_chapters: {
        Row: {
          chapter_id: string
          competency_id: string
          created_at: string
          id: string
        }
        Insert: {
          chapter_id: string
          competency_id: string
          created_at?: string
          id?: string
        }
        Update: {
          chapter_id?: string
          competency_id?: string
          created_at?: string
          id?: string
        }
        Relationships: [
          {
            foreignKeyName: "competency_chapters_chapter_id_fkey"
            columns: ["chapter_id"]
            isOneToOne: false
            referencedRelation: "material_chapters"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "competency_chapters_competency_id_fkey"
            columns: ["competency_id"]
            isOneToOne: false
            referencedRelation: "course_competencies"
            referencedColumns: ["id"]
          },
        ]
      }
      copilot_sessions: {
        Row: {
          course_id: string
          created_at: string
          id: string
          messages: Json
          name: string
          updated_at: string
          user_id: string
        }
        Insert: {
          course_id: string
          created_at?: string
          id?: string
          messages?: Json
          name: string
          updated_at?: string
          user_id: string
        }
        Update: {
          course_id?: string
          created_at?: string
          id?: string
          messages?: Json
          name?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "copilot_sessions_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
        ]
      }
      course_chapter_progress: {
        Row: {
          chapter_id: string
          class_id: string | null
          completed_at: string | null
          completed_by: string | null
          course_id: string
          created_at: string
          id: string
          is_complete: boolean
          updated_at: string
        }
        Insert: {
          chapter_id: string
          class_id?: string | null
          completed_at?: string | null
          completed_by?: string | null
          course_id: string
          created_at?: string
          id?: string
          is_complete?: boolean
          updated_at?: string
        }
        Update: {
          chapter_id?: string
          class_id?: string | null
          completed_at?: string | null
          completed_by?: string | null
          course_id?: string
          created_at?: string
          id?: string
          is_complete?: boolean
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "course_chapter_progress_chapter_id_fkey"
            columns: ["chapter_id"]
            isOneToOne: false
            referencedRelation: "material_chapters"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "course_chapter_progress_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "course_chapter_progress_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
        ]
      }
      course_competencies: {
        Row: {
          chapter_id: string | null
          course_id: string
          created_at: string
          description: string | null
          id: string
          material_id: string | null
          order_num: number
          title: string
          updated_at: string
        }
        Insert: {
          chapter_id?: string | null
          course_id: string
          created_at?: string
          description?: string | null
          id?: string
          material_id?: string | null
          order_num?: number
          title: string
          updated_at?: string
        }
        Update: {
          chapter_id?: string | null
          course_id?: string
          created_at?: string
          description?: string | null
          id?: string
          material_id?: string | null
          order_num?: number
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "course_competencies_chapter_id_fkey"
            columns: ["chapter_id"]
            isOneToOne: false
            referencedRelation: "material_chapters"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "course_competencies_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "course_competencies_material_id_fkey"
            columns: ["material_id"]
            isOneToOne: false
            referencedRelation: "course_materials"
            referencedColumns: ["id"]
          },
        ]
      }
      course_evaluators: {
        Row: {
          assigned_at: string
          course_id: string
          user_id: string
        }
        Insert: {
          assigned_at?: string
          course_id: string
          user_id: string
        }
        Update: {
          assigned_at?: string
          course_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "course_evaluators_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
        ]
      }
      course_exercise_pdfs: {
        Row: {
          course_id: string
          created_at: string
          description: string | null
          file_name: string
          file_url: string
          id: string
          title: string
          uploaded_by: string | null
        }
        Insert: {
          course_id: string
          created_at?: string
          description?: string | null
          file_name: string
          file_url: string
          id?: string
          title: string
          uploaded_by?: string | null
        }
        Update: {
          course_id?: string
          created_at?: string
          description?: string | null
          file_name?: string
          file_url?: string
          id?: string
          title?: string
          uploaded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "course_exercise_pdfs_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
        ]
      }
      course_instructor_sections: {
        Row: {
          assigned_at: string | null
          class_id: string
          course_id: string
          user_id: string
        }
        Insert: {
          assigned_at?: string | null
          class_id: string
          course_id: string
          user_id: string
        }
        Update: {
          assigned_at?: string | null
          class_id?: string
          course_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "course_instructor_sections_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "course_instructor_sections_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_course_instructor_sections_instructor"
            columns: ["course_id", "user_id"]
            isOneToOne: false
            referencedRelation: "course_instructors"
            referencedColumns: ["course_id", "user_id"]
          },
        ]
      }
      course_instructors: {
        Row: {
          assigned_at: string
          course_id: string
          user_id: string
        }
        Insert: {
          assigned_at?: string
          course_id: string
          user_id: string
        }
        Update: {
          assigned_at?: string
          course_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "course_instructors_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
        ]
      }
      course_materials: {
        Row: {
          ai_description: string | null
          author: string | null
          course_id: string
          created_at: string
          description: string | null
          file_name: string
          file_size: number | null
          file_url: string
          google_file_uploaded_at: string | null
          google_file_uri: string | null
          id: string
          is_moderated: boolean | null
          material_type: string
          moderation_status: string
          openai_file_id: string | null
          page_count: number | null
          thumbnail_url: string | null
          title: string | null
          updated_at: string
          uploaded_by: string | null
          year: number | null
        }
        Insert: {
          ai_description?: string | null
          author?: string | null
          course_id: string
          created_at?: string
          description?: string | null
          file_name: string
          file_size?: number | null
          file_url: string
          google_file_uploaded_at?: string | null
          google_file_uri?: string | null
          id?: string
          is_moderated?: boolean | null
          material_type?: string
          moderation_status?: string
          openai_file_id?: string | null
          page_count?: number | null
          thumbnail_url?: string | null
          title?: string | null
          updated_at?: string
          uploaded_by?: string | null
          year?: number | null
        }
        Update: {
          ai_description?: string | null
          author?: string | null
          course_id?: string
          created_at?: string
          description?: string | null
          file_name?: string
          file_size?: number | null
          file_url?: string
          google_file_uploaded_at?: string | null
          google_file_uri?: string | null
          id?: string
          is_moderated?: boolean | null
          material_type?: string
          moderation_status?: string
          openai_file_id?: string | null
          page_count?: number | null
          thumbnail_url?: string | null
          title?: string | null
          updated_at?: string
          uploaded_by?: string | null
          year?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "course_materials_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
        ]
      }
      course_note_offerings: {
        Row: {
          created_at: string
          note_id: string
          offering_id: string
        }
        Insert: {
          created_at?: string
          note_id: string
          offering_id: string
        }
        Update: {
          created_at?: string
          note_id?: string
          offering_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "course_note_offerings_note_id_fkey"
            columns: ["note_id"]
            isOneToOne: false
            referencedRelation: "course_notes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "course_note_offerings_offering_id_fkey"
            columns: ["offering_id"]
            isOneToOne: false
            referencedRelation: "offerings"
            referencedColumns: ["id"]
          },
        ]
      }
      course_notes: {
        Row: {
          author_id: string | null
          course_id: string
          created_at: string
          description: string | null
          file_name: string
          file_path: string
          file_size: number
          id: string
          mime_type: string
          title: string
          updated_at: string
        }
        Insert: {
          author_id?: string | null
          course_id: string
          created_at?: string
          description?: string | null
          file_name: string
          file_path: string
          file_size: number
          id?: string
          mime_type: string
          title: string
          updated_at?: string
        }
        Update: {
          author_id?: string | null
          course_id?: string
          created_at?: string
          description?: string | null
          file_name?: string
          file_path?: string
          file_size?: number
          id?: string
          mime_type?: string
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "course_notes_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
        ]
      }
      courses: {
        Row: {
          category: string
          cover_image_url: string | null
          created_at: string
          created_by: string | null
          description: string | null
          grade_level_id: string | null
          id: string
          institution_id: string
          language: string | null
          leaderboard_enabled: boolean
          restrict_to_completed_chapters: boolean
          show_difficulty_to_students: boolean
          student_generation_instructions: string | null
          student_questions_enabled: boolean
          textbook_chat_enabled: boolean
          theme: string | null
          title: string
          updated_at: string
        }
        Insert: {
          category?: string
          cover_image_url?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          grade_level_id?: string | null
          id?: string
          institution_id: string
          language?: string | null
          leaderboard_enabled?: boolean
          restrict_to_completed_chapters?: boolean
          show_difficulty_to_students?: boolean
          student_generation_instructions?: string | null
          student_questions_enabled?: boolean
          textbook_chat_enabled?: boolean
          theme?: string | null
          title: string
          updated_at?: string
        }
        Update: {
          category?: string
          cover_image_url?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          grade_level_id?: string | null
          id?: string
          institution_id?: string
          language?: string | null
          leaderboard_enabled?: boolean
          restrict_to_completed_chapters?: boolean
          show_difficulty_to_students?: boolean
          student_generation_instructions?: string | null
          student_questions_enabled?: boolean
          textbook_chat_enabled?: boolean
          theme?: string | null
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "courses_grade_level_id_fkey"
            columns: ["grade_level_id"]
            isOneToOne: false
            referencedRelation: "grade_levels"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "courses_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
        ]
      }
      evaluation_competency_scores: {
        Row: {
          competency_id: string
          created_at: string
          evaluation_id: string
          id: string
          is_manual: boolean
          rationale: string | null
          score: number | null
          updated_at: string
        }
        Insert: {
          competency_id: string
          created_at?: string
          evaluation_id: string
          id?: string
          is_manual?: boolean
          rationale?: string | null
          score?: number | null
          updated_at?: string
        }
        Update: {
          competency_id?: string
          created_at?: string
          evaluation_id?: string
          id?: string
          is_manual?: boolean
          rationale?: string | null
          score?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "evaluation_competency_scores_competency_id_fkey"
            columns: ["competency_id"]
            isOneToOne: false
            referencedRelation: "course_competencies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "evaluation_competency_scores_evaluation_id_fkey"
            columns: ["evaluation_id"]
            isOneToOne: false
            referencedRelation: "student_evaluations"
            referencedColumns: ["id"]
          },
        ]
      }
      evaluation_timeline_cache: {
        Row: {
          areas_for_improvement: string[]
          competency_insights: Json
          course_id: string
          created_at: string
          evaluation_count: number
          generated_at: string
          id: string
          overall_trend: string
          recommendations: string[]
          strengths: string[]
          summary: string
          updated_at: string
          user_id: string
        }
        Insert: {
          areas_for_improvement?: string[]
          competency_insights?: Json
          course_id: string
          created_at?: string
          evaluation_count: number
          generated_at?: string
          id?: string
          overall_trend: string
          recommendations?: string[]
          strengths?: string[]
          summary: string
          updated_at?: string
          user_id: string
        }
        Update: {
          areas_for_improvement?: string[]
          competency_insights?: Json
          course_id?: string
          created_at?: string
          evaluation_count?: number
          generated_at?: string
          id?: string
          overall_trend?: string
          recommendations?: string[]
          strengths?: string[]
          summary?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "evaluation_timeline_cache_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
        ]
      }
      failed_login_attempts: {
        Row: {
          attempted_at: string
          email_attempted: string | null
          id: string
          institution_id: string | null
          ip_address: string | null
          reason: string
          user_agent: string | null
          user_id: string | null
        }
        Insert: {
          attempted_at?: string
          email_attempted?: string | null
          id?: string
          institution_id?: string | null
          ip_address?: string | null
          reason: string
          user_agent?: string | null
          user_id?: string | null
        }
        Update: {
          attempted_at?: string
          email_attempted?: string | null
          id?: string
          institution_id?: string | null
          ip_address?: string | null
          reason?: string
          user_agent?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "failed_login_attempts_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
        ]
      }
      flagged_content: {
        Row: {
          created_at: string
          data: Json
          description: string
          id: string
        }
        Insert: {
          created_at?: string
          data: Json
          description: string
          id?: string
        }
        Update: {
          created_at?: string
          data?: Json
          description?: string
          id?: string
        }
        Relationships: []
      }
      flashcard_reviews: {
        Row: {
          chapter_id: string
          course_id: string
          created_at: string
          due_date: string
          ease_factor: number
          flashcard_index: number
          id: string
          interval_days: number
          last_reviewed: string | null
          repetitions: number
          updated_at: string
          user_id: string
        }
        Insert: {
          chapter_id: string
          course_id: string
          created_at?: string
          due_date?: string
          ease_factor?: number
          flashcard_index: number
          id?: string
          interval_days?: number
          last_reviewed?: string | null
          repetitions?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          chapter_id?: string
          course_id?: string
          created_at?: string
          due_date?: string
          ease_factor?: number
          flashcard_index?: number
          id?: string
          interval_days?: number
          last_reviewed?: string | null
          repetitions?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "flashcard_reviews_chapter_id_fkey"
            columns: ["chapter_id"]
            isOneToOne: false
            referencedRelation: "material_chapters"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "flashcard_reviews_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
        ]
      }
      flashcard_sessions: {
        Row: {
          cards_per_session: number
          chapter_ids: string[]
          course_id: string
          created_at: string
          id: string
          is_visible: boolean
          name: string
          offering_id: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          cards_per_session?: number
          chapter_ids: string[]
          course_id: string
          created_at?: string
          id?: string
          is_visible?: boolean
          name: string
          offering_id?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          cards_per_session?: number
          chapter_ids?: string[]
          course_id?: string
          created_at?: string
          id?: string
          is_visible?: boolean
          name?: string
          offering_id?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "flashcard_sessions_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "flashcard_sessions_offering_id_fkey"
            columns: ["offering_id"]
            isOneToOne: false
            referencedRelation: "offerings"
            referencedColumns: ["id"]
          },
        ]
      }
      grade_levels: {
        Row: {
          code: string
          created_at: string
          id: string
          institution_id: string
          is_generic: boolean
          label_el: string
          label_en: string
          ordinal: number
          school_level: string | null
        }
        Insert: {
          code: string
          created_at?: string
          id?: string
          institution_id: string
          is_generic?: boolean
          label_el: string
          label_en: string
          ordinal: number
          school_level?: string | null
        }
        Update: {
          code?: string
          created_at?: string
          id?: string
          institution_id?: string
          is_generic?: boolean
          label_el?: string
          label_en?: string
          ordinal?: number
          school_level?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "grade_levels_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
        ]
      }
      graded_test_questions: {
        Row: {
          ai_feedback: string | null
          awarded_points: number | null
          bounding_box: Json | null
          created_at: string
          expected_answer: string | null
          graded_test_id: string
          id: string
          instructor_feedback: string | null
          max_points: number
          page_number: number | null
          question_number: number
          question_text: string | null
          student_answer: string | null
          updated_at: string
        }
        Insert: {
          ai_feedback?: string | null
          awarded_points?: number | null
          bounding_box?: Json | null
          created_at?: string
          expected_answer?: string | null
          graded_test_id: string
          id?: string
          instructor_feedback?: string | null
          max_points?: number
          page_number?: number | null
          question_number: number
          question_text?: string | null
          student_answer?: string | null
          updated_at?: string
        }
        Update: {
          ai_feedback?: string | null
          awarded_points?: number | null
          bounding_box?: Json | null
          created_at?: string
          expected_answer?: string | null
          graded_test_id?: string
          id?: string
          instructor_feedback?: string | null
          max_points?: number
          page_number?: number | null
          question_number?: number
          question_text?: string | null
          student_answer?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "graded_test_questions_graded_test_id_fkey"
            columns: ["graded_test_id"]
            isOneToOne: false
            referencedRelation: "graded_tests"
            referencedColumns: ["id"]
          },
        ]
      }
      graded_tests: {
        Row: {
          answer_key: string | null
          course_id: string
          created_at: string
          created_by: string | null
          feedback: string | null
          file_type: string
          graded_at: string | null
          graded_by: string | null
          graded_pdf_url: string | null
          grading_criteria: string | null
          id: string
          ocr_pages: Json | null
          ocr_text: string | null
          original_file_name: string
          original_file_url: string
          status: string
          student_id: string | null
          student_name: string | null
          title: string
          total_points: number | null
          total_score: number | null
          updated_at: string
        }
        Insert: {
          answer_key?: string | null
          course_id: string
          created_at?: string
          created_by?: string | null
          feedback?: string | null
          file_type: string
          graded_at?: string | null
          graded_by?: string | null
          graded_pdf_url?: string | null
          grading_criteria?: string | null
          id?: string
          ocr_pages?: Json | null
          ocr_text?: string | null
          original_file_name: string
          original_file_url: string
          status?: string
          student_id?: string | null
          student_name?: string | null
          title: string
          total_points?: number | null
          total_score?: number | null
          updated_at?: string
        }
        Update: {
          answer_key?: string | null
          course_id?: string
          created_at?: string
          created_by?: string | null
          feedback?: string | null
          file_type?: string
          graded_at?: string | null
          graded_by?: string | null
          graded_pdf_url?: string | null
          grading_criteria?: string | null
          id?: string
          ocr_pages?: Json | null
          ocr_text?: string | null
          original_file_name?: string
          original_file_url?: string
          status?: string
          student_id?: string | null
          student_name?: string | null
          title?: string
          total_points?: number | null
          total_score?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "graded_tests_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
        ]
      }
      institutions: {
        Row: {
          academic_period: string | null
          ai_features_disabled: Json
          allow_self_enrollment: boolean
          country: string | null
          created_at: string
          default_language: string
          description: string | null
          id: string
          institution_type: string
          is_public: boolean
          logo_url: string | null
          name: string
          openai_store_enabled: boolean
          school_levels: string[]
          slug: string
          updated_at: string
          vector_store_id: string | null
        }
        Insert: {
          academic_period?: string | null
          ai_features_disabled?: Json
          allow_self_enrollment?: boolean
          country?: string | null
          created_at?: string
          default_language?: string
          description?: string | null
          id?: string
          institution_type?: string
          is_public?: boolean
          logo_url?: string | null
          name: string
          openai_store_enabled?: boolean
          school_levels?: string[]
          slug: string
          updated_at?: string
          vector_store_id?: string | null
        }
        Update: {
          academic_period?: string | null
          ai_features_disabled?: Json
          allow_self_enrollment?: boolean
          country?: string | null
          created_at?: string
          default_language?: string
          description?: string | null
          id?: string
          institution_type?: string
          is_public?: boolean
          logo_url?: string | null
          name?: string
          openai_store_enabled?: boolean
          school_levels?: string[]
          slug?: string
          updated_at?: string
          vector_store_id?: string | null
        }
        Relationships: []
      }
      invitation_courses: {
        Row: {
          course_id: string
          invitation_id: string
        }
        Insert: {
          course_id: string
          invitation_id: string
        }
        Update: {
          course_id?: string
          invitation_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "invitation_courses_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invitation_courses_invitation_id_fkey"
            columns: ["invitation_id"]
            isOneToOne: false
            referencedRelation: "invitations"
            referencedColumns: ["id"]
          },
        ]
      }
      invitations: {
        Row: {
          accepted_at: string | null
          course_id: string | null
          created_at: string
          email: string
          id: string
          institution_id: string
          invited_by: string | null
          invited_class_id: string | null
          invited_grade_level_id: string | null
          invited_name: string | null
          role: string
          status: string
        }
        Insert: {
          accepted_at?: string | null
          course_id?: string | null
          created_at?: string
          email: string
          id?: string
          institution_id: string
          invited_by?: string | null
          invited_class_id?: string | null
          invited_grade_level_id?: string | null
          invited_name?: string | null
          role?: string
          status?: string
        }
        Update: {
          accepted_at?: string | null
          course_id?: string | null
          created_at?: string
          email?: string
          id?: string
          institution_id?: string
          invited_by?: string | null
          invited_class_id?: string | null
          invited_grade_level_id?: string | null
          invited_name?: string | null
          role?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "invitations_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invitations_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invitations_invited_class_id_fkey"
            columns: ["invited_class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invitations_invited_grade_level_id_fkey"
            columns: ["invited_grade_level_id"]
            isOneToOne: false
            referencedRelation: "grade_levels"
            referencedColumns: ["id"]
          },
        ]
      }
      job_items: {
        Row: {
          attempts: number
          created_at: string
          error: string | null
          id: string
          item_key: string
          item_type: string | null
          job_id: string
          last_heartbeat: string | null
          locked_until: string
          max_attempts: number
          payload: Json
          result: Json
          status: string
          updated_at: string
        }
        Insert: {
          attempts?: number
          created_at?: string
          error?: string | null
          id?: string
          item_key: string
          item_type?: string | null
          job_id: string
          last_heartbeat?: string | null
          locked_until?: string
          max_attempts?: number
          payload?: Json
          result?: Json
          status?: string
          updated_at?: string
        }
        Update: {
          attempts?: number
          created_at?: string
          error?: string | null
          id?: string
          item_key?: string
          item_type?: string | null
          job_id?: string
          last_heartbeat?: string | null
          locked_until?: string
          max_attempts?: number
          payload?: Json
          result?: Json
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "job_items_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      jobs: {
        Row: {
          course_id: string | null
          created_at: string
          created_by: string | null
          ended_at: string | null
          error: string | null
          id: string
          institution_id: string
          last_heartbeat: string | null
          locked_until: string
          params: Json
          progress: Json
          result: Json
          started_at: string | null
          status: string
          type: string
        }
        Insert: {
          course_id?: string | null
          created_at?: string
          created_by?: string | null
          ended_at?: string | null
          error?: string | null
          id?: string
          institution_id: string
          last_heartbeat?: string | null
          locked_until?: string
          params?: Json
          progress?: Json
          result?: Json
          started_at?: string | null
          status?: string
          type: string
        }
        Update: {
          course_id?: string | null
          created_at?: string
          created_by?: string | null
          ended_at?: string | null
          error?: string | null
          id?: string
          institution_id?: string
          last_heartbeat?: string | null
          locked_until?: string
          params?: Json
          progress?: Json
          result?: Json
          started_at?: string | null
          status?: string
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "jobs_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jobs_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
        ]
      }
      login_history: {
        Row: {
          id: string
          ip_address: string | null
          login_at: string
          user_agent: string | null
          user_id: string
        }
        Insert: {
          id?: string
          ip_address?: string | null
          login_at?: string
          user_agent?: string | null
          user_id: string
        }
        Update: {
          id?: string
          ip_address?: string | null
          login_at?: string
          user_agent?: string | null
          user_id?: string
        }
        Relationships: []
      }
      material_chapters: {
        Row: {
          chapter_number: number
          cheat_sheet: string | null
          cheat_sheet_visible: boolean
          content: string | null
          content_type: string
          created_at: string
          file_name: string | null
          file_url: string | null
          flashcards: Json | null
          flashcards_visible: boolean
          id: string
          instructions: string | null
          material_id: string
          openai_file_id: string | null
          title: string
          updated_at: string
        }
        Insert: {
          chapter_number: number
          cheat_sheet?: string | null
          cheat_sheet_visible?: boolean
          content?: string | null
          content_type: string
          created_at?: string
          file_name?: string | null
          file_url?: string | null
          flashcards?: Json | null
          flashcards_visible?: boolean
          id?: string
          instructions?: string | null
          material_id: string
          openai_file_id?: string | null
          title: string
          updated_at?: string
        }
        Update: {
          chapter_number?: number
          cheat_sheet?: string | null
          cheat_sheet_visible?: boolean
          content?: string | null
          content_type?: string
          created_at?: string
          file_name?: string | null
          file_url?: string | null
          flashcards?: Json | null
          flashcards_visible?: boolean
          id?: string
          instructions?: string | null
          material_id?: string
          openai_file_id?: string | null
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "material_chapters_material_id_fkey"
            columns: ["material_id"]
            isOneToOne: false
            referencedRelation: "course_materials"
            referencedColumns: ["id"]
          },
        ]
      }
      notifications: {
        Row: {
          body: string | null
          created_at: string
          id: string
          job_id: string | null
          read_at: string | null
          title: string
          type: string
          user_id: string
        }
        Insert: {
          body?: string | null
          created_at?: string
          id?: string
          job_id?: string | null
          read_at?: string | null
          title: string
          type: string
          user_id: string
        }
        Update: {
          body?: string | null
          created_at?: string
          id?: string
          job_id?: string | null
          read_at?: string | null
          title?: string
          type?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "notifications_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      offering_chapter_cheatsheets: {
        Row: {
          chapter_id: string
          created_at: string
          group_id: string | null
          id: string
          offering_id: string
          published_at: string | null
          updated_at: string
        }
        Insert: {
          chapter_id: string
          created_at?: string
          group_id?: string | null
          id?: string
          offering_id: string
          published_at?: string | null
          updated_at?: string
        }
        Update: {
          chapter_id?: string
          created_at?: string
          group_id?: string | null
          id?: string
          offering_id?: string
          published_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "offering_chapter_cheatsheets_chapter_id_fkey"
            columns: ["chapter_id"]
            isOneToOne: false
            referencedRelation: "material_chapters"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "offering_chapter_cheatsheets_group_id_offering_fkey"
            columns: ["group_id", "offering_id"]
            isOneToOne: false
            referencedRelation: "offering_groups"
            referencedColumns: ["id", "offering_id"]
          },
          {
            foreignKeyName: "offering_chapter_cheatsheets_offering_id_fkey"
            columns: ["offering_id"]
            isOneToOne: false
            referencedRelation: "offerings"
            referencedColumns: ["id"]
          },
        ]
      }
      offering_chapter_flashcards: {
        Row: {
          chapter_id: string
          created_at: string
          group_id: string | null
          id: string
          offering_id: string
          published_at: string | null
          updated_at: string
        }
        Insert: {
          chapter_id: string
          created_at?: string
          group_id?: string | null
          id?: string
          offering_id: string
          published_at?: string | null
          updated_at?: string
        }
        Update: {
          chapter_id?: string
          created_at?: string
          group_id?: string | null
          id?: string
          offering_id?: string
          published_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "offering_chapter_flashcards_chapter_id_fkey"
            columns: ["chapter_id"]
            isOneToOne: false
            referencedRelation: "material_chapters"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "offering_chapter_flashcards_group_id_offering_fkey"
            columns: ["group_id", "offering_id"]
            isOneToOne: false
            referencedRelation: "offering_groups"
            referencedColumns: ["id", "offering_id"]
          },
          {
            foreignKeyName: "offering_chapter_flashcards_offering_id_fkey"
            columns: ["offering_id"]
            isOneToOne: false
            referencedRelation: "offerings"
            referencedColumns: ["id"]
          },
        ]
      }
      offering_flashcard_sessions: {
        Row: {
          created_at: string
          flashcard_session_id: string
          id: string
          offering_id: string
          published_at: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          flashcard_session_id: string
          id?: string
          offering_id: string
          published_at?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          flashcard_session_id?: string
          id?: string
          offering_id?: string
          published_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "offering_flashcard_sessions_flashcard_session_id_fkey"
            columns: ["flashcard_session_id"]
            isOneToOne: false
            referencedRelation: "flashcard_sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "offering_flashcard_sessions_offering_id_fkey"
            columns: ["offering_id"]
            isOneToOne: false
            referencedRelation: "offerings"
            referencedColumns: ["id"]
          },
        ]
      }
      offering_group_members: {
        Row: {
          added_at: string
          added_by: string | null
          group_id: string
          user_id: string
        }
        Insert: {
          added_at?: string
          added_by?: string | null
          group_id: string
          user_id: string
        }
        Update: {
          added_at?: string
          added_by?: string | null
          group_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "offering_group_members_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "offering_groups"
            referencedColumns: ["id"]
          },
        ]
      }
      offering_groups: {
        Row: {
          created_at: string
          created_by: string | null
          description: string | null
          id: string
          is_individual: boolean
          name: string
          offering_id: string
          owner_user_id: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          is_individual?: boolean
          name: string
          offering_id: string
          owner_user_id?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          is_individual?: boolean
          name?: string
          offering_id?: string
          owner_user_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "offering_groups_offering_id_fkey"
            columns: ["offering_id"]
            isOneToOne: false
            referencedRelation: "offerings"
            referencedColumns: ["id"]
          },
        ]
      }
      offering_questions: {
        Row: {
          created_at: string
          group_id: string | null
          id: string
          offering_id: string
          published_at: string | null
          question_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          group_id?: string | null
          id?: string
          offering_id: string
          published_at?: string | null
          question_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          group_id?: string | null
          id?: string
          offering_id?: string
          published_at?: string | null
          question_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "offering_questions_group_id_offering_fkey"
            columns: ["group_id", "offering_id"]
            isOneToOne: false
            referencedRelation: "offering_groups"
            referencedColumns: ["id", "offering_id"]
          },
          {
            foreignKeyName: "offering_questions_offering_id_fkey"
            columns: ["offering_id"]
            isOneToOne: false
            referencedRelation: "offerings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "offering_questions_question_id_fkey"
            columns: ["question_id"]
            isOneToOne: false
            referencedRelation: "questions"
            referencedColumns: ["id"]
          },
        ]
      }
      offering_quizzes: {
        Row: {
          answers_released: boolean
          closed_at: string | null
          created_at: string | null
          due_date: string | null
          group_id: string | null
          id: string
          offering_id: string
          published_at: string | null
          quiz_id: string
          time_limit_override: number | null
          updated_at: string | null
        }
        Insert: {
          answers_released?: boolean
          closed_at?: string | null
          created_at?: string | null
          due_date?: string | null
          group_id?: string | null
          id?: string
          offering_id: string
          published_at?: string | null
          quiz_id: string
          time_limit_override?: number | null
          updated_at?: string | null
        }
        Update: {
          answers_released?: boolean
          closed_at?: string | null
          created_at?: string | null
          due_date?: string | null
          group_id?: string | null
          id?: string
          offering_id?: string
          published_at?: string | null
          quiz_id?: string
          time_limit_override?: number | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "offering_quizzes_group_id_offering_fkey"
            columns: ["group_id", "offering_id"]
            isOneToOne: false
            referencedRelation: "offering_groups"
            referencedColumns: ["id", "offering_id"]
          },
          {
            foreignKeyName: "offering_quizzes_offering_id_fkey"
            columns: ["offering_id"]
            isOneToOne: false
            referencedRelation: "offerings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "offering_quizzes_quiz_id_fkey"
            columns: ["quiz_id"]
            isOneToOne: false
            referencedRelation: "quizzes"
            referencedColumns: ["id"]
          },
        ]
      }
      offering_study_guides: {
        Row: {
          closed_at: string | null
          created_at: string
          due_date: string | null
          group_id: string | null
          id: string
          offering_id: string
          published_at: string | null
          study_guide_id: string
          updated_at: string
        }
        Insert: {
          closed_at?: string | null
          created_at?: string
          due_date?: string | null
          group_id?: string | null
          id?: string
          offering_id: string
          published_at?: string | null
          study_guide_id: string
          updated_at?: string
        }
        Update: {
          closed_at?: string | null
          created_at?: string
          due_date?: string | null
          group_id?: string | null
          id?: string
          offering_id?: string
          published_at?: string | null
          study_guide_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "offering_study_guides_group_id_offering_fkey"
            columns: ["group_id", "offering_id"]
            isOneToOne: false
            referencedRelation: "offering_groups"
            referencedColumns: ["id", "offering_id"]
          },
          {
            foreignKeyName: "offering_study_guides_offering_id_fkey"
            columns: ["offering_id"]
            isOneToOne: false
            referencedRelation: "offerings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "offering_study_guides_study_guide_id_fkey"
            columns: ["study_guide_id"]
            isOneToOne: false
            referencedRelation: "study_guides"
            referencedColumns: ["id"]
          },
        ]
      }
      offering_study_sessions: {
        Row: {
          created_at: string
          group_id: string | null
          id: string
          offering_id: string
          published_at: string | null
          study_session_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          group_id?: string | null
          id?: string
          offering_id: string
          published_at?: string | null
          study_session_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          group_id?: string | null
          id?: string
          offering_id?: string
          published_at?: string | null
          study_session_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "offering_study_sessions_group_id_offering_fkey"
            columns: ["group_id", "offering_id"]
            isOneToOne: false
            referencedRelation: "offering_groups"
            referencedColumns: ["id", "offering_id"]
          },
          {
            foreignKeyName: "offering_study_sessions_offering_id_fkey"
            columns: ["offering_id"]
            isOneToOne: false
            referencedRelation: "offerings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "offering_study_sessions_study_session_id_fkey"
            columns: ["study_session_id"]
            isOneToOne: false
            referencedRelation: "study_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      offering_tests: {
        Row: {
          created_at: string
          due_date: string | null
          group_id: string | null
          id: string
          offering_id: string
          published_at: string | null
          test_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          due_date?: string | null
          group_id?: string | null
          id?: string
          offering_id: string
          published_at?: string | null
          test_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          due_date?: string | null
          group_id?: string | null
          id?: string
          offering_id?: string
          published_at?: string | null
          test_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "offering_tests_group_id_offering_fkey"
            columns: ["group_id", "offering_id"]
            isOneToOne: false
            referencedRelation: "offering_groups"
            referencedColumns: ["id", "offering_id"]
          },
          {
            foreignKeyName: "offering_tests_offering_id_fkey"
            columns: ["offering_id"]
            isOneToOne: false
            referencedRelation: "offerings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "offering_tests_test_id_fkey"
            columns: ["test_id"]
            isOneToOne: false
            referencedRelation: "tests"
            referencedColumns: ["id"]
          },
        ]
      }
      offerings: {
        Row: {
          class_id: string
          course_id: string
          created_at: string | null
          end_date: string | null
          id: string
          is_active: boolean | null
          leaderboard_enabled: boolean | null
          start_date: string | null
          updated_at: string | null
        }
        Insert: {
          class_id: string
          course_id: string
          created_at?: string | null
          end_date?: string | null
          id?: string
          is_active?: boolean | null
          leaderboard_enabled?: boolean | null
          start_date?: string | null
          updated_at?: string | null
        }
        Update: {
          class_id?: string
          course_id?: string
          created_at?: string | null
          end_date?: string | null
          id?: string
          is_active?: boolean | null
          leaderboard_enabled?: boolean | null
          start_date?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "offerings_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "offerings_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
        ]
      }
      open_answer_ai_drafts: {
        Row: {
          areas_for_improvement: string[] | null
          course_id: string
          created_at: string
          feedback: string
          id: string
          offering_id: string
          question_id: string
          source: string
          strengths: string[] | null
          user_id: string
        }
        Insert: {
          areas_for_improvement?: string[] | null
          course_id: string
          created_at?: string
          feedback: string
          id?: string
          offering_id: string
          question_id: string
          source: string
          strengths?: string[] | null
          user_id: string
        }
        Update: {
          areas_for_improvement?: string[] | null
          course_id?: string
          created_at?: string
          feedback?: string
          id?: string
          offering_id?: string
          question_id?: string
          source?: string
          strengths?: string[] | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "open_answer_ai_drafts_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "open_answer_ai_drafts_offering_id_fkey"
            columns: ["offering_id"]
            isOneToOne: false
            referencedRelation: "offerings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "open_answer_ai_drafts_question_id_fkey"
            columns: ["question_id"]
            isOneToOne: false
            referencedRelation: "questions"
            referencedColumns: ["id"]
          },
        ]
      }
      open_question_chats: {
        Row: {
          content: string
          course_id: string
          created_at: string
          flagged_offensive: boolean | null
          id: string
          open_question_id: string
          role: string
          sender_user_id: string | null
          user_id: string
        }
        Insert: {
          content: string
          course_id: string
          created_at?: string
          flagged_offensive?: boolean | null
          id?: string
          open_question_id: string
          role: string
          sender_user_id?: string | null
          user_id: string
        }
        Update: {
          content?: string
          course_id?: string
          created_at?: string
          flagged_offensive?: boolean | null
          id?: string
          open_question_id?: string
          role?: string
          sender_user_id?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "open_question_chats_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "open_question_chats_open_question_id_fkey"
            columns: ["open_question_id"]
            isOneToOne: false
            referencedRelation: "questions"
            referencedColumns: ["id"]
          },
        ]
      }
      open_question_grades: {
        Row: {
          areas_for_improvement: string[] | null
          course_id: string
          created_at: string
          feedback: string | null
          gap_results: Json | null
          grade: number | null
          graded_at: string
          id: string
          offering_id: string | null
          open_question_id: string
          strengths: string[] | null
          submitted_answer: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          areas_for_improvement?: string[] | null
          course_id: string
          created_at?: string
          feedback?: string | null
          gap_results?: Json | null
          grade?: number | null
          graded_at?: string
          id?: string
          offering_id?: string | null
          open_question_id: string
          strengths?: string[] | null
          submitted_answer?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          areas_for_improvement?: string[] | null
          course_id?: string
          created_at?: string
          feedback?: string | null
          gap_results?: Json | null
          grade?: number | null
          graded_at?: string
          id?: string
          offering_id?: string | null
          open_question_id?: string
          strengths?: string[] | null
          submitted_answer?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "open_question_grades_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "open_question_grades_offering_id_fkey"
            columns: ["offering_id"]
            isOneToOne: false
            referencedRelation: "offerings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "open_question_grades_open_question_id_fkey"
            columns: ["open_question_id"]
            isOneToOne: false
            referencedRelation: "questions"
            referencedColumns: ["id"]
          },
        ]
      }
      open_question_mode_changes: {
        Row: {
          changed_by: string | null
          course_id: string
          created_at: string
          deleted_counts: Json
          id: string
          new_mode: string
          prior_mode: string
          question_id: string
        }
        Insert: {
          changed_by?: string | null
          course_id: string
          created_at?: string
          deleted_counts?: Json
          id?: string
          new_mode: string
          prior_mode: string
          question_id: string
        }
        Update: {
          changed_by?: string | null
          course_id?: string
          created_at?: string
          deleted_counts?: Json
          id?: string
          new_mode?: string
          prior_mode?: string
          question_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "open_question_mode_changes_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "open_question_mode_changes_question_id_fkey"
            columns: ["question_id"]
            isOneToOne: false
            referencedRelation: "questions"
            referencedColumns: ["id"]
          },
        ]
      }
      open_question_progress: {
        Row: {
          completed_at: string | null
          course_id: string
          created_at: string
          id: string
          offering_id: string | null
          open_question_id: string
          started_at: string | null
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          completed_at?: string | null
          course_id: string
          created_at?: string
          id?: string
          offering_id?: string | null
          open_question_id: string
          started_at?: string | null
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          completed_at?: string | null
          course_id?: string
          created_at?: string
          id?: string
          offering_id?: string | null
          open_question_id?: string
          started_at?: string | null
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "open_question_progress_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "open_question_progress_offering_id_fkey"
            columns: ["offering_id"]
            isOneToOne: false
            referencedRelation: "offerings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "open_question_progress_open_question_id_fkey"
            columns: ["open_question_id"]
            isOneToOne: false
            referencedRelation: "questions"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          created_at: string
          date_of_birth: string | null
          email: string | null
          father_name: string | null
          full_name: string | null
          id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          date_of_birth?: string | null
          email?: string | null
          father_name?: string | null
          full_name?: string | null
          id?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          date_of_birth?: string | null
          email?: string | null
          father_name?: string | null
          full_name?: string | null
          id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      question_chapters: {
        Row: {
          chapter_id: string
          created_at: string
          question_id: string
        }
        Insert: {
          chapter_id: string
          created_at?: string
          question_id: string
        }
        Update: {
          chapter_id?: string
          created_at?: string
          question_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "question_chapters_chapter_id_fkey"
            columns: ["chapter_id"]
            isOneToOne: false
            referencedRelation: "material_chapters"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "question_chapters_question_id_fkey"
            columns: ["question_id"]
            isOneToOne: false
            referencedRelation: "questions"
            referencedColumns: ["id"]
          },
        ]
      }
      question_competencies: {
        Row: {
          competency_id: string
          created_at: string
          id: string
          question_id: string
        }
        Insert: {
          competency_id: string
          created_at?: string
          id?: string
          question_id: string
        }
        Update: {
          competency_id?: string
          created_at?: string
          id?: string
          question_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "question_competencies_competency_id_fkey"
            columns: ["competency_id"]
            isOneToOne: false
            referencedRelation: "course_competencies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "question_competencies_question_id_fkey"
            columns: ["question_id"]
            isOneToOne: false
            referencedRelation: "questions"
            referencedColumns: ["id"]
          },
        ]
      }
      question_evaluation_sessions: {
        Row: {
          course_id: string
          created_at: string
          ended_at: string | null
          evaluator_id: string
          id: string
          overall_quality: number | null
          recurring_problems: string | null
          started_at: string
          would_use: string | null
        }
        Insert: {
          course_id: string
          created_at?: string
          ended_at?: string | null
          evaluator_id: string
          id?: string
          overall_quality?: number | null
          recurring_problems?: string | null
          started_at?: string
          would_use?: string | null
        }
        Update: {
          course_id?: string
          created_at?: string
          ended_at?: string | null
          evaluator_id?: string
          id?: string
          overall_quality?: number | null
          recurring_problems?: string | null
          started_at?: string
          would_use?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "question_evaluation_sessions_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
        ]
      }
      question_evaluations: {
        Row: {
          answer_good: boolean
          clarity: number
          cognitive_level: string | null
          comment: string | null
          created_at: string
          curriculum_alignment: number | null
          difficulty_confirmation: string
          distractor_quality: number | null
          evaluator_id: string
          id: string
          language_appropriateness: number | null
          pedagogical_value: number
          problem_categories: string[]
          question_bank_alignment: number | null
          question_good: boolean
          question_id: string
          session_id: string
          updated_at: string
          verdict: string
          was_sampled: boolean
        }
        Insert: {
          answer_good: boolean
          clarity: number
          cognitive_level?: string | null
          comment?: string | null
          created_at?: string
          curriculum_alignment?: number | null
          difficulty_confirmation: string
          distractor_quality?: number | null
          evaluator_id: string
          id?: string
          language_appropriateness?: number | null
          pedagogical_value: number
          problem_categories?: string[]
          question_bank_alignment?: number | null
          question_good: boolean
          question_id: string
          session_id: string
          updated_at?: string
          verdict: string
          was_sampled?: boolean
        }
        Update: {
          answer_good?: boolean
          clarity?: number
          cognitive_level?: string | null
          comment?: string | null
          created_at?: string
          curriculum_alignment?: number | null
          difficulty_confirmation?: string
          distractor_quality?: number | null
          evaluator_id?: string
          id?: string
          language_appropriateness?: number | null
          pedagogical_value?: number
          problem_categories?: string[]
          question_bank_alignment?: number | null
          question_good?: boolean
          question_id?: string
          session_id?: string
          updated_at?: string
          verdict?: string
          was_sampled?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "question_evaluations_question_id_fkey"
            columns: ["question_id"]
            isOneToOne: false
            referencedRelation: "questions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "question_evaluations_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "question_evaluation_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      question_materials: {
        Row: {
          created_at: string
          material_id: string
          question_id: string
        }
        Insert: {
          created_at?: string
          material_id: string
          question_id: string
        }
        Update: {
          created_at?: string
          material_id?: string
          question_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "question_materials_material_id_fkey"
            columns: ["material_id"]
            isOneToOne: false
            referencedRelation: "course_materials"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "question_materials_question_id_fkey"
            columns: ["question_id"]
            isOneToOne: false
            referencedRelation: "questions"
            referencedColumns: ["id"]
          },
        ]
      }
      question_votes: {
        Row: {
          created_at: string
          id: string
          question_id: string
          user_id: string
          vote_type: string
        }
        Insert: {
          created_at?: string
          id?: string
          question_id: string
          user_id: string
          vote_type: string
        }
        Update: {
          created_at?: string
          id?: string
          question_id?: string
          user_id?: string
          vote_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "question_votes_question_id_fkey"
            columns: ["question_id"]
            isOneToOne: false
            referencedRelation: "questions"
            referencedColumns: ["id"]
          },
        ]
      }
      questions: {
        Row: {
          answer_key: Json
          competency_id: string | null
          course_id: string
          created_at: string
          created_by: string | null
          difficulty: string
          downvotes: number
          explanation: string | null
          generated_for_group_id: string | null
          generation_rationale: string | null
          hidden: boolean
          id: string
          is_user_generated: boolean
          payload: Json
          question: string
          type: string
          updated_at: string
          upvotes: number
          validated_at: string | null
          validation_confidence: number | null
          validation_message: string | null
          validation_status: string | null
        }
        Insert: {
          answer_key?: Json
          competency_id?: string | null
          course_id: string
          created_at?: string
          created_by?: string | null
          difficulty?: string
          downvotes?: number
          explanation?: string | null
          generated_for_group_id?: string | null
          generation_rationale?: string | null
          hidden?: boolean
          id?: string
          is_user_generated?: boolean
          payload?: Json
          question: string
          type?: string
          updated_at?: string
          upvotes?: number
          validated_at?: string | null
          validation_confidence?: number | null
          validation_message?: string | null
          validation_status?: string | null
        }
        Update: {
          answer_key?: Json
          competency_id?: string | null
          course_id?: string
          created_at?: string
          created_by?: string | null
          difficulty?: string
          downvotes?: number
          explanation?: string | null
          generated_for_group_id?: string | null
          generation_rationale?: string | null
          hidden?: boolean
          id?: string
          is_user_generated?: boolean
          payload?: Json
          question?: string
          type?: string
          updated_at?: string
          upvotes?: number
          validated_at?: string | null
          validation_confidence?: number | null
          validation_message?: string | null
          validation_status?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "questions_competency_id_fkey"
            columns: ["competency_id"]
            isOneToOne: false
            referencedRelation: "course_competencies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "questions_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "questions_generated_for_group_id_fkey"
            columns: ["generated_for_group_id"]
            isOneToOne: false
            referencedRelation: "offering_groups"
            referencedColumns: ["id"]
          },
        ]
      }
      quiz_analyses: {
        Row: {
          clusters: Json
          created_at: string
          generated_at: string
          group_id: string | null
          id: string
          low_confidence: boolean
          model: string | null
          offering_id: string
          quiz_id: string
          report: Json
          submission_count: number
          updated_at: string
        }
        Insert: {
          clusters?: Json
          created_at?: string
          generated_at?: string
          group_id?: string | null
          id?: string
          low_confidence?: boolean
          model?: string | null
          offering_id: string
          quiz_id: string
          report: Json
          submission_count?: number
          updated_at?: string
        }
        Update: {
          clusters?: Json
          created_at?: string
          generated_at?: string
          group_id?: string | null
          id?: string
          low_confidence?: boolean
          model?: string | null
          offering_id?: string
          quiz_id?: string
          report?: Json
          submission_count?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "quiz_analyses_group_id_offering_fkey"
            columns: ["group_id", "offering_id"]
            isOneToOne: false
            referencedRelation: "offering_groups"
            referencedColumns: ["id", "offering_id"]
          },
          {
            foreignKeyName: "quiz_analyses_offering_id_fkey"
            columns: ["offering_id"]
            isOneToOne: false
            referencedRelation: "offerings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quiz_analyses_quiz_id_fkey"
            columns: ["quiz_id"]
            isOneToOne: false
            referencedRelation: "quizzes"
            referencedColumns: ["id"]
          },
        ]
      }
      quiz_answers: {
        Row: {
          answered_at: string
          course_id: string
          id: string
          is_correct: boolean
          offering_id: string | null
          question_id: string
          quiz_id: string | null
          selected_answer: number
          session_id: string | null
          submission: Json | null
          user_id: string
        }
        Insert: {
          answered_at?: string
          course_id: string
          id?: string
          is_correct: boolean
          offering_id?: string | null
          question_id: string
          quiz_id?: string | null
          selected_answer: number
          session_id?: string | null
          submission?: Json | null
          user_id: string
        }
        Update: {
          answered_at?: string
          course_id?: string
          id?: string
          is_correct?: boolean
          offering_id?: string | null
          question_id?: string
          quiz_id?: string | null
          selected_answer?: number
          session_id?: string | null
          submission?: Json | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "quiz_answers_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quiz_answers_offering_id_fkey"
            columns: ["offering_id"]
            isOneToOne: false
            referencedRelation: "offerings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quiz_answers_question_id_fkey"
            columns: ["question_id"]
            isOneToOne: false
            referencedRelation: "questions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quiz_answers_quiz_id_fkey"
            columns: ["quiz_id"]
            isOneToOne: false
            referencedRelation: "quizzes"
            referencedColumns: ["id"]
          },
        ]
      }
      quiz_questions: {
        Row: {
          created_at: string
          id: string
          order_num: number
          question_id: string
          quiz_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          order_num?: number
          question_id: string
          quiz_id: string
        }
        Update: {
          created_at?: string
          id?: string
          order_num?: number
          question_id?: string
          quiz_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "quiz_questions_question_id_fkey"
            columns: ["question_id"]
            isOneToOne: false
            referencedRelation: "questions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quiz_questions_quiz_id_fkey"
            columns: ["quiz_id"]
            isOneToOne: false
            referencedRelation: "quizzes"
            referencedColumns: ["id"]
          },
        ]
      }
      quiz_session_questions: {
        Row: {
          created_at: string | null
          id: string
          order_num: number
          question_id: string
          question_snapshot: Json
          session_id: string
        }
        Insert: {
          created_at?: string | null
          id?: string
          order_num: number
          question_id: string
          question_snapshot: Json
          session_id: string
        }
        Update: {
          created_at?: string | null
          id?: string
          order_num?: number
          question_id?: string
          question_snapshot?: Json
          session_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "quiz_session_questions_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "quiz_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      quiz_sessions: {
        Row: {
          completed_at: string | null
          course_id: string
          draft_answers: Json | null
          expired_at: string | null
          id: string
          offering_id: string | null
          quiz_id: string
          started_at: string
          status: string
          user_id: string
        }
        Insert: {
          completed_at?: string | null
          course_id: string
          draft_answers?: Json | null
          expired_at?: string | null
          id?: string
          offering_id?: string | null
          quiz_id: string
          started_at?: string
          status?: string
          user_id: string
        }
        Update: {
          completed_at?: string | null
          course_id?: string
          draft_answers?: Json | null
          expired_at?: string | null
          id?: string
          offering_id?: string | null
          quiz_id?: string
          started_at?: string
          status?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "quiz_sessions_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quiz_sessions_offering_id_fkey"
            columns: ["offering_id"]
            isOneToOne: false
            referencedRelation: "offerings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quiz_sessions_quiz_id_fkey"
            columns: ["quiz_id"]
            isOneToOne: false
            referencedRelation: "quizzes"
            referencedColumns: ["id"]
          },
        ]
      }
      quizzes: {
        Row: {
          course_id: string
          created_at: string
          created_by: string | null
          description: string | null
          id: string
          is_published: boolean
          show_answers: boolean
          time_limit_minutes: number | null
          title: string
          updated_at: string
        }
        Insert: {
          course_id: string
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          is_published?: boolean
          show_answers?: boolean
          time_limit_minutes?: number | null
          title: string
          updated_at?: string
        }
        Update: {
          course_id?: string
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          is_published?: boolean
          show_answers?: boolean
          time_limit_minutes?: number | null
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "quizzes_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
        ]
      }
      retention_purge_runs: {
        Row: {
          backlog_remaining: boolean
          cutoff: string
          error: string | null
          id: string
          ran_at: string
          retention_months: number
          rows_deleted: number
          table_name: string
        }
        Insert: {
          backlog_remaining?: boolean
          cutoff: string
          error?: string | null
          id?: string
          ran_at?: string
          retention_months: number
          rows_deleted: number
          table_name: string
        }
        Update: {
          backlog_remaining?: boolean
          cutoff?: string
          error?: string | null
          id?: string
          ran_at?: string
          retention_months?: number
          rows_deleted?: number
          table_name?: string
        }
        Relationships: []
      }
      rights_requests: {
        Row: {
          closed_at: string | null
          closed_by: string | null
          created_at: string
          created_by: string | null
          details: string | null
          due_at: string
          extended_due_at: string | null
          extension_reason: string | null
          id: string
          institution_id: string
          received_at: string
          request_type: string
          resolution_note: string | null
          status: string
          subject_label: string | null
          subject_user_id: string | null
          updated_at: string
        }
        Insert: {
          closed_at?: string | null
          closed_by?: string | null
          created_at?: string
          created_by?: string | null
          details?: string | null
          due_at?: string
          extended_due_at?: string | null
          extension_reason?: string | null
          id?: string
          institution_id: string
          received_at?: string
          request_type: string
          resolution_note?: string | null
          status?: string
          subject_label?: string | null
          subject_user_id?: string | null
          updated_at?: string
        }
        Update: {
          closed_at?: string | null
          closed_by?: string | null
          created_at?: string
          created_by?: string | null
          details?: string | null
          due_at?: string
          extended_due_at?: string | null
          extension_reason?: string | null
          id?: string
          institution_id?: string
          received_at?: string
          request_type?: string
          resolution_note?: string | null
          status?: string
          subject_label?: string | null
          subject_user_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "rights_requests_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
        ]
      }
      run_jobs_tick: {
        Row: {
          request_id: number
          ticked_at: string
        }
        Insert: {
          request_id: number
          ticked_at?: string
        }
        Update: {
          request_id?: number
          ticked_at?: string
        }
        Relationships: []
      }
      security_policies: {
        Row: {
          key: string
          updated_at: string
          value: Json
        }
        Insert: {
          key: string
          updated_at?: string
          value: Json
        }
        Update: {
          key?: string
          updated_at?: string
          value?: Json
        }
        Relationships: []
      }
      socratic_session_state: {
        Row: {
          course_id: string
          created_at: string
          current_state: Json
          id: string
          open_question_id: string
          schema_version: number
          updated_at: string
          user_id: string
        }
        Insert: {
          course_id: string
          created_at?: string
          current_state?: Json
          id?: string
          open_question_id: string
          schema_version?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          course_id?: string
          created_at?: string
          current_state?: Json
          id?: string
          open_question_id?: string
          schema_version?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "socratic_session_state_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "socratic_session_state_open_question_id_fkey"
            columns: ["open_question_id"]
            isOneToOne: false
            referencedRelation: "questions"
            referencedColumns: ["id"]
          },
        ]
      }
      socratic_state_history: {
        Row: {
          created_at: string
          id: string
          llm_confidence: number | null
          llm_decision: string | null
          llm_judgement: string | null
          session_state_id: string
          state_after: Json
          state_before: Json | null
          transition_type: string
          trigger_message_id: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          llm_confidence?: number | null
          llm_decision?: string | null
          llm_judgement?: string | null
          session_state_id: string
          state_after: Json
          state_before?: Json | null
          transition_type: string
          trigger_message_id?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          llm_confidence?: number | null
          llm_decision?: string | null
          llm_judgement?: string | null
          session_state_id?: string
          state_after?: Json
          state_before?: Json | null
          transition_type?: string
          trigger_message_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "socratic_state_history_session_state_id_fkey"
            columns: ["session_state_id"]
            isOneToOne: false
            referencedRelation: "socratic_session_state"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "socratic_state_history_trigger_message_id_fkey"
            columns: ["trigger_message_id"]
            isOneToOne: false
            referencedRelation: "open_question_chats"
            referencedColumns: ["id"]
          },
        ]
      }
      student_admin_notes: {
        Row: {
          body: string
          created_at: string
          created_by: string | null
          id: string
          institution_id: string
          student_user_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          body: string
          created_at?: string
          created_by?: string | null
          id?: string
          institution_id: string
          student_user_id: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          body?: string
          created_at?: string
          created_by?: string | null
          id?: string
          institution_id?: string
          student_user_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "student_admin_notes_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
        ]
      }
      student_admin_notes_audit: {
        Row: {
          action: string
          actor: string | null
          at: string
          id: string
          institution_id: string
          new_body: string | null
          note_id: string
          prev_body: string | null
          student_user_id: string
        }
        Insert: {
          action: string
          actor?: string | null
          at?: string
          id?: string
          institution_id: string
          new_body?: string | null
          note_id: string
          prev_body?: string | null
          student_user_id: string
        }
        Update: {
          action?: string
          actor?: string | null
          at?: string
          id?: string
          institution_id?: string
          new_body?: string | null
          note_id?: string
          prev_body?: string | null
          student_user_id?: string
        }
        Relationships: []
      }
      student_evaluations: {
        Row: {
          course_id: string
          created_at: string
          generated_at: string
          id: string
          instructor_feedback: string | null
          is_manual: boolean
          offering_id: string | null
          overall_assessment: string | null
          recommendations: string[] | null
          stats: Json | null
          strengths: string[] | null
          student_name: string | null
          updated_at: string
          user_id: string
          weaknesses: string[] | null
        }
        Insert: {
          course_id: string
          created_at?: string
          generated_at?: string
          id?: string
          instructor_feedback?: string | null
          is_manual?: boolean
          offering_id?: string | null
          overall_assessment?: string | null
          recommendations?: string[] | null
          stats?: Json | null
          strengths?: string[] | null
          student_name?: string | null
          updated_at?: string
          user_id: string
          weaknesses?: string[] | null
        }
        Update: {
          course_id?: string
          created_at?: string
          generated_at?: string
          id?: string
          instructor_feedback?: string | null
          is_manual?: boolean
          offering_id?: string | null
          overall_assessment?: string | null
          recommendations?: string[] | null
          stats?: Json | null
          strengths?: string[] | null
          student_name?: string | null
          updated_at?: string
          user_id?: string
          weaknesses?: string[] | null
        }
        Relationships: [
          {
            foreignKeyName: "student_evaluations_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "student_evaluations_offering_id_fkey"
            columns: ["offering_id"]
            isOneToOne: false
            referencedRelation: "offerings"
            referencedColumns: ["id"]
          },
        ]
      }
      student_study_progress: {
        Row: {
          completed_at: string | null
          course_id: string
          created_at: string
          id: string
          offering_id: string | null
          started_at: string | null
          status: string
          study_session_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          completed_at?: string | null
          course_id: string
          created_at?: string
          id?: string
          offering_id?: string | null
          started_at?: string | null
          status?: string
          study_session_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          completed_at?: string | null
          course_id?: string
          created_at?: string
          id?: string
          offering_id?: string | null
          started_at?: string | null
          status?: string
          study_session_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "student_study_progress_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "student_study_progress_offering_id_fkey"
            columns: ["offering_id"]
            isOneToOne: false
            referencedRelation: "offerings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "student_study_progress_study_session_id_fkey"
            columns: ["study_session_id"]
            isOneToOne: false
            referencedRelation: "study_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      study_guide_analyses: {
        Row: {
          clusters: Json
          created_at: string
          generated_at: string
          group_id: string | null
          id: string
          low_confidence: boolean
          model: string | null
          offering_id: string
          report: Json
          study_guide_id: string
          submission_count: number
          updated_at: string
        }
        Insert: {
          clusters?: Json
          created_at?: string
          generated_at?: string
          group_id?: string | null
          id?: string
          low_confidence?: boolean
          model?: string | null
          offering_id: string
          report: Json
          study_guide_id: string
          submission_count?: number
          updated_at?: string
        }
        Update: {
          clusters?: Json
          created_at?: string
          generated_at?: string
          group_id?: string | null
          id?: string
          low_confidence?: boolean
          model?: string | null
          offering_id?: string
          report?: Json
          study_guide_id?: string
          submission_count?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "study_guide_analyses_group_id_offering_fkey"
            columns: ["group_id", "offering_id"]
            isOneToOne: false
            referencedRelation: "offering_groups"
            referencedColumns: ["id", "offering_id"]
          },
          {
            foreignKeyName: "study_guide_analyses_offering_id_fkey"
            columns: ["offering_id"]
            isOneToOne: false
            referencedRelation: "offerings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "study_guide_analyses_study_guide_id_fkey"
            columns: ["study_guide_id"]
            isOneToOne: false
            referencedRelation: "study_guides"
            referencedColumns: ["id"]
          },
        ]
      }
      study_guide_answers: {
        Row: {
          areas_for_improvement: string[] | null
          created_at: string
          feedback: string | null
          grade: number | null
          graded_at: string | null
          id: string
          is_correct: boolean | null
          offering_id: string
          piece_id: string
          question_id: string
          strengths: string[] | null
          study_guide_id: string
          submission: Json
          submitted_at: string
          user_id: string
        }
        Insert: {
          areas_for_improvement?: string[] | null
          created_at?: string
          feedback?: string | null
          grade?: number | null
          graded_at?: string | null
          id?: string
          is_correct?: boolean | null
          offering_id: string
          piece_id: string
          question_id: string
          strengths?: string[] | null
          study_guide_id: string
          submission?: Json
          submitted_at?: string
          user_id: string
        }
        Update: {
          areas_for_improvement?: string[] | null
          created_at?: string
          feedback?: string | null
          grade?: number | null
          graded_at?: string | null
          id?: string
          is_correct?: boolean | null
          offering_id?: string
          piece_id?: string
          question_id?: string
          strengths?: string[] | null
          study_guide_id?: string
          submission?: Json
          submitted_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "study_guide_answers_offering_id_fkey"
            columns: ["offering_id"]
            isOneToOne: false
            referencedRelation: "offerings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "study_guide_answers_piece_id_fkey"
            columns: ["piece_id"]
            isOneToOne: false
            referencedRelation: "study_guide_pieces"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "study_guide_answers_question_id_fkey"
            columns: ["question_id"]
            isOneToOne: false
            referencedRelation: "questions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "study_guide_answers_study_guide_id_fkey"
            columns: ["study_guide_id"]
            isOneToOne: false
            referencedRelation: "study_guides"
            referencedColumns: ["id"]
          },
        ]
      }
      study_guide_piece_questions: {
        Row: {
          created_at: string
          piece_id: string
          position: number
          question_id: string
        }
        Insert: {
          created_at?: string
          piece_id: string
          position?: number
          question_id: string
        }
        Update: {
          created_at?: string
          piece_id?: string
          position?: number
          question_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "study_guide_piece_questions_piece_id_fkey"
            columns: ["piece_id"]
            isOneToOne: false
            referencedRelation: "study_guide_pieces"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "study_guide_piece_questions_question_id_fkey"
            columns: ["question_id"]
            isOneToOne: false
            referencedRelation: "questions"
            referencedColumns: ["id"]
          },
        ]
      }
      study_guide_pieces: {
        Row: {
          created_at: string
          id: string
          position: number
          questions_generated_at: string | null
          study_guide_id: string
          theory_html: string | null
          theory_updated_at: string | null
          title: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          position: number
          questions_generated_at?: string | null
          study_guide_id: string
          theory_html?: string | null
          theory_updated_at?: string | null
          title: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          position?: number
          questions_generated_at?: string | null
          study_guide_id?: string
          theory_html?: string | null
          theory_updated_at?: string | null
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "study_guide_pieces_study_guide_id_fkey"
            columns: ["study_guide_id"]
            isOneToOne: false
            referencedRelation: "study_guides"
            referencedColumns: ["id"]
          },
        ]
      }
      study_guide_progress: {
        Row: {
          completed_at: string | null
          created_at: string
          current_piece_position: number
          draft_answers: Json | null
          id: string
          offering_id: string
          started_at: string
          study_guide_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          current_piece_position?: number
          draft_answers?: Json | null
          id?: string
          offering_id: string
          started_at?: string
          study_guide_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          current_piece_position?: number
          draft_answers?: Json | null
          id?: string
          offering_id?: string
          started_at?: string
          study_guide_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "study_guide_progress_offering_id_fkey"
            columns: ["offering_id"]
            isOneToOne: false
            referencedRelation: "offerings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "study_guide_progress_study_guide_id_fkey"
            columns: ["study_guide_id"]
            isOneToOne: false
            referencedRelation: "study_guides"
            referencedColumns: ["id"]
          },
        ]
      }
      study_guide_source_chapters: {
        Row: {
          chapter_id: string
          created_at: string
          study_guide_id: string
        }
        Insert: {
          chapter_id: string
          created_at?: string
          study_guide_id: string
        }
        Update: {
          chapter_id?: string
          created_at?: string
          study_guide_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "study_guide_source_chapters_chapter_id_fkey"
            columns: ["chapter_id"]
            isOneToOne: false
            referencedRelation: "material_chapters"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "study_guide_source_chapters_study_guide_id_fkey"
            columns: ["study_guide_id"]
            isOneToOne: false
            referencedRelation: "study_guides"
            referencedColumns: ["id"]
          },
        ]
      }
      study_guides: {
        Row: {
          brief: string | null
          course_id: string
          created_at: string
          created_by: string | null
          id: string
          material_id: string | null
          target_piece_count: number
          target_questions_per_piece: number
          title: string
          updated_at: string
        }
        Insert: {
          brief?: string | null
          course_id: string
          created_at?: string
          created_by?: string | null
          id?: string
          material_id?: string | null
          target_piece_count?: number
          target_questions_per_piece?: number
          title: string
          updated_at?: string
        }
        Update: {
          brief?: string | null
          course_id?: string
          created_at?: string
          created_by?: string | null
          id?: string
          material_id?: string | null
          target_piece_count?: number
          target_questions_per_piece?: number
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "study_guides_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "study_guides_material_id_fkey"
            columns: ["material_id"]
            isOneToOne: false
            referencedRelation: "course_materials"
            referencedColumns: ["id"]
          },
        ]
      }
      study_session_competencies: {
        Row: {
          competency_id: string
          created_at: string
          id: string
          study_session_id: string
        }
        Insert: {
          competency_id: string
          created_at?: string
          id?: string
          study_session_id: string
        }
        Update: {
          competency_id?: string
          created_at?: string
          id?: string
          study_session_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "study_session_competencies_competency_id_fkey"
            columns: ["competency_id"]
            isOneToOne: false
            referencedRelation: "course_competencies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "study_session_competencies_study_session_id_fkey"
            columns: ["study_session_id"]
            isOneToOne: false
            referencedRelation: "study_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      study_session_messages: {
        Row: {
          content: string
          created_at: string
          id: string
          progress_id: string
          role: string
          sender_user_id: string | null
        }
        Insert: {
          content: string
          created_at?: string
          id?: string
          progress_id: string
          role: string
          sender_user_id?: string | null
        }
        Update: {
          content?: string
          created_at?: string
          id?: string
          progress_id?: string
          role?: string
          sender_user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "study_session_messages_progress_id_fkey"
            columns: ["progress_id"]
            isOneToOne: false
            referencedRelation: "student_study_progress"
            referencedColumns: ["id"]
          },
        ]
      }
      study_sessions: {
        Row: {
          allow_image_generation: boolean | null
          chapter_id: string | null
          chapter_ids: string[] | null
          course_id: string
          created_at: string
          created_by: string | null
          extracted_content: string | null
          id: string
          instructions: string | null
          llm_message: string | null
          llm_status: string | null
          material_id: string | null
          page_end: number | null
          page_start: number | null
          reference_images: Json | null
          status: string
          student_notes: string | null
          title: string
          topic: string | null
          updated_at: string
        }
        Insert: {
          allow_image_generation?: boolean | null
          chapter_id?: string | null
          chapter_ids?: string[] | null
          course_id: string
          created_at?: string
          created_by?: string | null
          extracted_content?: string | null
          id?: string
          instructions?: string | null
          llm_message?: string | null
          llm_status?: string | null
          material_id?: string | null
          page_end?: number | null
          page_start?: number | null
          reference_images?: Json | null
          status?: string
          student_notes?: string | null
          title: string
          topic?: string | null
          updated_at?: string
        }
        Update: {
          allow_image_generation?: boolean | null
          chapter_id?: string | null
          chapter_ids?: string[] | null
          course_id?: string
          created_at?: string
          created_by?: string | null
          extracted_content?: string | null
          id?: string
          instructions?: string | null
          llm_message?: string | null
          llm_status?: string | null
          material_id?: string | null
          page_end?: number | null
          page_start?: number | null
          reference_images?: Json | null
          status?: string
          student_notes?: string | null
          title?: string
          topic?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "study_sessions_chapter_id_fkey"
            columns: ["chapter_id"]
            isOneToOne: false
            referencedRelation: "material_chapters"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "study_sessions_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "study_sessions_material_id_fkey"
            columns: ["material_id"]
            isOneToOne: false
            referencedRelation: "course_materials"
            referencedColumns: ["id"]
          },
        ]
      }
      study_tutor_session_state: {
        Row: {
          course_id: string
          created_at: string
          current_state: Json
          id: string
          progress_id: string
          schema_version: number
          updated_at: string
          user_id: string
        }
        Insert: {
          course_id: string
          created_at?: string
          current_state?: Json
          id?: string
          progress_id: string
          schema_version?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          course_id?: string
          created_at?: string
          current_state?: Json
          id?: string
          progress_id?: string
          schema_version?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "study_tutor_session_state_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "study_tutor_session_state_progress_id_fkey"
            columns: ["progress_id"]
            isOneToOne: false
            referencedRelation: "student_study_progress"
            referencedColumns: ["id"]
          },
        ]
      }
      study_tutor_state_history: {
        Row: {
          created_at: string
          id: string
          message_id: string | null
          session_state_id: string
          state_after: Json
          state_before: Json | null
          transition_type: string
        }
        Insert: {
          created_at?: string
          id?: string
          message_id?: string | null
          session_state_id: string
          state_after: Json
          state_before?: Json | null
          transition_type: string
        }
        Update: {
          created_at?: string
          id?: string
          message_id?: string | null
          session_state_id?: string
          state_after?: Json
          state_before?: Json | null
          transition_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "study_tutor_state_history_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "study_session_messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "study_tutor_state_history_session_state_id_fkey"
            columns: ["session_state_id"]
            isOneToOne: false
            referencedRelation: "study_tutor_session_state"
            referencedColumns: ["id"]
          },
        ]
      }
      super_admins: {
        Row: {
          created_at: string
          email: string
          id: string
        }
        Insert: {
          created_at?: string
          email: string
          id?: string
        }
        Update: {
          created_at?: string
          email?: string
          id?: string
        }
        Relationships: []
      }
      system_config: {
        Row: {
          created_at: string | null
          description: string | null
          id: string
          key: string
          updated_at: string | null
          updated_by: string | null
          value: Json
        }
        Insert: {
          created_at?: string | null
          description?: string | null
          id?: string
          key: string
          updated_at?: string | null
          updated_by?: string | null
          value?: Json
        }
        Update: {
          created_at?: string | null
          description?: string | null
          id?: string
          key?: string
          updated_at?: string | null
          updated_by?: string | null
          value?: Json
        }
        Relationships: []
      }
      test_questions: {
        Row: {
          created_at: string
          id: string
          order_num: number
          points: number
          question_id: string
          test_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          order_num?: number
          points?: number
          question_id: string
          test_id: string
        }
        Update: {
          created_at?: string
          id?: string
          order_num?: number
          points?: number
          question_id?: string
          test_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "test_questions_question_id_fkey"
            columns: ["question_id"]
            isOneToOne: false
            referencedRelation: "questions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "test_questions_test_id_fkey"
            columns: ["test_id"]
            isOneToOne: false
            referencedRelation: "tests"
            referencedColumns: ["id"]
          },
        ]
      }
      tests: {
        Row: {
          course_id: string
          created_at: string
          created_by: string | null
          custom_header: string | null
          description: string | null
          html_content: string | null
          html_updated_at: string | null
          id: string
          is_published: boolean
          title: string
          updated_at: string
        }
        Insert: {
          course_id: string
          created_at?: string
          created_by?: string | null
          custom_header?: string | null
          description?: string | null
          html_content?: string | null
          html_updated_at?: string | null
          id?: string
          is_published?: boolean
          title: string
          updated_at?: string
        }
        Update: {
          course_id?: string
          created_at?: string
          created_by?: string | null
          custom_header?: string | null
          description?: string | null
          html_content?: string | null
          html_updated_at?: string | null
          id?: string
          is_published?: boolean
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tests_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
        ]
      }
      textbook_chat_messages: {
        Row: {
          content: string
          course_id: string
          created_at: string
          id: string
          material_id: string
          role: string
          session_id: string
          session_name: string | null
          user_id: string
        }
        Insert: {
          content: string
          course_id: string
          created_at?: string
          id?: string
          material_id: string
          role: string
          session_id?: string
          session_name?: string | null
          user_id: string
        }
        Update: {
          content?: string
          course_id?: string
          created_at?: string
          id?: string
          material_id?: string
          role?: string
          session_id?: string
          session_name?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "textbook_chat_messages_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "textbook_chat_messages_material_id_fkey"
            columns: ["material_id"]
            isOneToOne: false
            referencedRelation: "course_materials"
            referencedColumns: ["id"]
          },
        ]
      }
      user_institution_grades: {
        Row: {
          created_at: string
          grade_level_id: string
          id: string
          user_institution_id: string
        }
        Insert: {
          created_at?: string
          grade_level_id: string
          id?: string
          user_institution_id: string
        }
        Update: {
          created_at?: string
          grade_level_id?: string
          id?: string
          user_institution_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_institution_grades_grade_level_id_fkey"
            columns: ["grade_level_id"]
            isOneToOne: false
            referencedRelation: "grade_levels"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_institution_grades_user_institution_id_fkey"
            columns: ["user_institution_id"]
            isOneToOne: false
            referencedRelation: "user_institutions"
            referencedColumns: ["id"]
          },
        ]
      }
      user_institutions: {
        Row: {
          created_at: string
          grade_level_id: string | null
          id: string
          institution_id: string
          is_suspended: boolean
          role: string
          user_id: string
        }
        Insert: {
          created_at?: string
          grade_level_id?: string | null
          id?: string
          institution_id: string
          is_suspended?: boolean
          role?: string
          user_id: string
        }
        Update: {
          created_at?: string
          grade_level_id?: string | null
          id?: string
          institution_id?: string
          is_suspended?: boolean
          role?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_institutions_grade_level_id_fkey"
            columns: ["grade_level_id"]
            isOneToOne: false
            referencedRelation: "grade_levels"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_institutions_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      question_vote_stats: {
        Row: {
          downvote_count: number | null
          question_id: string | null
          upvote_count: number | null
        }
        Relationships: [
          {
            foreignKeyName: "question_votes_question_id_fkey"
            columns: ["question_id"]
            isOneToOne: false
            referencedRelation: "questions"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      admin_mfa_mandate_active: { Args: never; Returns: boolean }
      can_author_content: { Args: { uid: string }; Returns: boolean }
      can_manage_course_notes: {
        Args: { _course_id: string }
        Returns: boolean
      }
      can_manage_offering: { Args: { _offering_id: string }; Returns: boolean }
      can_read_course_note: { Args: { _note_id: string }; Returns: boolean }
      can_read_course_note_file: { Args: { _path: string }; Returns: boolean }
      can_vote_on_question: { Args: { _question_id: string }; Returns: boolean }
      clear_study_guide_pieces: {
        Args: { _study_guide_id: string }
        Returns: {
          deleted_pieces: number
          deleted_questions: number
        }[]
      }
      course_notes_path_course_id: { Args: { _name: string }; Returns: string }
      delete_study_guide: {
        Args: { _study_guide_id: string }
        Returns: undefined
      }
      delete_study_guide_piece: {
        Args: { _piece_id: string }
        Returns: undefined
      }
      delete_study_guide_question: {
        Args: { _question_id: string }
        Returns: undefined
      }
      ensure_greek_grade_levels: {
        Args: { inst_id: string }
        Returns: undefined
      }
      erase_user_unlinked_data: {
        Args: { _email?: string; _user_id: string }
        Returns: Json
      }
      find_erasure_name_matches: {
        Args: { _name: string }
        Returns: {
          course_id: string
          created_at: string
          linked_user_id: string
          row_id: string
          source_table: string
          student_name: string
        }[]
      }
      fix_null_auth_fields: { Args: never; Returns: undefined }
      get_jobs_cron_health: { Args: never; Returns: Json }
      get_pending_invitation: {
        Args: { _email: string; _token: string }
        Returns: {
          email: string
          id: string
          institution_id: string
          institution_name: string
          invited_name: string
          role: string
        }[]
      }
      get_question_vote_counts: {
        Args: { p_question_id: string }
        Returns: {
          downvotes: number
          upvotes: number
        }[]
      }
      get_retention_months: { Args: { _table_name: string }; Returns: number }
      get_user_auth_info: {
        Args: { _user_id: string }
        Returns: {
          auth_created_at: string
          last_sign_in_at: string
        }[]
      }
      get_user_display_name: { Args: { _user_id: string }; Returns: string }
      get_user_institution_id: { Args: { _user_id: string }; Returns: string }
      get_user_institution_ids: {
        Args: { _user_id: string }
        Returns: string[]
      }
      get_user_role_in_institution: {
        Args: { _institution_id: string; _user_id: string }
        Returns: string
      }
      has_offering_access: { Args: { _offering_id: string }; Returns: boolean }
      instructor_can_access_graded_test_scan: {
        Args: { _object_name: string; _user_id: string }
        Returns: boolean
      }
      instructor_can_access_section: {
        Args: { _class_id: string; _course_id: string; _user_id: string }
        Returns: boolean
      }
      instructor_can_access_student: {
        Args: { _course_id: string; _student_id: string; _user_id: string }
        Returns: boolean
      }
      instructor_can_access_student_work: {
        Args: {
          _course_id: string
          _offering_id: string
          _student_id: string
          _user_id: string
        }
        Returns: boolean
      }
      instructor_can_write_student_work: {
        Args: {
          _course_id: string
          _offering_id: string
          _student_id: string
          _user_id: string
        }
        Returns: boolean
      }
      instructor_teaches_student: {
        Args: { _institution_id: string; _student_id: string }
        Returns: boolean
      }
      invitation_shares_my_institution: {
        Args: { _invitation_id: string }
        Returns: boolean
      }
      is_admin: { Args: { _user_id: string }; Returns: boolean }
      is_chapterless_material_type: {
        Args: { _material_type: string }
        Returns: boolean
      }
      is_class_instructor: { Args: { _class_id: string }; Returns: boolean }
      is_class_member: { Args: { _class_id: string }; Returns: boolean }
      is_course_evaluator: {
        Args: { _course_id: string; _user_id: string }
        Returns: boolean
      }
      is_course_instructor: {
        Args: { _course_id: string; _user_id: string }
        Returns: boolean
      }
      is_institution_admin: {
        Args: { _institution_id: string; _user_id: string }
        Returns: boolean
      }
      is_institution_instructor: {
        Args: { _user_id: string }
        Returns: boolean
      }
      is_institution_instructor_for_course: {
        Args: { _course_id: string; _user_id: string }
        Returns: boolean
      }
      is_offering_group_member: {
        Args: { _group_id: string }
        Returns: boolean
      }
      is_super_admin: { Args: { _user_id: string }; Returns: boolean }
      list_exportable_tables: { Args: never; Returns: string[] }
      mark_offering_quiz_done: {
        Args: { p_offering_quiz_id: string }
        Returns: string
      }
      mfa_enrollment_status: { Args: never; Returns: Json }
      mfa_policy: { Args: never; Returns: Json }
      mfa_policy_effective: { Args: never; Returns: Json }
      mfa_role_enforced_now: { Args: { _role: string }; Returns: boolean }
      mfa_role_in_policy: { Args: { _role: string }; Returns: boolean }
      mfa_role_state: { Args: { _user_id: string }; Returns: string }
      mfa_satisfied: { Args: never; Returns: boolean }
      mfa_user_deadline: { Args: { _user_id: string }; Returns: string }
      mfa_user_roles: { Args: { _user_id: string }; Returns: string[] }
      move_study_guide_piece: {
        Args: { _direction: string; _piece_id: string }
        Returns: undefined
      }
      normalize_person_name: { Args: { _raw: string }; Returns: string }
      persist_chat_turn: {
        Args: {
          _content: string
          _in_reply_to?: string
          _llm_confidence?: number
          _llm_decision?: string
          _llm_judgement?: string
          _session_id: string
          _state: Json
          _state_before?: Json
          _transition_type: string
        }
        Returns: string
      }
      purge_expired_operational_logs: {
        Args: { _batch_cap?: number }
        Returns: {
          cutoff_at: string
          deleted_count: number
          purged_table: string
        }[]
      }
      questions_mcq_correct_indices_valid: {
        Args: { p_answer_key: Json; p_payload: Json }
        Returns: boolean
      }
      quiz_answers_submission_valid: {
        Args: { p_submission: Json }
        Returns: boolean
      }
      record_quiz_answers: {
        Args: {
          _answers: Json
          _course_id: string
          _finalize?: boolean
          _offering_id: string
          _quiz_id: string
          _session_id: string
          _user_id: string
        }
        Returns: {
          is_correct: boolean
          question_id: string
          recorded_now: boolean
        }[]
      }
      reopen_offering_quiz: {
        Args: { p_offering_quiz_id: string }
        Returns: undefined
      }
      reopen_study_guide: {
        Args: { _study_guide_id: string }
        Returns: undefined
      }
      replace_study_guide_outline: {
        Args: { _pieces: Json; _study_guide_id: string }
        Returns: {
          created_at: string
          id: string
          position: number
          questions_generated_at: string | null
          study_guide_id: string
          theory_html: string | null
          theory_updated_at: string | null
          title: string
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "study_guide_pieces"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      replace_study_guide_piece_questions: {
        Args: {
          _course_id: string
          _created_by: string
          _piece_id: string
          _questions: Json
        }
        Returns: string[]
      }
      reset_open_question_progress: {
        Args: { _question_id: string }
        Returns: Json
      }
      set_institution_membership_role: {
        Args: { _institution_id: string; _role?: string; _user_id: string }
        Returns: undefined
      }
      shares_course_management: { Args: { _target: string }; Returns: boolean }
      student_may_attribute_to_offering: {
        Args: { _course_id: string; _offering_id: string; _student_id: string }
        Returns: boolean
      }
      study_guide_assigned_in_offering: {
        Args: { _offering_id: string; _study_guide_id: string }
        Returns: boolean
      }
      study_guide_published_to_user: {
        Args: { _study_guide_id: string }
        Returns: boolean
      }
      study_guide_startable_in_offering: {
        Args: { _offering_id: string; _study_guide_id: string }
        Returns: boolean
      }
      submit_study_guide_piece_answers: {
        Args: {
          _answers: Json
          _is_final: boolean
          _offering_id: string
          _piece_id: string
          _piece_position: number
          _study_guide_id: string
          _user_id: string
        }
        Returns: {
          completed_at: string
          current_piece_position: number
        }[]
      }
      super_admin_member: { Args: { _user_id: string }; Returns: boolean }
      tick_run_jobs: { Args: never; Returns: number }
      update_question_content: {
        Args: {
          _answer_key: Json
          _difficulty: string
          _explanation: string
          _payload: Json
          _question: string
          _question_id: string
        }
        Returns: undefined
      }
      upsert_vault_secret: {
        Args: { p_name: string; p_secret: string }
        Returns: string
      }
      user_belongs_to_institution: {
        Args: { _institution_id: string; _user_id: string }
        Returns: boolean
      }
      user_can_access_course: {
        Args: { _course_id: string; _user_id: string }
        Returns: boolean
      }
      user_data_footprint: {
        Args: { _email?: string; _name?: string; _user_id: string }
        Returns: {
          match_kind: string
          row_count: number
          source_column: string
          source_table: string
        }[]
      }
      user_has_any_course_tag: {
        Args: { _course_id: string; _user_id: string }
        Returns: boolean
      }
      user_has_class_course_access: {
        Args: { _course_id: string; _user_id: string }
        Returns: boolean
      }
      user_reference_map: {
        Args: never
        Returns: {
          col: string
          fk_action: string
          kind: string
          note: string
          tbl: string
        }[]
      }
    }
    Enums: {
      rate_limit_event_type: "warning" | "throttled" | "exhausted"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      rate_limit_event_type: ["warning", "throttled", "exhausted"],
    },
  },
} as const

