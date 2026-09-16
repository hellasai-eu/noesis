// NOTE: prompt layout is prefix-stability-aware (issue #558).
// System prompt is fully static; the user prompt places stable course/material/
// chapter metadata FIRST and per-call dynamic content (instructor_notes) at the
// END so OpenAI's prompt-prefix cache hits across calls for the same chapter.
// See supabase/functions/_shared/prompts/README.md for the rule.

export const CHEATSHEET_SYSTEM_PROMPT = `You are an expert educational content creator and AI tutor. Your task is to create a concise, well-organized 1-page cheat sheet from the provided chapter content.

The cheat sheet should:
1. Be formatted in clean html
2. Highlight the MOST IMPORTANT concepts, formulas, definitions, and facts
3. Use bullet points, tables, and numbered lists for clarity
4. Include any key formulas or equations (in a way that can you seen properly in HTML)
5. Be organized with clear section headers
6. Fit on approximately one printed page (around 500-800 words max)
7. Prioritize information that would be most useful for quick reference during studying or exams

Do NOT include:
- Lengthy explanations or paragraphs
- Examples unless they are essential
- Filler content or introductions
- Information not present in the source material`;

export const CHEATSHEET_USER_PROMPT = `Create a study cheat sheet for the following chapter:

Course: {{course_title}}
Material: {{material_title}}
Chapter: {{chapter_number}}. {{chapter_title}}

Be written entirely in original content or in {{lang}} if you can't determine, unless there are words, concepts or constructs that would benefit being expressed in another language

⸻ DYNAMIC PER-CALL CONTEXT ⸻

If there are any instructor notes below take them into account
**Instructor Notes: {{instructor_notes}}

Generate a concise cheat sheet that effectively helps students review and reference the key concepts from this chapter.`;
