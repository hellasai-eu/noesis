/* eslint-disable react-refresh/only-export-components */
import { useState, useEffect, useRef, useCallback, ReactNode, forwardRef, useImperativeHandle, type Dispatch, type SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { AiDisclaimer } from "@/components/AiDisclaimer";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Send, Loader2, Copy, Check, Brain, ChevronDown, AlertTriangle, Target, Lightbulb, GraduationCap } from "lucide-react";
import DOMPurify from "dompurify";
import Prism from "prismjs";
import katex from "katex";
import "katex/dist/katex.min.css";
import "prismjs/themes/prism-tomorrow.css";
import "prismjs/components/prism-javascript";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-python";
import "prismjs/components/prism-java";
import "prismjs/components/prism-css";
import "prismjs/components/prism-sql";
import "prismjs/components/prism-json";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-markup";
import aiTutorImage from "@/assets/ai-tutor.png";
import { renderLatexInHtmlNodes, extractDisplayMath, restoreDisplayMath } from "@/lib/latex-utils";
import type { TutorState, CompetencyScoreEvidence } from "@/types/tutor-state";

// Helper function to render LaTeX math expressions.
//
// Delimited maths ($…$, $$…$$, \(…\), \[…\]) is rendered by walking TEXT NODES
// (`renderLatexInHtmlNodes`), never by regexing the serialized HTML. Chat
// content reaches here as markdown already converted to HTML, so a `$$` pair
// separated by a paragraph break becomes `$$</p><p>f'(\xi)=0.</p><p>$$` — and a
// `[\s\S]*?` delimiter regex happily spans those tags and hands the markup to
// KaTeX, which renders `</p><p>` as literal maths on screen. Node-walking makes
// that class of corruption impossible: maths cannot reach across an element.
function renderLatexInHtml(html: string): string {
  let result = renderLatexInHtmlNodes(html);

  // Handle LaTeX without delimiters - detect common patterns like ^{...} or _{...} with element symbols
  // Match patterns like: ^{238}_{92}U or _{92}^{238}U (nuclear notation)
  result = result.replace(
    /(\^?\{[\d]+\}_?\{[\d]+\}[A-Za-z]{1,2}(?:\s*(?:→|->|\\rightarrow)\s*\^?\{[\d]+\}_?\{[\d]+\}[A-Za-z]{1,2})*(?:\s*\+\s*\^?\{[\d]+\}_?\{[\d]+\}[A-Za-z]{1,2})*)/g,
    (match) => {
      try {
        // Convert -> to \rightarrow for KaTeX
        const normalized = match.replace(/->/g, '\\rightarrow').replace(/→/g, '\\rightarrow');
        return katex.renderToString(normalized.trim(), { displayMode: false, throwOnError: false });
      } catch {
        return match;
      }
    }
  );

  // Handle simpler cases: standalone superscript/subscript patterns with element symbols
  // Matches patterns like ^{4}_{2}He at word boundaries
  result = result.replace(
    /(?<![A-Za-z])(\^?\{[\d]+\}_?\{[\d]+\}[A-Za-z]{1,2})(?![A-Za-z\d{])/g,
    (match) => {
      try {
        return katex.renderToString(match.trim(), { displayMode: false, throwOnError: false });
      } catch {
        return match;
      }
    }
  );
  
  return result;
}

// ============= Types =============

export interface ToolCall {
  id: string;
  function: {
    name: string;
    arguments: string;
  };
}

export interface ActionResult {
  toolCallId: string;
  action: string;
  status: "pending" | "approved" | "rejected" | "executing" | "completed" | "failed";
  params: any;
  result?: { success: boolean; message: string };
}

// Re-export TutorState types from shared module
export type { TutorState, CompetencyScoreEvidence } from "@/types/tutor-state";

export interface ChatMessage {
  id?: string;
  role: "user" | "assistant" | "instructor";
  content: string;
  timestamp?: Date | string;
  flaggedOffensive?: boolean;
  toolCalls?: ToolCall[];
  actionResults?: ActionResult[];
  tutorState?: TutorState | null;
  senderName?: string;
}

// Helper function to format a message's date and time.
//
// The date is carried on every message, not only on the day separators above
// each group: a conversation is usually read long after it happened — an
// instructor reviewing a session, a student returning to a half-finished
// question — and a bare `13:24` on a message from three weeks ago reads as if
// it had just arrived. The year is only worth the width once the message is
// not from the current one.
export function formatMessageTime(timestamp?: Date | string): string | null {
  if (!timestamp) return null;
  const date = typeof timestamp === 'string' ? new Date(timestamp) : timestamp;
  if (isNaN(date.getTime())) return null;
  const isCurrentYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleString([], {
    day: 'numeric',
    month: 'short',
    year: isCurrentYear ? undefined : 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    // Pinned to 24-hour rather than left to the locale: asking for a 2-digit
    // hour makes el-GR render `01:24 μ.μ.`, which is not how Greek writes a
    // time, and the instructor-side viewer of these same conversations
    // (OpenQuestionChatHistory) formats them as `HH:mm`. The same message
    // should not read differently depending on which screen it is opened from.
    hourCycle: 'h23',
  });
}

// Helper function to format date for separators
function formatDateSeparator(timestamp?: Date | string): string | null {
  if (!timestamp) return null;
  const date = typeof timestamp === 'string' ? new Date(timestamp) : timestamp;
  if (isNaN(date.getTime())) return null;
  
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const messageDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  
  if (messageDate.getTime() === today.getTime()) {
    return 'Today';
  } else if (messageDate.getTime() === yesterday.getTime()) {
    return 'Yesterday';
  } else {
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
}

// Helper function to get date key for grouping
function getDateKey(timestamp?: Date | string): string | null {
  if (!timestamp) return null;
  const date = typeof timestamp === 'string' ? new Date(timestamp) : timestamp;
  if (isNaN(date.getTime())) return null;
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/**
 * How far into `maxLength` the student has to be before the counter appears.
 * Below this a running character count is noise on a box most messages never
 * come close to filling.
 */
const COUNTER_VISIBLE_FRACTION = 0.8;

export interface ChatWidgetProps {
  messages: ChatMessage[];
  onSendMessage: (message: string) => Promise<void>;
  isLoading?: boolean;
  isTyping?: boolean;
  typingContent?: string;
  placeholder?: string;
  disabled?: boolean;
  showAvatar?: boolean;
  avatarSrc?: string;
  avatarClassName?: string;
  emptyState?: ReactNode;
  inputType?: "input" | "textarea";
  footerHint?: string;
  renderUserMessage?: (msg: ChatMessage, index: number) => ReactNode;
  renderAssistantMessage?: (msg: ChatMessage, index: number, isTypingMessage: boolean, displayContent: string) => ReactNode;
  renderToolCalls?: (msg: ChatMessage, index: number) => ReactNode;
  className?: string;
  messageListClassName?: string;
  enableMarkdown?: boolean;
  bubbleClassName?: string;
  userBubbleClassName?: string;
  assistantBubbleClassName?: string;
  showTutorState?: boolean;
  onDraftChange?: (hasDraft: boolean) => void;
  /**
   * Per-message character cap. When set, the box counts down as the student
   * nears it and refuses to send past it.
   *
   * Deliberately not wired to the input's native `maxLength`: silently
   * swallowing the tail of a pasted answer loses a student's words without
   * telling them. Letting the text exceed the cap and saying by how much is
   * the recoverable failure — they can see what to cut.
   */
  maxLength?: number;
}

export interface ChatWidgetHandle {
  clearInput: () => void;
}

// ============= Code Block Component =============

interface CodeBlockProps {
  code: string;
  language?: string;
}

function CodeBlock({ code, language = "text" }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const codeRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (codeRef.current && Prism.languages[language]) {
      Prism.highlightElement(codeRef.current);
    }
  }, [code, language]);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="my-3 rounded-lg border border-border overflow-hidden bg-card shadow-sm">
      <div className="flex items-center justify-between px-4 py-2 bg-muted/50 border-b border-border">
        <span className="text-xs font-medium text-muted-foreground">{language}</span>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
          {copied ? "Copied!" : "Copy"}
        </button>
      </div>
      <pre className="p-4 overflow-x-auto bg-secondary/50 m-0 text-sm">
        <code ref={codeRef} className={`language-${language}`}>
          {code}
        </code>
      </pre>
    </div>
  );
}

