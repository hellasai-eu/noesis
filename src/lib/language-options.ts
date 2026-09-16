// Language options for institution and course settings
export const LANGUAGE_OPTIONS = [
  { code: "en", name: "English" },
  { code: "el", name: "Greek (Ελληνικά)" },
  { code: "es", name: "Spanish (Español)" },
  { code: "fr", name: "French (Français)" },
  { code: "de", name: "German (Deutsch)" },
  { code: "it", name: "Italian (Italiano)" },
  { code: "pt", name: "Portuguese (Português)" },
  { code: "nl", name: "Dutch (Nederlands)" },
  { code: "pl", name: "Polish (Polski)" },
  { code: "ru", name: "Russian (Русский)" },
  { code: "zh", name: "Chinese (中文)" },
  { code: "ja", name: "Japanese (日本語)" },
  { code: "ko", name: "Korean (한국어)" },
  { code: "ar", name: "Arabic (العربية)" },
  { code: "tr", name: "Turkish (Türkçe)" },
  { code: "sv", name: "Swedish (Svenska)" },
  { code: "da", name: "Danish (Dansk)" },
  { code: "fi", name: "Finnish (Suomi)" },
  { code: "no", name: "Norwegian (Norsk)" },
  { code: "cs", name: "Czech (Čeština)" },
  { code: "hu", name: "Hungarian (Magyar)" },
  { code: "ro", name: "Romanian (Română)" },
  { code: "bg", name: "Bulgarian (Български)" },
  { code: "uk", name: "Ukrainian (Українська)" },
  { code: "hr", name: "Croatian (Hrvatski)" },
  { code: "sk", name: "Slovak (Slovenčina)" },
  { code: "sl", name: "Slovenian (Slovenščina)" },
  { code: "et", name: "Estonian (Eesti)" },
  { code: "lv", name: "Latvian (Latviešu)" },
  { code: "lt", name: "Lithuanian (Lietuvių)" },
  { code: "he", name: "Hebrew (עברית)" },
  { code: "th", name: "Thai (ไทย)" },
  { code: "vi", name: "Vietnamese (Tiếng Việt)" },
  { code: "id", name: "Indonesian (Bahasa Indonesia)" },
  { code: "ms", name: "Malay (Bahasa Melayu)" },
  { code: "hi", name: "Hindi (हिन्दी)" },
  { code: "bn", name: "Bengali (বাংলা)" },
  { code: "ta", name: "Tamil (தமிழ்)" },
] as const;

export type LanguageCode = typeof LANGUAGE_OPTIONS[number]["code"];

export function getLanguageName(code: string): string {
  const lang = LANGUAGE_OPTIONS.find((l) => l.code === code);
  return lang?.name || code;
}
