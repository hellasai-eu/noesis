-- Add example_file_ids column to prompt_defaults
ALTER TABLE prompt_defaults ADD COLUMN example_file_ids text[] DEFAULT '{}';

-- Add example_file_ids column to institution_prompts
ALTER TABLE institution_prompts ADD COLUMN example_file_ids text[] DEFAULT '{}';