// ============= Markdown to HTML Converter =============

function markdownToHtml(markdown: string): string {
  let html = markdown;

  // Escape HTML entities first (except for existing HTML tags we want to keep)
  // We'll be more selective - only escape < and > that aren't part of tags
  
  // Handle fenced code blocks first (```...```)
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const escapedCode = code
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    return `<pre><code class="language-${lang || 'text'}">${escapedCode.trim()}</code></pre>`;
  });

  // Handle inline code (but not inside code blocks)
  html = html.replace(/`([^`\n]+)`/g, (_, code) => {
    const escapedCode = code
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    return `<code class="px-1.5 py-0.5 rounded bg-muted text-sm font-mono">${escapedCode}</code>`;
  });

  // Headers
  html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Bold and italic
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  html = html.replace(/___(.+?)___/g, '<strong><em>$1</em></strong>');
  html = html.replace(/__(.+?)__/g, '<strong>$1</strong>');
  html = html.replace(/_(.+?)_/g, '<em>$1</em>');

  // Strikethrough
  html = html.replace(/~~(.+?)~~/g, '<del>$1</del>');

  // Blockquotes
  html = html.replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>');
  // Merge consecutive blockquotes
  html = html.replace(/<\/blockquote>\n<blockquote>/g, '\n');

  // Horizontal rules
  html = html.replace(/^---+$/gm, '<hr>');
  html = html.replace(/^\*\*\*+$/gm, '<hr>');

  // [IMAGE: description] tokens from AI tutor — replace with italic fallback so
  // stored messages render legibly on reload instead of showing raw tag text.
  html = html.replace(/\[IMAGE:\s*([^\]]+)\]/g, '<p class="text-xs text-muted-foreground italic">[Diagram: $1]</p>');

  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

  // Images
  html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" />');

  // Tables (GitHub-style)
  const tableRegex = /^\|(.+)\|\n\|[-:\s|]+\|\n((?:\|.+\|\n?)+)/gm;
  html = html.replace(tableRegex, (_, headerRow, bodyRows) => {
    const headers = headerRow.split('|').map((h: string) => h.trim()).filter(Boolean);
    const headerHtml = headers.map((h: string) => `<th>${h}</th>`).join('');
    
    const rows = bodyRows.trim().split('\n').map((row: string) => {
      const cells = row.split('|').map((c: string) => c.trim()).filter(Boolean);
      return `<tr>${cells.map((c: string) => `<td>${c}</td>`).join('')}</tr>`;
    }).join('');
    
    return `<table><thead><tr>${headerHtml}</tr></thead><tbody>${rows}</tbody></table>`;
  });

  // Unordered lists
  const lines = html.split('\n');
  let inList = false;
  let listType = '';
  const processedLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const ulMatch = line.match(/^[\s]*[-*+] (.+)$/);
    const olMatch = line.match(/^[\s]*\d+\. (.+)$/);

    if (ulMatch) {
      if (!inList || listType !== 'ul') {
        if (inList) processedLines.push(listType === 'ol' ? '</ol>' : '</ul>');
        processedLines.push('<ul>');
        inList = true;
        listType = 'ul';
      }
      processedLines.push(`<li>${ulMatch[1]}</li>`);
    } else if (olMatch) {
      if (!inList || listType !== 'ol') {
        if (inList) processedLines.push(listType === 'ol' ? '</ol>' : '</ul>');
        processedLines.push('<ol>');
        inList = true;
        listType = 'ol';
      }
      processedLines.push(`<li>${olMatch[1]}</li>`);
    } else {
      if (inList) {
        processedLines.push(listType === 'ol' ? '</ol>' : '</ul>');
        inList = false;
        listType = '';
      }
      processedLines.push(line);
    }
  }
  if (inList) {
    processedLines.push(listType === 'ol' ? '</ol>' : '</ul>');
  }
  html = processedLines.join('\n');

  // Paragraphs - wrap text blocks not already in tags
  html = html.replace(/^(?!<[a-z]|$)(.+)$/gm, '<p>$1</p>');
  
  // Clean up empty paragraphs and double line breaks
  html = html.replace(/<p><\/p>/g, '');
  html = html.replace(/\n{2,}/g, '\n');

  return html;
}

// ============= Rich Content Renderer (HTML/MathML) =============

interface RichContentProps {
  content: string;
  className?: string;
}

export function RichContent({ content, className = "" }: RichContentProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Display maths must come out before the markdown pass: authors put `$$` on
  // its own line, and once markdown has split that across paragraphs neither
  // the HTML regex nor the text-node walker can put it back together. See
  // extractDisplayMath.
  const { text: contentSansDisplayMath, blocks: displayMathBlocks } = extractDisplayMath(content);

  // Always convert markdown to HTML - the converter handles mixed content safely
  const htmlContent = markdownToHtml(contentSansDisplayMath);

  // Extract code blocks and replace with placeholders
  const codeBlocks: { language: string; code: string }[] = [];
  const processedContent = htmlContent.replace(
    /<pre><code(?:\s+class="language-(\w+)")?>([\s\S]*?)<\/code><\/pre>/gi,
    (_, lang, code) => {
      const index = codeBlocks.length;
      // Decode HTML entities in code
      const decodedCode = code
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
      // The AI tutor sometimes wraps lines inside fenced code blocks with
      // <p>…</p> or separates them with <br>. These would render verbatim
      // because CodeBlock prints the string as text — strip them to leave
      // clean pseudocode while preserving line breaks.
      const cleanedCode = decodedCode
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/?p[^>]*>/gi, '');
      codeBlocks.push({ language: lang || 'text', code: cleanedCode.trim() });
      return `<div data-code-block="${index}"></div>`;
    }
  );

  // Render the remaining (inline) LaTeX, then put the display blocks back —
  // before sanitizing, so KaTeX's own markup gets the MathML allowlist.
  const contentWithMath = restoreDisplayMath(
    renderLatexInHtml(processedContent),
    displayMathBlocks,
  );

  // Sanitize HTML to prevent XSS attacks, allowing MathML and KaTeX elements
  const sanitizedContent = DOMPurify.sanitize(contentWithMath, {
    ADD_TAGS: ['math', 'mrow', 'mi', 'mo', 'mn', 'msup', 'msub', 'mfrac', 'msqrt', 'mroot', 'mtext', 'mspace', 'mtable', 'mtr', 'mtd', 'munder', 'mover', 'munderover', 'menclose', 'mpadded', 'mphantom', 'mstyle', 'merror', 'maction', 'semantics', 'annotation', 'span', 'svg', 'line', 'path'],
    ADD_ATTR: ['mathvariant', 'mathsize', 'mathcolor', 'mathbackground', 'displaystyle', 'scriptlevel', 'xmlns', 'class', 'data-code-block', 'aria-hidden', 'style', 'focusable', 'role', 'viewBox', 'preserveAspectRatio', 'd', 'x1', 'x2', 'y1', 'y2', 'stroke', 'stroke-width', 'fill'],
  });

  // Improved typography prose classes for chat messages with GitHub-style tables
  const proseClasses = `prose prose-sm max-w-none dark:prose-invert 
    prose-headings:font-display prose-headings:font-semibold prose-headings:tracking-tight
    prose-h1:text-xl prose-h1:mt-5 prose-h1:mb-3 prose-h1:font-bold
    prose-h2:text-lg prose-h2:mt-4 prose-h2:mb-2 prose-h2:border-t prose-h2:border-border/40 prose-h2:pt-3
    prose-h3:text-base prose-h3:mt-3 prose-h3:mb-2
    prose-h4:text-sm prose-h4:mt-3 prose-h4:mb-1.5
    prose-p:my-3 prose-p:leading-7
    prose-ul:my-4 prose-ul:pl-5 prose-ol:my-4 prose-ol:pl-5
    prose-li:my-1.5 prose-li:leading-relaxed
    prose-blockquote:border-l-4 prose-blockquote:border-primary/30 prose-blockquote:pl-4 prose-blockquote:italic prose-blockquote:my-4 prose-blockquote:text-muted-foreground
    prose-hr:my-6 prose-hr:border-border
    prose-strong:text-foreground prose-strong:font-semibold 
    prose-a:text-primary prose-a:underline prose-a:underline-offset-2 hover:prose-a:text-primary/80
    prose-img:rounded-lg prose-img:max-w-full prose-img:my-3 prose-img:border prose-img:shadow-sm
    prose-table:my-4 prose-table:w-full prose-table:border-collapse prose-table:text-sm
    prose-thead:bg-muted/50 prose-thead:border-b prose-thead:border-border
    prose-th:px-3 prose-th:py-2 prose-th:text-left prose-th:font-semibold prose-th:text-foreground prose-th:border prose-th:border-border
    prose-td:px-3 prose-td:py-2 prose-td:border prose-td:border-border prose-td:text-muted-foreground
    prose-tr:border-b prose-tr:border-border
    [&_tbody_tr:nth-child(even)]:bg-muted/30
    [&_math]:text-foreground [&_math]:overflow-x-auto [&_math]:block [&_math]:my-2
    [&_.katex-display]:my-4 [&_.katex-display]:overflow-x-auto [&_.katex]:text-base
    [&_*]:break-words [&>*:first-child]:mt-0 [&>*:last-child]:mb-0`;

  // Split content by code block placeholders and render
  const parts: ReactNode[] = [];
  let lastIndex = 0;
  const regex = /<div data-code-block="(\d+)"><\/div>/g;
  let match;

  while ((match = regex.exec(sanitizedContent)) !== null) {
    // Add HTML before the code block
    if (match.index > lastIndex) {
      const htmlPart = sanitizedContent.slice(lastIndex, match.index);
      parts.push(
        <div
          key={`html-${lastIndex}`}
          className={proseClasses}
          style={{ overflowWrap: 'anywhere' }}
          dangerouslySetInnerHTML={{ __html: htmlPart }}
        />
      );
    }
    
    // Add the code block component
    const blockIndex = parseInt(match[1], 10);
    const block = codeBlocks[blockIndex];
    if (block) {
      parts.push(
        <CodeBlock key={`code-${blockIndex}`} code={block.code} language={block.language} />
      );
    }
    
    lastIndex = match.index + match[0].length;
  }

  // Add remaining HTML after last code block
  if (lastIndex < sanitizedContent.length) {
    const htmlPart = sanitizedContent.slice(lastIndex);
    parts.push(
      <div
        key={`html-${lastIndex}`}
        className={proseClasses}
        style={{ overflowWrap: 'anywhere' }}
        dangerouslySetInnerHTML={{ __html: htmlPart }}
      />
    );
  }

  // If no code blocks, render simple content
  if (codeBlocks.length === 0) {
    return (
      <div
        ref={containerRef}
        className={`${proseClasses} ${className}`}
        style={{ overflowWrap: 'anywhere' }}
        dangerouslySetInnerHTML={{ __html: sanitizedContent }}
      />
    );
  }

  return <div className={className}>{parts}</div>;
}

// Legacy alias for backward compatibility
export const MarkdownContent = RichContent;

// ============= Tutor State Panel Component =============

interface TutorStatePanelProps {
  tutorState: TutorState;
}

function TutorStatePanel({ tutorState }: TutorStatePanelProps) {
  const [isOpen, setIsOpen] = useState(false);
  const { decision, state_update, meta } = tutorState;

  const hasContent = !!decision || !!state_update || !!meta;
  if (!hasContent) return null;

  // Socratic format values
  // `frustration` is 0..1 (see `mergeState`, which clamps it there). The panel
  // showed it as "/10" and gated the badge on `>= 6`, so the badge was
  // unreachable — shown as a percentage now, against the same scale it is
  // stored on.
  const frustration = state_update?.frustration ?? 0;
  const frustrationPct = Math.round(frustration * 100);
  const isFrustrated = frustration >= 0.6;
  const hintLevel = state_update?.hint_level ?? 0;
  const hasMisconceptions = (state_update?.misconceptions?.length ?? 0) > 0;
  const hasGaps = (state_update?.gaps?.length ?? 0) > 0;
  const hasKnown = (state_update?.known?.length ?? 0) > 0;
  const judgement = state_update?.judgement;

  // Get decision badge color
  const getDecisionBadge = () => {
    switch (decision) {
      case "STOP": return <Badge variant="destructive" className="text-[10px] px-1 py-0 h-4">STOP</Badge>;
      case "ASK": return <Badge variant="secondary" className="text-[10px] px-1 py-0 h-4">ASK</Badge>;
      case "HINT": return <Badge variant="outline" className="text-[10px] px-1 py-0 h-4 text-blue-600 border-blue-500/30">HINT</Badge>;
      case "WORKED_STEP": return <Badge variant="outline" className="text-[10px] px-1 py-0 h-4 text-purple-600 border-purple-500/30">WORKED_STEP</Badge>;
      default: return null;
    }
  };

  // Get judgement badge
  const getJudgementBadge = () => {
    switch (judgement) {
      case "CORRECT": return <Badge variant="outline" className="text-[10px] px-1 py-0 h-4 text-green-600 border-green-500/30">✓ Correct</Badge>;
      case "PARTIAL": return <Badge variant="outline" className="text-[10px] px-1 py-0 h-4 text-amber-600 border-amber-500/30">◐ Partial</Badge>;
      case "INCORRECT": return <Badge variant="outline" className="text-[10px] px-1 py-0 h-4 text-red-600 border-red-500/30">✗ Incorrect</Badge>;
      default: return null;
    }
  };

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen} className="mt-2">
      <CollapsibleTrigger asChild>
        <button className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors">
          <Brain className="w-3 h-3" />
          <span>Tutor State</span>
          {/* Socratic format badges */}
          {decision && getDecisionBadge()}
          {judgement && getJudgementBadge()}
          {isFrustrated && (
            <Badge variant="destructive" className="text-[10px] px-1 py-0 h-4">High Frustration</Badge>
          )}
          {hasMisconceptions && (
            <Badge variant="outline" className="text-[10px] px-1 py-0 h-4 text-amber-600 border-amber-500/30">Misconceptions</Badge>
          )}
          <ChevronDown className={`w-3 h-3 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2">
        <div className="bg-background/50 rounded-lg p-3 border text-xs space-y-3">
          {/* Meta info row */}
          {meta && (
            <div className="flex flex-wrap gap-2">
              {meta.mode && <Badge variant="secondary" className="text-[10px]">Mode: {meta.mode}</Badge>}
              {meta.response_class && <Badge variant="outline" className="text-[10px]">{meta.response_class}</Badge>}
              {meta.confidence !== undefined && (
                <Badge variant="outline" className="text-[10px]">
                  Confidence: {(meta.confidence * 100).toFixed(0)}%
                </Badge>
              )}
            </div>
          )}

          {/* State update */}
          {state_update && (
            <div className="space-y-2">
              {/* Metrics row */}
              <div className="flex flex-wrap gap-3 text-muted-foreground">
                {state_update.subject && (
                  <span>Subject: <span className="text-foreground font-medium">{state_update.subject}</span></span>
                )}
                {state_update.current_topic && (
                  <span>Topic: <span className="text-foreground font-medium">{state_update.current_topic}</span></span>
                )}
                {state_update.progress_level && (
                  <span>Progress: <span className="text-foreground font-medium">{state_update.progress_level}</span></span>
                )}
                <span>Hint: <span className="text-foreground font-medium">{hintLevel}/4</span></span>
                <span className={isFrustrated ? "text-red-600" : ""}>
                  Frustration: <span className="font-medium">{frustrationPct}%</span>
                </span>
                {state_update.difficulty && state_update.difficulty !== "same" && (
                  <span>Next: <span className="text-foreground font-medium">{state_update.difficulty}</span></span>
                )}
                {state_update.answer_allowed && (
                  <span className="text-green-600 font-medium">Answer Allowed</span>
                )}
              </div>
              
              {/* Goal */}
              {state_update.goal && (
                <div className="flex items-start gap-1.5">
                  <Target className="w-3 h-3 mt-0.5 text-primary flex-shrink-0" />
                  <span className="text-muted-foreground">{state_update.goal}</span>
                </div>
              )}

              {/* Known */}
              {hasKnown && (
                <div>
                  <span className="text-green-600 font-medium flex items-center gap-1">
                    <Target className="w-3 h-3" /> Known:
                  </span>
                  <ul className="ml-4 mt-1 list-disc text-muted-foreground">
                    {state_update.known?.slice(0, 3).map((k, i) => (
                      <li key={i}>{k}</li>
                    ))}
                    {(state_update.known?.length ?? 0) > 3 && (
                      <li className="text-muted-foreground/70">+{state_update.known!.length - 3} more</li>
                    )}
                  </ul>
                </div>
              )}
              
              {/* Gaps */}
              {hasGaps && (
                <div>
                  <span className="text-amber-600 font-medium flex items-center gap-1">
                    <Lightbulb className="w-3 h-3" /> Gaps:
                  </span>
                  <ul className="ml-4 mt-1 list-disc text-muted-foreground">
                    {state_update.gaps?.slice(0, 3).map((gap, i) => (
                      <li key={i}>{gap}</li>
                    ))}
                    {(state_update.gaps?.length ?? 0) > 3 && (
                      <li className="text-muted-foreground/70">+{state_update.gaps!.length - 3} more</li>
                    )}
                  </ul>
                </div>
              )}
              
              {/* Misconceptions */}
              {hasMisconceptions && (
                <div>
                  <span className="text-red-600 font-medium flex items-center gap-1">
                    <AlertTriangle className="w-3 h-3" /> Misconceptions:
                  </span>
                  <ul className="ml-4 mt-1 list-disc text-muted-foreground">
                    {state_update.misconceptions?.slice(0, 3).map((m, i) => (
                      <li key={i}>{m}</li>
                    ))}
                    {(state_update.misconceptions?.length ?? 0) > 3 && (
                      <li className="text-muted-foreground/70">+{state_update.misconceptions!.length - 3} more</li>
                    )}
                  </ul>
                </div>
              )}

              {/* Competency Assessment */}
              {meta?.competency_assessment && (
                <div>
                  <span className="text-primary font-medium text-[10px]">Competency Scores:</span>
                  <div className="grid grid-cols-4 gap-1 mt-1">
                    {Object.entries(meta.competency_assessment)
                      .filter(([_, v]) => v.score > 0 || v.evidence.length > 0)
                      .slice(0, 8)
                      .map(([key, val]) => (
                        <div key={key} className="text-[10px] text-muted-foreground">
                          <span className="font-medium">{key.toUpperCase()}</span>: {val.score}/4
                        </div>
                      ))}
                  </div>
                </div>
              )}
            </div>
          )}

        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// ============= Chat Widget Component =============

