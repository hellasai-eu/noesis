/**
 * Issue #728: rich-text editor for the instructor-facing printable test
 * document. Built on the same TipTap stack as `CheatSheetEditor` and
 * extended with:
 *   - a "Page break" toolbar button (PageBreak node renders
 *     `<div class="page-break"></div>` — matched by the print stylesheet
 *     in `convert-html-to-pdf`).
 *   - a font-size dropdown wired to `@tiptap/extension-text-style`'s
 *     `FontSize` mark — selections emit `<span style="font-size: ...px">`
 *     which the PDF renderer respects.
 *
 * HTML in/out via `editor.getHTML()`; callers persist the result onto
 * `tests.html_content` and route the PDF export through the new HTML
 * pipeline.
 */
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import { TextStyle, FontSize } from "@tiptap/extension-text-style";
import { PageBreak } from "@/components/test-editor/PageBreakExtension";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Bold,
  Italic,
  List,
  ListOrdered,
  Link as LinkIcon,
  Heading1,
  Heading2,
  Heading3,
  Undo,
  Redo,
  Unlink,
  Code,
  Quote,
  Strikethrough,
  FileCode,
  Eye,
  SeparatorHorizontal,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

interface TestDocumentEditorProps {
  content: string;
  onChange: (html: string) => void;
}

const FONT_SIZE_OPTIONS: { label: string; value: string }[] = [
  { label: "Default", value: "" },
  { label: "10px", value: "10px" },
  { label: "12px", value: "12px" },
  { label: "14px", value: "14px" },
  { label: "16px", value: "16px" },
  { label: "18px", value: "18px" },
  { label: "20px", value: "20px" },
  { label: "24px", value: "24px" },
  { label: "28px", value: "28px" },
  { label: "32px", value: "32px" },
];

const DEFAULT_FONT_VALUE = "__default__";

