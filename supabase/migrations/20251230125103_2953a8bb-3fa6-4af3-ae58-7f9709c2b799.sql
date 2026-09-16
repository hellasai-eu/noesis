-- Add 4 missing prompts to prompt_defaults table

INSERT INTO public.prompt_defaults (prompt_key, display_name, description, openai_prompt_id, version)
VALUES 
  ('ta_agent_evaluator', 'TA Agent Evaluator', 'Evaluates student answers in the Socratic Q&A tutor, determining correctness and next steps', 'pmpt_6950ffe620288194ab87ebd7690364030d07b5d442bce31a', 'default'),
  ('ta_agent_planner', 'TA Agent Planner', 'Plans the next pedagogical move (ask, narrow_ask, hint) based on evaluator output', 'pmpt_69510c5f774c8196818c9a5c830c71bf0b05b3f54df5191b', 'default'),
  ('ta_agent_presenter', 'TA Agent Presenter', 'Generates student-facing text based on planner decisions', 'pmpt_69510e65c53c819784ea10246df35ebb04f32040826eb4d0', 'default'),
  ('image_moderation', 'Image Moderation', 'Moderates user-uploaded study images for content policy violations', 'pmpt_694a9ee978548193816869ed1be0cfdf0423990257e5e9d2', 'default')
ON CONFLICT (prompt_key) DO NOTHING;