export const ChatWidget = forwardRef<ChatWidgetHandle, ChatWidgetProps>(function ChatWidget({
  messages,
  onSendMessage,
  isLoading = false,
  isTyping = false,
  typingContent = "",
  placeholder = "Type a message...",
  disabled = false,
  showAvatar = true,
  avatarSrc = aiTutorImage,
  avatarClassName = "",
  emptyState,
  inputType = "input",
  footerHint,
  renderUserMessage,
  renderAssistantMessage,
  renderToolCalls,
  className = "",
  messageListClassName = "",
  enableMarkdown = true,
  bubbleClassName = "",
  userBubbleClassName = "",
  assistantBubbleClassName = "",
  showTutorState = false,
  onDraftChange,
  maxLength,
}, ref) {
  const { t } = useTranslation("common");
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);

  // Measured on the trimmed value, because that is what gets sent: `handleSubmit`
  // posts `input.trim()`, and both handlers cap the string they receive. Judging
  // the raw value instead would refuse a message the server would have accepted —
  // easy to hit in a textarea whose content ends in blank lines. The counter uses
  // the same number so it cannot contradict the Send button.
  const messageLength = input.trim().length;
  const overLimit = maxLength !== undefined && messageLength > maxLength;
  const showCounter =
    maxLength !== undefined && messageLength >= maxLength * COUNTER_VISIBLE_FRACTION;

  const onDraftChangeRef = useRef(onDraftChange);
  useEffect(() => { onDraftChangeRef.current = onDraftChange; });

  useEffect(() => {
    onDraftChangeRef.current?.(input.trim().length > 0);
  }, [input]);
  useImperativeHandle(ref, () => ({ clearInput: () => setInput("") }));

  const scrollRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);

  // Scroll to bottom when messages change
  useEffect(() => {
    // Use requestAnimationFrame to ensure DOM has updated
    requestAnimationFrame(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    });
  }, [messages, messages.length, typingContent, isTyping]);

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!input.trim() || sending || disabled || isLoading || overLimit) return;

    const message = input.trim();
    setInput("");
    setSending(true);

    try {
      await onSendMessage(message);
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (inputType === "textarea" && e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  // Default message renderers
  const defaultRenderUserMessage = (msg: ChatMessage, index: number) => {
    const timeStr = formatMessageTime(msg.timestamp);
    return (
      <div key={msg.id || `user-${index}`} className="flex flex-col items-end gap-1">
        <div className={`max-w-[90%] rounded-2xl px-4 py-3 bg-primary text-primary-foreground rounded-br-md overflow-x-auto ${bubbleClassName} ${userBubbleClassName}`}>
          <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
        </div>
        {timeStr && (
          <span className="text-[10px] text-muted-foreground px-1">{timeStr}</span>
        )}
      </div>
    );
  };

  const defaultRenderAssistantMessage = (
    msg: ChatMessage, 
    index: number, 
    isTypingMessage: boolean, 
    displayContent: string
  ) => {
    const timeStr = formatMessageTime(msg.timestamp);
    return (
      <div key={msg.id || `assistant-${index}`} className="flex justify-start gap-3">
        {showAvatar && (
          <div className="flex-shrink-0 relative">
            <img 
              src={avatarSrc} 
              alt="AI Assistant" 
              className={`w-10 h-10 rounded-full border-2 border-primary/20 bg-background shadow-sm ${isTypingMessage ? 'animate-pulse' : ''} ${avatarClassName}`}
            />
          </div>
        )}
        <div className="relative flex-1 min-w-0 max-w-[90%] flex flex-col gap-1">
          {/* Speech bubble triangle */}
          {showAvatar && (
            <div className="absolute -left-2 top-3 w-0 h-0 border-t-8 border-t-transparent border-b-8 border-b-transparent border-r-8 border-r-muted" />
          )}
          <div className={`rounded-2xl px-4 py-3 bg-muted rounded-bl-md overflow-x-auto ${bubbleClassName} ${assistantBubbleClassName}`}>
            {enableMarkdown ? (
              <MarkdownContent content={displayContent || ""} className="text-sm" />
            ) : (
              <p className="text-sm whitespace-pre-wrap">{displayContent}</p>
            )}
            {isTypingMessage && displayContent && (
              <span className="inline-block w-2 h-4 ml-0.5 bg-foreground/70 animate-pulse align-middle" />
            )}
            {msg.flaggedOffensive && (
              <p className="text-xs mt-1 opacity-70">⚠️ Content flagged</p>
            )}
          </div>
          {timeStr && !isTypingMessage && (
            <span className="text-[10px] text-muted-foreground px-1">{timeStr}</span>
          )}
          {/* Render tool calls if provided */}
          {renderToolCalls && msg.actionResults && msg.actionResults.length > 0 && (
            renderToolCalls(msg, index)
          )}
          {/* Render tutor state for instructors/admins */}
          {showTutorState && msg.tutorState && (
            <TutorStatePanel tutorState={msg.tutorState} />
          )}
        </div>
      </div>
    );
  };

  const defaultRenderInstructorMessage = (msg: ChatMessage, index: number) => {
    const timeStr = formatMessageTime(msg.timestamp);
    // Translated, and named where we know the name. This label is the only
    // thing on screen that says a person, not the tutor, wrote this — leaving
    // it in English inside a Greek session is what let it be skimmed past.
    const label = msg.senderName
      ? t("chat.instructorNamed", "{{name}} · Instructor", { name: msg.senderName })
      : t("chat.instructor", "Instructor");
    return (
      <div key={msg.id || `instructor-${index}`} className="flex justify-start gap-3">
        <div className="flex-shrink-0 w-10 h-10 rounded-full bg-amber-100 dark:bg-amber-900/40 border-2 border-amber-300 dark:border-amber-700 flex items-center justify-center">
          <GraduationCap className="w-5 h-5 text-amber-700 dark:text-amber-300" />
        </div>
        <div className="flex-1 min-w-0 max-w-[90%] flex flex-col gap-1">
          <span className="text-[11px] font-medium text-amber-700 dark:text-amber-300 px-1">
            {label}
          </span>
          <div className={`rounded-2xl px-4 py-3 bg-amber-100 text-amber-900 dark:bg-amber-900/30 dark:text-amber-100 border border-amber-300 dark:border-amber-700 rounded-bl-md overflow-x-auto ${bubbleClassName}`}>
            {enableMarkdown ? (
              <MarkdownContent content={msg.content || ""} className="text-sm" />
            ) : (
              <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
            )}
          </div>
          {timeStr && (
            <span className="text-[10px] text-muted-foreground px-1">{timeStr}</span>
          )}
        </div>
      </div>
    );
  };

  const renderMessage = (msg: ChatMessage, index: number) => {
    const isLastAssistant = msg.role === "assistant" && index === messages.length - 1;
    const isTypingMessage = isLastAssistant && isTyping;
    const displayContent = isTypingMessage ? typingContent : msg.content;

    if (msg.role === "user") {
      return renderUserMessage
        ? renderUserMessage(msg, index)
        : defaultRenderUserMessage(msg, index);
    }

    if (msg.role === "instructor") {
      return defaultRenderInstructorMessage(msg, index);
    }

    // Don't render empty assistant message while typing - let the typing indicator handle it
    if (isTypingMessage && !displayContent) {
      return null;
    }

    // An empty assistant message that is NOT the active typing target is a
    // placeholder whose reply never arrived — the request failed without the
    // caller clearing it, or a newer message superseded it (`isLastAssistant`
    // only ever tracks the final one, so the older placeholder falls through
    // here with `msg.content === ""`). Rendering it draws an empty bubble that
    // sits there forever. Drop it instead; the caller surfaces the error.
    if (!displayContent) {
      return null;
    }

    return renderAssistantMessage
      ? renderAssistantMessage(msg, index, isTypingMessage, displayContent)
      : defaultRenderAssistantMessage(msg, index, isTypingMessage, displayContent);
  };

  const isSendDisabled = !input.trim() || sending || disabled || isLoading || overLimit;

  return (
    /* `min-h-0` is load-bearing, not decoration. This widget is always a flex
       item in a height-capped column (see StudentOpenQuestions), and a flex
       item's default `min-height: auto` resolves to its content height — the
       whole transcript. Without it the widget refuses to shrink, spills out of
       its container, and paints over whatever follows in the document: on
       /student/course/:id that is the global footer. The ScrollArea below can
       only scroll once its parent is allowed to be shorter than its content. */
    <div className={`flex min-h-0 flex-col ${className}`}>
      {/* Messages area */}
      <ScrollArea className={`min-h-0 flex-1 py-4 ${messageListClassName}`} ref={scrollRef}>
        {messages.length === 0 && !isTyping && emptyState ? (
          emptyState
        ) : (
          <div className="space-y-4 px-1">
            {messages.map((msg, index) => {
              const currentDateKey = getDateKey(msg.timestamp);
              const prevDateKey = index > 0 ? getDateKey(messages[index - 1].timestamp) : null;
              const showDateSeparator = currentDateKey && currentDateKey !== prevDateKey;
              
              return (
                <div key={msg.id || `msg-${index}`}>
                  {showDateSeparator && (
                    <div className="flex items-center justify-center my-4">
                      <div className="flex-1 border-t border-border" />
                      <span className="px-3 text-xs text-muted-foreground font-medium">
                        {formatDateSeparator(msg.timestamp)}
                      </span>
                      <div className="flex-1 border-t border-border" />
                    </div>
                  )}
                  {renderMessage(msg, index)}
                </div>
              );
            })}
            
            {/* Typing indicator when no content yet */}
            {isTyping && messages.length > 0 && !typingContent && (
              <div className="flex justify-start gap-3">
                {showAvatar && (
                  <div className="flex-shrink-0">
                    <img 
                      src={avatarSrc} 
                      alt="AI Assistant" 
                      className={`w-10 h-10 rounded-full border-2 border-primary/20 bg-background shadow-sm animate-pulse ${avatarClassName}`}
                    />
                  </div>
                )}
                <div className="relative">
                  {showAvatar && (
                    <div className="absolute -left-2 top-3 w-0 h-0 border-t-8 border-t-transparent border-b-8 border-b-transparent border-r-8 border-r-muted" />
                  )}
                  <div className="bg-muted rounded-2xl rounded-bl-md px-4 py-3">
                    <Loader2 className="w-4 h-4 animate-spin" />
                  </div>
                </div>
              </div>
            )}
            {/* Scroll anchor */}
            <div ref={messagesEndRef} />
          </div>
        )}
      </ScrollArea>

      {/* Input area */}
      <div className="pt-4 border-t">
        {/*
          The box takes `disabled` only; `isLoading` gates the Send button, not
          the typing. A student can compose their next message while the tutor
          is still replying — only *send* has to wait, because the server builds
          the next turn from the persisted transcript and a send racing the
          in-flight turn would answer against a conversation missing its last
          reply. Disabling the box also stole its focus mid-conversation, which
          re-enabling never gave back.
        */}
        <form onSubmit={handleSubmit} className="flex gap-2">
          {inputType === "textarea" ? (
            <Textarea
              ref={inputRef as React.RefObject<HTMLTextAreaElement>}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={placeholder}
              disabled={disabled}
              className="min-h-[60px] resize-none flex-1"
            />
          ) : (
            <Input
              ref={inputRef as React.RefObject<HTMLInputElement>}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={placeholder}
              disabled={disabled}
              className="flex-1"
            />
          )}
          <Button type="submit" disabled={isSendDisabled} className={inputType === "textarea" ? "h-auto" : ""}>
            {sending || isLoading ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Send className="w-4 h-4" />
            )}
          </Button>
        </form>
        {/*
          Two hints on one line: what the keys do, and how much room is left.

          The keyboard hint only appears in textarea mode, because that is the
          only mode where Enter is overloaded — `handleKeyDown` sends on Enter
          and breaks the line on Shift+Enter. Both tutor surfaces switched to
          this mode so students could write long answers, which is exactly when
          an unannounced Enter-sends rule costs them a half-finished turn.

          The counter shows only once it matters (see tutor-input-limit). The
          server rejects a message over the cap with a 400, and it does so
          *after* the turn has been written to the transcript — so a student who
          never sees the limit gets their message stranded in the conversation
          with no reply after it. Counting down here is what stops that
          happening; the disabled Send button is the same rule, restated.
        */}
        {(inputType === "textarea" || showCounter) && (
          <div className="mt-2 flex items-start justify-between gap-3 text-xs">
            {inputType === "textarea" ? (
              <p className="text-muted-foreground">{t("chat.keyboardHint")}</p>
            ) : (
              <span />
            )}
            {showCounter && (
              <p
                // No `shrink-0`: the short count never needs to wrap, but the
                // over-limit sentence is long, and pinning its width would
                // squeeze the keyboard hint off its line instead.
                className={`min-w-0 text-right ${
                  overLimit ? "text-destructive font-medium" : "text-muted-foreground"
                }`}
                aria-live="polite"
              >
                {overLimit
                  ? t("chat.overLimit", { over: messageLength - maxLength!, max: maxLength })
                  : t("chat.charCount", { current: messageLength, max: maxLength })}
              </p>
            )}
          </div>
        )}
        {footerHint && (
          <p className="text-xs text-muted-foreground mt-2 text-center">
            {footerHint}
          </p>
        )}
        {/*
          EU AI Act Art. 50 transparency (#936). Unconditional: every consumer of
          this widget is a tutor conversation with a model, so the notice is
          always rendered and cannot be dismissed. It sits at the foot of the
          widget, under the input and its hints, where it stays on screen for the
          whole conversation without pushing itself between the transcript and
          the box the student is typing in.
        */}
        <AiDisclaimer variant="compact" className="mt-2" />
      </div>
    </div>
  );
});

