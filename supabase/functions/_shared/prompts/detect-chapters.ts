export const CHAPTER_DETECTION_PROMPT = `
You extract top-level chapters from the Table of Contents (TOC) of an educational document.

Your goal is to identify ONLY top-level chapters and determine their PDF page ranges as accurately as possible.

---

SCOPE

- Use only the first 25 PDF pages to locate and parse the TOC.
- You may look beyond page 25 ONLY if necessary to verify the true PDF start page of the first chapter.
- Do not use information outside the provided text.
- Do not guess when information is unclear.

---

WHAT TO EXTRACT

Extract ONLY top-level chapters.

Include:
- Main chapters (e.g., "Chapter 1", "Κεφάλαιο 1", "ΜΕΡΟΣ", "Part I")
- Top-level numbering (1, 2, 3 or I, II, III)

Exclude:
- Subsections (e.g., 1.1, 2.3.1, III.2)
- Nested entries under chapters
- Appendices, indexes, glossaries, bibliographies, acknowledgments
  UNLESS they appear at the same hierarchy level as main chapters in the TOC

---

TITLE NORMALIZATION

For each chapter:
- Extract the title exactly as written
- Remove numbering prefixes such as:
  "1.", "Chapter 1", "Κεφάλαιο 1:", "Part I", etc.
- Do NOT translate or rewrite titles
- Preserve the original language and wording

---

PAGE EXTRACTION

From the TOC:
- Extract the starting page number for each chapter
- Estimate the ending page as:
  next_chapter_start_page - 1

---

PDF PAGE CORRECTION (OFFSET)

TOC page numbers often do not match actual PDF pages due to front matter.

To correct:

1. Take the first chapter listed in the TOC
2. Try to find the PDF page where that chapter actually begins
3. If found confidently:
   offset = actual_pdf_page - toc_page_number
   Apply this offset to ALL chapter start pages
4. Recompute end pages after applying the offset

IMPORTANT:
- Only apply an offset if you are confident
- If you cannot confidently determine the real PDF start page, DO NOT guess
- In that case, use TOC page numbers as-is

---

QUALITY RULES

- Return chapters in the order they appear
- Ensure no subsections are included
- Ensure page ranges are consistent (start <= end)
- Ensure all chapters use the same offset logic

---

EDGE CASE

If no top-level chapters are found:
- Return a single chapter titled "ALL"

---

{{special_extraction_instructions}}
`;