export function TestDocumentEditor({ content, onChange }: TestDocumentEditorProps) {
  const [mode, setMode] = useState<"visual" | "html">("visual");
  const [htmlContent, setHtmlContent] = useState(content);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
      }),
      Link.configure({
        openOnClick: false,
        HTMLAttributes: { class: "text-primary underline hover:text-primary/80" },
      }),
      TextStyle,
      FontSize,
      PageBreak,
    ],
    content,
    editorProps: {
      attributes: {
        class:
          "prose prose-sm dark:prose-invert max-w-none min-h-[400px] p-4 focus:outline-none prose-headings:text-foreground prose-headings:font-bold prose-h1:text-2xl prose-h2:text-xl prose-h3:text-lg prose-p:text-foreground prose-li:text-foreground prose-strong:text-foreground",
      },
    },
    onUpdate: ({ editor }) => {
      const html = editor.getHTML();
      setHtmlContent(html);
      onChange(html);
    },
  });

  useEffect(() => {
    if (editor && mode === "visual" && content !== editor.getHTML()) {
      editor.commands.setContent(content);
      setHtmlContent(content);
    }
  }, [content, editor, mode]);

  useEffect(() => {
    if (editor && mode === "visual") {
      editor.commands.setContent(htmlContent);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally only sync when switching to visual mode
  }, [mode, editor]);

  const handleHtmlChange = (value: string) => {
    setHtmlContent(value);
    onChange(value);
  };

  const setLink = useCallback(() => {
    if (!editor) return;
    const previousUrl = editor.getAttributes("link").href;
    const url = window.prompt("Enter URL:", previousUrl);
    if (url === null) return;
    if (url === "") {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
  }, [editor]);

  const currentFontSize: string =
    (editor?.getAttributes("textStyle").fontSize as string | undefined) ?? "";

  const applyFontSize = (value: string) => {
    if (!editor) return;
    if (value === DEFAULT_FONT_VALUE || value === "") {
      editor.chain().focus().unsetFontSize().run();
    } else {
      editor.chain().focus().setFontSize(value).run();
    }
  };

  if (!editor) return null;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <Tabs
        value={mode}
        onValueChange={(v) => setMode(v as "visual" | "html")}
        className="flex flex-col h-full overflow-hidden"
      >
        <TabsList className="grid w-full grid-cols-2 shrink-0">
          <TabsTrigger value="visual" className="flex items-center gap-2">
            <Eye className="w-4 h-4" />
            Visual Editor
          </TabsTrigger>
          <TabsTrigger value="html" className="flex items-center gap-2">
            <FileCode className="w-4 h-4" />
            HTML
          </TabsTrigger>
        </TabsList>

        <TabsContent
          value="visual"
          className="flex-1 flex flex-col mt-2 overflow-hidden"
        >
          <div className="border rounded-md bg-background flex flex-col flex-1 overflow-hidden">
            <div
              className="flex flex-wrap gap-1 p-2 border-b bg-muted/30 shrink-0"
              data-testid="test-document-editor-toolbar"
            >
              <Button
                type="button"
                variant={editor.isActive("heading", { level: 1 }) ? "secondary" : "ghost"}
                size="sm"
                onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
                className="h-8 w-8 p-0"
                title="Heading 1"
              >
                <Heading1 className="w-4 h-4" />
              </Button>
              <Button
                type="button"
                variant={editor.isActive("heading", { level: 2 }) ? "secondary" : "ghost"}
                size="sm"
                onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
                className="h-8 w-8 p-0"
                title="Heading 2"
              >
                <Heading2 className="w-4 h-4" />
              </Button>
              <Button
                type="button"
                variant={editor.isActive("heading", { level: 3 }) ? "secondary" : "ghost"}
                size="sm"
                onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
                className="h-8 w-8 p-0"
                title="Heading 3"
              >
                <Heading3 className="w-4 h-4" />
              </Button>

              <div className="w-px h-6 bg-border self-center mx-1" />

              <Button
                type="button"
                variant={editor.isActive("bold") ? "secondary" : "ghost"}
                size="sm"
                onClick={() => editor.chain().focus().toggleBold().run()}
                className="h-8 w-8 p-0"
                title="Bold"
              >
                <Bold className="w-4 h-4" />
              </Button>
              <Button
                type="button"
                variant={editor.isActive("italic") ? "secondary" : "ghost"}
                size="sm"
                onClick={() => editor.chain().focus().toggleItalic().run()}
                className="h-8 w-8 p-0"
                title="Italic"
              >
                <Italic className="w-4 h-4" />
              </Button>
              <Button
                type="button"
                variant={editor.isActive("strike") ? "secondary" : "ghost"}
                size="sm"
                onClick={() => editor.chain().focus().toggleStrike().run()}
                className="h-8 w-8 p-0"
                title="Strikethrough"
              >
                <Strikethrough className="w-4 h-4" />
              </Button>
              <Button
                type="button"
                variant={editor.isActive("code") ? "secondary" : "ghost"}
                size="sm"
                onClick={() => editor.chain().focus().toggleCode().run()}
                className="h-8 w-8 p-0"
                title="Inline Code"
              >
                <Code className="w-4 h-4" />
              </Button>

              <div className="w-px h-6 bg-border self-center mx-1" />

              <div className="flex items-center" title="Font size">
                <Select
                  value={currentFontSize || DEFAULT_FONT_VALUE}
                  onValueChange={applyFontSize}
                >
                  <SelectTrigger
                    className="h-8 w-[110px]"
                    aria-label="Font size"
                    data-testid="font-size-select"
                  >
                    <SelectValue placeholder="Font size" />
                  </SelectTrigger>
                  <SelectContent>
                    {FONT_SIZE_OPTIONS.map((opt) => (
                      <SelectItem
                        key={opt.label}
                        value={opt.value === "" ? DEFAULT_FONT_VALUE : opt.value}
                      >
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="w-px h-6 bg-border self-center mx-1" />

              <Button
                type="button"
                variant={editor.isActive("bulletList") ? "secondary" : "ghost"}
                size="sm"
                onClick={() => editor.chain().focus().toggleBulletList().run()}
                className="h-8 w-8 p-0"
                title="Bullet List"
              >
                <List className="w-4 h-4" />
              </Button>
              <Button
                type="button"
                variant={editor.isActive("orderedList") ? "secondary" : "ghost"}
                size="sm"
                onClick={() => editor.chain().focus().toggleOrderedList().run()}
                className="h-8 w-8 p-0"
                title="Numbered List"
              >
                <ListOrdered className="w-4 h-4" />
              </Button>
              <Button
                type="button"
                variant={editor.isActive("blockquote") ? "secondary" : "ghost"}
                size="sm"
                onClick={() => editor.chain().focus().toggleBlockquote().run()}
                className="h-8 w-8 p-0"
                title="Quote"
              >
                <Quote className="w-4 h-4" />
              </Button>

              <div className="w-px h-6 bg-border self-center mx-1" />

              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => editor.chain().focus().insertPageBreak().run()}
                className="h-8 px-2 gap-1"
                title="Insert page break"
                data-testid="page-break-button"
              >
                <SeparatorHorizontal className="w-4 h-4" />
                <span className="text-xs">Page break</span>
              </Button>

              <div className="w-px h-6 bg-border self-center mx-1" />

              <Button
                type="button"
                variant={editor.isActive("link") ? "secondary" : "ghost"}
                size="sm"
                onClick={setLink}
                className="h-8 w-8 p-0"
                title="Add Link"
              >
                <LinkIcon className="w-4 h-4" />
              </Button>
              {editor.isActive("link") && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => editor.chain().focus().unsetLink().run()}
                  className="h-8 w-8 p-0"
                  title="Remove Link"
                >
                  <Unlink className="w-4 h-4" />
                </Button>
              )}

              <div className="w-px h-6 bg-border self-center mx-1" />

              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => editor.chain().focus().undo().run()}
                disabled={!editor.can().undo()}
                className="h-8 w-8 p-0"
                title="Undo"
              >
                <Undo className="w-4 h-4" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => editor.chain().focus().redo().run()}
                disabled={!editor.can().redo()}
                className="h-8 w-8 p-0"
                title="Redo"
              >
                <Redo className="w-4 h-4" />
              </Button>
            </div>

            <ScrollArea className="flex-1 overflow-auto">
              <EditorContent
                editor={editor}
                className="[&_.ProseMirror]:min-h-[300px] [&_.ProseMirror]:p-4 [&_.ProseMirror_.page-break]:my-4 [&_.ProseMirror_.page-break]:h-3 [&_.ProseMirror_.page-break]:border-t-2 [&_.ProseMirror_.page-break]:border-dashed [&_.ProseMirror_.page-break]:border-muted-foreground/40"
              />
            </ScrollArea>
          </div>
        </TabsContent>

        <TabsContent
          value="html"
          className="flex-1 flex flex-col mt-2 overflow-hidden"
        >
          <Textarea
            value={htmlContent}
            onChange={(e) => handleHtmlChange(e.target.value)}
            className="flex-1 font-mono text-sm resize-none overflow-auto"
            placeholder="Enter HTML content..."
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