// ============= Message State =============

/**
 * Chat message state where every message is guaranteed to carry a timestamp.
 *
 * Messages loaded from the database arrive with their `created_at`; messages
 * created locally (the optimistic user turn, the streaming placeholder, the
 * moderation/pause notices) historically arrived with nothing, so they rendered
 * without a time while reloaded history rendered with one. Stamping inside the
 * setter rather than at each call site means a turn is timed when it enters the
 * conversation — and a call site added later cannot forget to do it.
 *
 * An already-stamped message is passed through untouched, so reloaded history
 * keeps its server time and re-renders do not shift the clock.
 */
export function useChatMessages(
  initial: ChatMessage[] = []
): [ChatMessage[], React.Dispatch<React.SetStateAction<ChatMessage[]>>] {
  const [messages, setMessages] = useState<ChatMessage[]>(() => stampMessages(initial));

  const setStamped = useCallback<React.Dispatch<React.SetStateAction<ChatMessage[]>>>(
    (update) => {
      setMessages((prev) =>
        stampMessages(typeof update === "function" ? update(prev) : update)
      );
    },
    []
  );

  return [messages, setStamped];
}

function stampMessages(messages: ChatMessage[]): ChatMessage[] {
  if (messages.every((msg) => msg.timestamp)) return messages;
  const now = new Date();
  return messages.map((msg) => (msg.timestamp ? msg : { ...msg, timestamp: now }));
}

