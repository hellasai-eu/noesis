-- Add columns to store full LLM response for study sessions
ALTER TABLE study_sessions 
ADD COLUMN llm_status text,
ADD COLUMN llm_message text;