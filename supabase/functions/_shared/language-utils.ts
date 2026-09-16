// Language code to full name mapping with native instructions
export interface LanguageConfig {
  name: string;
  nativeInstruction: string;
  qualityInstruction?: string;
}

export const GREEK_QUALITY_INSTRUCTION = `GREEK LANGUAGE QUALITY RULES:
- FINAL SIGMA IS MANDATORY: any word that ends in a sigma sound MUST end with the final sigma "ς", never the medial "σ". The medial "σ" may appear ONLY at the start or middle of a word — never as the last letter. Apply this at every word boundary, including immediately before punctuation. Correct: "μαθητής", "σωστές", "ιστορίας", "συνέπειες". Wrong: "μαθητήσ", "σωστέσ", "ιστορίασ", "συνέπειεσ". Re-check the last letter of every word before finalizing your answer.
- Use modern Demotic Greek (Δημοτική). Avoid katharevousa (Καθαρεύουσα) and archaic forms.
- Use natural, contemporary phrasing appropriate for modern Greek high school education.`;

export const LANGUAGE_NAMES: Record<string, LanguageConfig> = {
  en: { name: "English", nativeInstruction: "You MUST respond entirely in English." },
  el: {
    name: "Greek (Ελληνικά)",
    nativeInstruction: "Απάντησε ΜΟΝΟ στα Ελληνικά. Μην χρησιμοποιείς Αγγλικά.",
    qualityInstruction: GREEK_QUALITY_INSTRUCTION,
  },
  es: { name: "Spanish (Español)", nativeInstruction: "Debes responder SOLO en español. No uses inglés." },
  fr: { name: "French (Français)", nativeInstruction: "Vous devez répondre UNIQUEMENT en français. N'utilisez pas l'anglais." },
  de: { name: "German (Deutsch)", nativeInstruction: "Du musst NUR auf Deutsch antworten. Verwende kein Englisch." },
  it: { name: "Italian (Italiano)", nativeInstruction: "Devi rispondere SOLO in italiano. Non usare l'inglese." },
  pt: { name: "Portuguese (Português)", nativeInstruction: "Você deve responder APENAS em português. Não use inglês." },
  nl: { name: "Dutch (Nederlands)", nativeInstruction: "Je moet ALLEEN in het Nederlands antwoorden. Gebruik geen Engels." },
  pl: { name: "Polish (Polski)", nativeInstruction: "Musisz odpowiadać TYLKO po polsku. Nie używaj angielskiego." },
  ru: { name: "Russian (Русский)", nativeInstruction: "Вы должны отвечать ТОЛЬКО на русском языке. Не используйте английский." },
  zh: { name: "Chinese (中文)", nativeInstruction: "你必须只用中文回答。不要使用英语。" },
  ja: { name: "Japanese (日本語)", nativeInstruction: "日本語のみで回答してください。英語は使用しないでください。" },
  ko: { name: "Korean (한국어)", nativeInstruction: "한국어로만 답변해야 합니다. 영어를 사용하지 마세요." },
  ar: { name: "Arabic (العربية)", nativeInstruction: "يجب أن تجيب باللغة العربية فقط. لا تستخدم الإنجليزية." },
  tr: { name: "Turkish (Türkçe)", nativeInstruction: "SADECE Türkçe olarak yanıt vermelisiniz. İngilizce kullanmayın." },
  sv: { name: "Swedish (Svenska)", nativeInstruction: "Du måste svara ENDAST på svenska. Använd inte engelska." },
  da: { name: "Danish (Dansk)", nativeInstruction: "Du skal svare KUN på dansk. Brug ikke engelsk." },
  fi: { name: "Finnish (Suomi)", nativeInstruction: "Sinun täytyy vastata VAIN suomeksi. Älä käytä englantia." },
  no: { name: "Norwegian (Norsk)", nativeInstruction: "Du må svare KUN på norsk. Ikke bruk engelsk." },
  cs: { name: "Czech (Čeština)", nativeInstruction: "Musíte odpovídat POUZE česky. Nepoužívejte angličtinu." },
  hu: { name: "Hungarian (Magyar)", nativeInstruction: "CSAK magyarul kell válaszolnod. Ne használj angolt." },
  ro: { name: "Romanian (Română)", nativeInstruction: "Trebuie să răspunzi DOAR în română. Nu folosi engleza." },
  bg: { name: "Bulgarian (Български)", nativeInstruction: "Трябва да отговаряте САМО на български. Не използвайте английски." },
  uk: { name: "Ukrainian (Українська)", nativeInstruction: "Ви повинні відповідати ТІЛЬКИ українською. Не використовуйте англійську." },
  hr: { name: "Croatian (Hrvatski)", nativeInstruction: "Morate odgovarati SAMO na hrvatskom. Ne koristite engleski." },
  sk: { name: "Slovak (Slovenčina)", nativeInstruction: "Musíte odpovedať LEN po slovensky. Nepoužívajte angličtinu." },
  sl: { name: "Slovenian (Slovenščina)", nativeInstruction: "Odgovarjati morate SAMO v slovenščini. Ne uporabljajte angleščine." },
  et: { name: "Estonian (Eesti)", nativeInstruction: "Peate vastama AINULT eesti keeles. Ärge kasutage inglise keelt." },
  lv: { name: "Latvian (Latviešu)", nativeInstruction: "Jums jāatbild TIKAI latviešu valodā. Nelietojiet angļu valodu." },
  lt: { name: "Lithuanian (Lietuvių)", nativeInstruction: "Turite atsakyti TIK lietuviškai. Nenaudokite anglų kalbos." },
  he: { name: "Hebrew (עברית)", nativeInstruction: "עליך לענות רק בעברית. אל תשתמש באנגלית." },
  th: { name: "Thai (ไทย)", nativeInstruction: "คุณต้องตอบเป็นภาษาไทยเท่านั้น ห้ามใช้ภาษาอังกฤษ" },
  vi: { name: "Vietnamese (Tiếng Việt)", nativeInstruction: "Bạn phải trả lời CHỈ bằng tiếng Việt. Không sử dụng tiếng Anh." },
  id: { name: "Indonesian (Bahasa Indonesia)", nativeInstruction: "Anda harus menjawab HANYA dalam Bahasa Indonesia. Jangan gunakan bahasa Inggris." },
  ms: { name: "Malay (Bahasa Melayu)", nativeInstruction: "Anda mesti menjawab HANYA dalam Bahasa Melayu. Jangan gunakan bahasa Inggeris." },
  hi: { name: "Hindi (हिन्दी)", nativeInstruction: "आपको केवल हिंदी में जवाब देना होगा। अंग्रेजी का उपयोग न करें।" },
  bn: { name: "Bengali (বাংলা)", nativeInstruction: "আপনাকে শুধুমাত্র বাংলায় উত্তর দিতে হবে। ইংরেজি ব্যবহার করবেন না।" },
  ta: { name: "Tamil (தமிழ்)", nativeInstruction: "நீங்கள் தமிழில் மட்டுமே பதிலளிக்க வேண்டும். ஆங்கிலத்தைப் பயன்படுத்தாதீர்கள்." },
};