// ============= Streaming Hooks =============

// Hook for managing streaming chat with typing effect
export function useChatStreaming() {
  const [displayedContent, setDisplayedContent] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const charQueueRef = useRef<string[]>([]);
  const typingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  // `finishTyping` polls for the queue to drain. Both the poll and the promise
  // it is blocking on have to be reachable from unmount cleanup: otherwise the
  // poll outlives the component, and the `await` after it lands `setIsTyping`
  // on a hook that is gone.
  const drainIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const drainResolveRef = useRef<(() => void) | null>(null);
  const drainPromiseRef = useRef<Promise<void> | null>(null);
  const isMountedRef = useRef(true);

  // Every update here is reachable from an async continuation of a stream that
  // can outlive the component — a `finally` after `await`, an SSE callback. Route
  // them through the mount guard so a late one is a no-op rather than a React
  // update against a tree (and, under Vitest, a `window`) that is already gone.
  const safeSetIsTyping = useCallback((value: boolean) => {
    if (isMountedRef.current) setIsTyping(value);
  }, []);
  const safeSetDisplayedContent = useCallback<Dispatch<SetStateAction<string>>>((value) => {
    if (isMountedRef.current) setDisplayedContent(value);
  }, []);

  const startTypingEffect = useCallback((charDelay = 8) => {
    if (typingIntervalRef.current) {
      clearInterval(typingIntervalRef.current);
    }

    typingIntervalRef.current = setInterval(() => {
      // Process multiple characters per tick for faster display
      const charsPerTick = 3;
      let added = "";
      for (let i = 0; i < charsPerTick && charQueueRef.current.length > 0; i++) {
        added += charQueueRef.current.shift() || "";
      }
      if (added) {
        safeSetDisplayedContent(prev => prev + added);
      }
    }, charDelay);
  }, [safeSetDisplayedContent]);

  const stopTypingEffect = useCallback(() => {
    if (typingIntervalRef.current) {
      clearInterval(typingIntervalRef.current);
      typingIntervalRef.current = null;
    }
  }, []);

  // Stop the drain poll and release everyone awaiting it. Safe to call when no
  // drain is in flight, and idempotent — unmount and a normal drain both use it.
  const stopDrainPolling = useCallback(() => {
    if (drainIntervalRef.current) {
      clearInterval(drainIntervalRef.current);
      drainIntervalRef.current = null;
    }
    drainPromiseRef.current = null;
    const resolve = drainResolveRef.current;
    drainResolveRef.current = null;
    resolve?.();
  }, []);

  // Resolves when the character queue is empty, or at unmount. Overlapping
  // callers share one poll and one promise: arming a second drain over a live
  // one would release the first caller early, and its continuation stops the
  // typing interval the second is still waiting on — leaving the queue unable
  // to drain and the panel stuck mid-reply.
  const waitForDrain = useCallback(() => {
    if (charQueueRef.current.length === 0) return Promise.resolve();
    if (drainPromiseRef.current) return drainPromiseRef.current;
    drainPromiseRef.current = new Promise<void>((resolve) => {
      drainResolveRef.current = resolve;
      drainIntervalRef.current = setInterval(() => {
        if (charQueueRef.current.length === 0) {
          stopDrainPolling();
        }
      }, 50);
    });
    return drainPromiseRef.current;
  }, [stopDrainPolling]);

  const addToQueue = useCallback((content: string) => {
    for (const char of content) {
      charQueueRef.current.push(char);
    }
  }, []);

  const resetTyping = useCallback(() => {
    stopTypingEffect();
    stopDrainPolling();
    charQueueRef.current = [];
    safeSetDisplayedContent("");
    safeSetIsTyping(false);
  }, [stopTypingEffect, stopDrainPolling, safeSetDisplayedContent, safeSetIsTyping]);

  const beginTyping = useCallback((charDelay = 8) => {
    safeSetIsTyping(true);
    safeSetDisplayedContent("");
    charQueueRef.current = [];
    startTypingEffect(charDelay);
  }, [startTypingEffect, safeSetIsTyping, safeSetDisplayedContent]);

  const finishTyping = useCallback(async () => {
    await waitForDrain();
    if (!isMountedRef.current) return;
    stopTypingEffect();
    safeSetIsTyping(false);
  }, [waitForDrain, stopTypingEffect, safeSetIsTyping]);

  // End the typing state *now*: flush whatever is still queued in one paint and
  // drop the cursor. For the moment the server says the reply text is complete
  // (`text_done`) — animating out a tail the pupil knows is finished, cursor
  // blinking, would be the stall this frame exists to remove. `finishTyping`
  // stays for the stream's end, where there is nothing to hurry for.
  const settleTyping = useCallback(() => {
    stopTypingEffect();
    stopDrainPolling();
    const rest = charQueueRef.current.join("");
    charQueueRef.current = [];
    if (rest) {
      safeSetDisplayedContent((prev) => prev + rest);
    }
    safeSetIsTyping(false);
  }, [stopTypingEffect, stopDrainPolling, safeSetDisplayedContent, safeSetIsTyping]);

  // Cleanup on unmount
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      stopTypingEffect();
      stopDrainPolling();
    };
  }, [stopTypingEffect, stopDrainPolling]);

  return {
    displayedContent,
    isTyping,
    addToQueue,
    beginTyping,
    finishTyping,
    settleTyping,
    resetTyping,
    setIsTyping: safeSetIsTyping,
    setDisplayedContent: safeSetDisplayedContent,
  };
}

