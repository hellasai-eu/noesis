import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Formats explanation text with proper line breaks and styling
 * Converts markdown-style formatting to HTML
 */
export function formatExplanation(text: string): string {
  if (!text) return "";
  
  const formatted = text
    // Escape HTML first
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    // Convert **bold** to <strong>
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    // Convert *italic* to <em>
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    // Add line break before numbered items (1. 2. etc)
    .replace(/(\s)(\d+)\.\s/g, "$1<br/><br/><strong>$2.</strong> ")
    // Handle numbered items at start of text
    .replace(/^(\d+)\.\s/g, "<strong>$1.</strong> ")
    // Add line breaks for common section markers
    .replace(/(Λύση:|Solution:|Answer:|Απάντηση:|Βήμα|Step)/gi, "<br/><br/><strong>$1</strong>")
    // Convert double newlines to paragraph breaks
    .replace(/\n\n/g, "</p><p>")
    // Convert single newlines to line breaks
    .replace(/\n/g, "<br/>")
    // Clean up any double <br/>
    .replace(/(<br\/>){3,}/g, "<br/><br/>");
  
  return `<p>${formatted}</p>`;
}