export function getLanguageInstruction(
  langCode: string,
): { name: string; instruction: string; qualityInstruction?: string } {
  const lang = LANGUAGE_NAMES[langCode] || LANGUAGE_NAMES.en;
  return {
    name: lang.name,
    instruction: `CRITICAL LANGUAGE REQUIREMENT: ${lang.nativeInstruction}`,
    qualityInstruction: lang.qualityInstruction,
  };
}

// Helper to get effective language from course and institution
export async function getEffectiveLanguage(
  supabase: any,
  courseId: string
): Promise<string> {
  // Fetch course with language and institution
  const { data: course } = await supabase
    .from("courses")
    .select("language, institution_id")
    .eq("id", courseId)
    .single();

  if (course?.language) {
    return course.language;
  }

  // Fall back to institution default
  if (course?.institution_id) {
    const { data: institution } = await supabase
      .from("institutions")
      .select("default_language")
      .eq("id", course.institution_id)
      .single();

    if (institution?.default_language) {
      return institution.default_language;
    }
  }

  return "en"; // Default to English
}

/**
 * Resolve the quality instruction (if any) for a course based on its effective language.
 * Returns undefined if the course has no language-specific quality rules.
 */
export async function getQualityInstructionForCourse(
  supabase: any,
  courseId: string,
): Promise<string | undefined> {
  const lang = await getEffectiveLanguage(supabase, courseId);
  return LANGUAGE_NAMES[lang]?.qualityInstruction;
}