// ============= SSE Stream Parser =============

export interface ParseSSEStreamOptions {
  onContent?: (content: string) => void;
  onToolCall?: (toolCall: { index: number; id?: string; name?: string; arguments?: string }) => void;
  onMetadata?: (metadata: { state?: any; meta?: any }) => void;
  /**
   * A reply that was screened *after* it was delivered and flagged.
   *
   * Only the streaming surface sends this. The buffered endpoint withholds a
   * flagged reply outright (#1198), so it has nothing to report after the fact
   * — which is why this is optional and why a consumer that omits it is not
   * silently missing anything on that path.
   */
  onModerationFlag?: (flag: { categories?: string[]; message?: string }) => void;
  /**
   * The visible reply text is complete; the stream is not.
   *
   * Only the streaming surface sends this, the moment the reply's field closes
   * inside the structured output. What follows on the wire — the state tail's
   * silence, then metadata, notices and `[DONE]` — carries no further text, so
   * a consumer can settle the bubble here instead of leaving a cursor blinking
   * over a finished reply. It says nothing about persistence: `[DONE]` and the
   * notices still own that, and a `turn_not_recorded` can still follow.
   *
   * Optional, and the stream must remain correct without it: a reply recovered
   * by polling can finish without the frame ever being sent.
   */
  onTextDone?: () => void;
  /**
   * Something went wrong that the reply survives — the turn could not be
   * saved, or it had already been answered.
   *
   * Distinct from `{type:"error"}`, which is terminal and rejects the stream.
   * A notice must not stop the reader, because more frames follow: the
   * moderation verdict on the streaming surface arrives *after* the reply, and
   * treating a non-fatal condition as fatal meant the pupil never heard it.
   */
  onNotice?: (notice: { code?: string; message?: string }) => void;
  onDone?: () => void;
  /**
   * Abort if the stream delivers no chunk for this long. An edge function that
   * sends headers and then stalls would otherwise leave the caller awaiting
   * `reader.read()` forever, with no error to surface and no way to retry.
   */
  stallTimeoutMs?: number;
}

