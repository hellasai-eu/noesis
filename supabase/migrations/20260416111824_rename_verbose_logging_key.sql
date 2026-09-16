-- Rename the system_config key so one toggle governs all agent functions
UPDATE public.system_config
SET key = 'agent_verbose_logging',
    description = 'Enable verbose logging of agent interactions (ta-agent-qa, socratic-chat, study-tutor)'
WHERE key = 'ta_agent_verbose_logging';