/** Default gap allowed between SSE chunks before the stream is treated as dead. */
export const SSE_STALL_TIMEOUT_MS = 90_000;

/** Thrown when a stream opens but then goes silent. Distinguishable for retry. */
export class SSEStallError extends Error {
  constructor(ms: number) {
    super(`Stream stalled: no data for ${Math.round(ms / 1000)}s`);
    this.name = "SSEStallError";
  }
}

/**
 * Thrown when the server reports a failure mid-stream via `{type:"error"}`.
 * Carries the server's own message, which is written for the student.
 */
export class SSEStreamError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = "SSEStreamError";
  }
}

export async function parseSSEStream(
  response: Response,
  options: ParseSSEStreamOptions | ((content: string) => void),
  onDone?: () => void
): Promise<{ content: string; toolCalls: ToolCall[]; metadata?: { state?: any; meta?: any } }> {
  // Support both old and new API
  const callbacks = typeof options === 'function' 
    ? { onContent: options, onDone } 
    : options;

  if (!response.body) throw new Error("No response body");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const stallTimeoutMs = callbacks.stallTimeoutMs ?? SSE_STALL_TIMEOUT_MS;
  let textBuffer = "";
  let fullContent = "";
  const toolCalls: ToolCall[] = [];
  let metadata: { state?: any; meta?: any } | undefined;

  // Race every read against the stall timeout so a silent stream surfaces as an
  // error instead of an await that never settles.
  const readWithTimeout = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new SSEStallError(stallTimeoutMs)), stallTimeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  try {
    return await readStream();
  } catch (err) {
    // Release the underlying connection before propagating. A stalled read or a
    // server-reported failure would otherwise leave the fetch open for the life
    // of the page.
    reader.cancel().catch(() => {});
    throw err;
  }

  async function readStream() {
  while (true) {
    const { done, value } = await readWithTimeout();
    if (done) break;

    textBuffer += decoder.decode(value, { stream: true });

    let newlineIndex: number;
    while ((newlineIndex = textBuffer.indexOf("\n")) !== -1) {
      let line = textBuffer.slice(0, newlineIndex);
      textBuffer = textBuffer.slice(newlineIndex + 1);

      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.startsWith(":") || line.trim() === "") continue;
      if (!line.startsWith("data: ")) continue;

      const jsonStr = line.slice(6).trim();
      if (jsonStr === "[DONE]") {
        callbacks.onDone?.();
        break;
      }

      try {
        const parsed = JSON.parse(jsonStr);
        
        // Handle metadata event (from the streaming tutor functions)
        if (parsed.type === "metadata") {
          metadata = { state: parsed.state, meta: parsed.meta };
          callbacks.onMetadata?.(metadata);
          continue;
        }

        // The reply text is finished; frames after this carry no more of it.
        if (parsed.type === "text_done") {
          callbacks.onTextDone?.();
          continue;
        }

        // Non-fatal. Deliberately does not `throw`: the stream continues, and
        // on the streaming surface the moderation verdict is still to come.
        if (parsed.type === "notice") {
          callbacks.onNotice?.({ code: parsed.code, message: parsed.message });
          continue;
        }

        // Post-delivery moderation, from the streaming surface only. Handled
        // as its own frame rather than folded into `metadata`: it arrives after
        // the metadata frame, and reusing that type would overwrite the tutor
        // state the client has already been given.
        if (parsed.type === "moderation_flag") {
          callbacks.onModerationFlag?.({
            categories: parsed.categories,
            message: parsed.message,
          });
          continue;
        }

        // In-stream failure. The tutor functions send this and then `[DONE]`,
        // so without it the stream looks like a normal empty completion and the
        // reason the turn failed never reaches the student.
        if (parsed.type === "error") {
          throw new SSEStreamError(
            parsed.message || "The tutor could not answer. Please try again.",
            parsed.code,
          );
        }
        
        const delta = parsed.choices?.[0]?.delta;
        
        // Handle content
        const content = delta?.content as string | undefined;
        if (content) {
          fullContent += content;
          callbacks.onContent?.(content);
        }

        // Handle tool calls
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index;
            if (!toolCalls[idx]) {
              toolCalls[idx] = {
                id: tc.id || `tool_${idx}`,
                function: { name: "", arguments: "" },
              };
            }
            if (tc.function?.name) {
              toolCalls[idx].function.name = tc.function.name;
              callbacks.onToolCall?.({ index: idx, name: tc.function.name });
            }
            if (tc.function?.arguments) {
              toolCalls[idx].function.arguments += tc.function.arguments;
              callbacks.onToolCall?.({ index: idx, arguments: tc.function.arguments });
            }
            if (tc.id) {
              toolCalls[idx].id = tc.id;
              callbacks.onToolCall?.({ index: idx, id: tc.id });
            }
          }
        }
      } catch (err) {
        // This catch exists to re-buffer a line split across chunks. A reported
        // stream failure is a real error, not an incomplete line — let it out.
        if (err instanceof SSEStreamError) throw err;
        textBuffer = line + "\n" + textBuffer;
        break;
      }
    }
  }

  return { content: fullContent, toolCalls: toolCalls.filter(tc => tc.function.name), metadata };
  }
}
