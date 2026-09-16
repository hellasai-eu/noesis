import { useEditor, EditorContent } from '@tiptap/react';
import type { EditorView } from '@tiptap/pm/view';
import { TextSelection } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
// Aliased: the bare name would shadow the global `Image` constructor.
import ImageExtension from '@tiptap/extension-image';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
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
  Columns2,
  ImagePlus,
  Loader2,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { renderAuthoredHtml } from '@/lib/latex-utils';
import { IMAGE_ACCEPT_ATTRIBUTE, uploadContentImage } from '@/lib/editor-images';
import {
  ImageUploadPlaceholder,
  addPlaceholder,
  findPlaceholder,
  imageUploadPlaceholderKey,
  removePlaceholder,
} from '@/components/editor/image-upload-placeholder';
// The preview renders KaTeX, which is unstyled without its stylesheet.
import 'katex/dist/katex.min.css';

interface CheatSheetEditorProps {
  content: string;
  onChange: (html: string) => void;
}

/** The first image on a drag or paste. Multi-image drops insert one at a time. */
function firstImageFile(list: FileList | null | undefined): File | null {
  if (!list) return null;
  for (const file of Array.from(list)) {
    if (file.type.startsWith('image/')) return file;
  }
  return null;
}

/** File name without its extension — a better alt text than nothing at all. */
function altFromFileName(name: string): string {
  return name.replace(/\.[^./\\]+$/, '').replace(/[_-]+/g, ' ').trim();
}

export function CheatSheetEditor({ content, onChange }: CheatSheetEditorProps) {
  const [mode, setMode] = useState<'visual' | 'html'>('visual');
  const [htmlContent, setHtmlContent] = useState(content);
  // On by default: the editor shows maths as raw `$...$` text, so without the
  // preview there is nowhere in the app an author can check a formula before a
  // student sees it.
  const [showPreview, setShowPreview] = useState(true);
  const [previewHtml, setPreviewHtml] = useState('');
  const [uploadingImage, setUploadingImage] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Debounced so KaTeX is not re-run for every keystroke of a long document.
  useEffect(() => {
    const t = setTimeout(() => setPreviewHtml(renderAuthoredHtml(htmlContent)), 200);
    return () => clearTimeout(t);
  }, [htmlContent]);

  /**
   * Upload, then drop an <img> where the author started the upload. Takes the
   * ProseMirror view rather than the tiptap editor so the paste and drop
   * handlers — which are handed a view and are created before `editor` exists
   * — can share it.
   *
   * The position is held by a placeholder decoration rather than re-read from
   * the selection on completion: the editor stays live during the upload, so
   * the caret may have moved and the selection may now cover text the author
   * would not want replaced. See image-upload-placeholder.ts.
   */
  const uploadAndInsertImage = useCallback(async (file: File, view: EditorView) => {
    const uploadId = crypto.randomUUID();
    addPlaceholder(view, uploadId);
    setUploadingImage(true);
    try {
      const src = await uploadContentImage(file);
      // The author can carry on editing — or close the dialog — while the
      // upload is in flight, so neither the schema nor the view is a given.
      const imageType = view.state.schema.nodes.image;
      if (view.isDestroyed || !imageType) return;

      const at = findPlaceholder(view.state, uploadId);
      // Gone means the author deleted or undid past that spot while waiting.
      // Inserting anyway would put the image somewhere nobody asked for.
      if (at === null) return;

      const node = imageType.create({ src, alt: altFromFileName(file.name) || null });
      view.dispatch(
        view.state.tr
          .replaceWith(at, at, node)
          .setMeta(imageUploadPlaceholderKey, { remove: { id: uploadId } })
          .scrollIntoView(),
      );
      view.focus();
    } catch (error) {
      if (!view.isDestroyed) removePlaceholder(view, uploadId);
      toast.error(error instanceof Error ? error.message : 'Failed to attach the image');
    } finally {
      setUploadingImage(false);
    }
  }, []);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: {
          levels: [1, 2, 3],
        },
        codeBlock: {
          HTMLAttributes: {
            class: 'bg-muted p-4 rounded-md font-mono text-sm',
          },
        },
        blockquote: {
          HTMLAttributes: {
            class: 'border-l-4 border-primary pl-4 italic',
          },
        },
      }),
      Link.configure({
        openOnClick: false,
        HTMLAttributes: {
          class: 'text-primary underline hover:text-primary/80',
        },
      }),
      /*
        Only the chrome is set here. How large an image renders is left to the
        `.prose img` rule in index.css, so the editor, the preview beside it
        and the student view are bounded by ONE rule rather than three that can
        drift apart — the whole point of an editor that shows what a student
        gets.

        `allowBase64` stays off: an author who pastes a data: URI would inline
        megabytes into `theory_html`, which is also the text the question
        generator is prompted with.
      */
      ImageExtension.configure({
        allowBase64: false,
        HTMLAttributes: {
          class: 'rounded-md border border-border',
        },
      }),
      ImageUploadPlaceholder,
    ],
    content,
    editorProps: {
      attributes: {
        class: 'prose prose-sm dark:prose-invert max-w-none min-h-[400px] p-4 focus:outline-none prose-headings:text-foreground prose-headings:font-bold prose-h1:text-2xl prose-h1:border-b prose-h1:border-border prose-h1:pb-2 prose-h1:mb-4 prose-h2:text-xl prose-h2:border-b prose-h2:border-border/50 prose-h2:pb-1.5 prose-h2:mb-3 prose-h3:text-lg prose-h3:mb-2 prose-p:text-foreground prose-p:my-2 prose-li:text-foreground prose-strong:text-foreground prose-strong:font-semibold prose-table:text-foreground prose-ul:my-2 prose-ol:my-2 prose-code:bg-muted prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:text-sm prose-code:font-mono',
      },
      /*
        Pasting a screenshot is how an author actually attaches a diagram —
        the toolbar button is the discoverable path, not the common one.
      */
      handlePaste: (view, event) => {
        const file = firstImageFile(event.clipboardData?.files);
        if (!file) return false;
        event.preventDefault();
        void uploadAndInsertImage(file, view);
        return true;
      },
      handleDrop: (view, event, _slice, moved) => {
        // `moved` means an image already in the document is being dragged to a
        // new position. That is ProseMirror's job, not a fresh upload.
        if (moved) return false;
        const file = firstImageFile(event.dataTransfer?.files);
        if (!file) return false;
        event.preventDefault();
        // Put the cursor where it was dropped, so the upload lands there and
        // not wherever the caret happened to be beforehand.
        const dropped = view.posAtCoords({ left: event.clientX, top: event.clientY });
        if (dropped) {
          view.dispatch(
            view.state.tr.setSelection(TextSelection.create(view.state.doc, dropped.pos)),
          );
        }
        void uploadAndInsertImage(file, view);
        return true;
      },
    },
    onUpdate: ({ editor }) => {
      const html = editor.getHTML();
      setHtmlContent(html);
      onChange(html);
    },
  });

  // Sync content from outside when mode changes or content prop changes
  useEffect(() => {
    if (editor && mode === 'visual' && content !== editor.getHTML()) {
      editor.commands.setContent(content);
      setHtmlContent(content);
    }
  }, [content, editor, mode]);

  // When switching from HTML to visual mode, update editor
  useEffect(() => {
    if (editor && mode === 'visual') {
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
    
    const previousUrl = editor.getAttributes('link').href;
    const url = window.prompt('Enter URL:', previousUrl);

    if (url === null) return;

    if (url === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }

    editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
  }, [editor]);

  const handleImagePicked = useCallback(
    async (input: HTMLInputElement) => {
      const file = input.files?.[0];
      // Cleared first: picking the same file twice in a row fires no `change`
      // event otherwise, so a failed upload could not be retried.
      input.value = '';
      if (!file || !editor) return;
      await uploadAndInsertImage(file, editor.view);
    },
    [editor, uploadAndInsertImage],
  );

  if (!editor) {
    return null;
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/*
        Display is applied only to the ACTIVE pane. Radix marks the inactive
        TabsContent with `hidden`, but an author `display:flex` beats the UA
        `[hidden] { display: none }` rule, so an unconditional `flex` class left
        the inactive pane laying out — two `flex-1` siblings then split the box
        and each editor rendered at half height, with the HTML pane pushed to
        the bottom.
      */}
      <Tabs value={mode} onValueChange={(v) => setMode(v as 'visual' | 'html')} className="flex flex-col h-full overflow-hidden">
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
        
        <TabsContent value="visual" className="flex-1 mt-2 overflow-hidden data-[state=active]:flex data-[state=active]:flex-col">
          <div className="border rounded-md bg-background flex flex-col flex-1 overflow-hidden">
            {/* Toolbar */}
            <div className="flex flex-wrap gap-1 p-2 border-b bg-muted/30 shrink-0">
              <Button
                type="button"
                variant={editor.isActive('heading', { level: 1 }) ? 'secondary' : 'ghost'}
                size="sm"
                onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
                className="h-8 w-8 p-0"
                title="Heading 1"
              >
                <Heading1 className="w-4 h-4" />
              </Button>
              <Button
                type="button"
                variant={editor.isActive('heading', { level: 2 }) ? 'secondary' : 'ghost'}
                size="sm"
                onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
                className="h-8 w-8 p-0"
                title="Heading 2"
              >
                <Heading2 className="w-4 h-4" />
              </Button>
              <Button
                type="button"
                variant={editor.isActive('heading', { level: 3 }) ? 'secondary' : 'ghost'}
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
                variant={editor.isActive('bold') ? 'secondary' : 'ghost'}
                size="sm"
                onClick={() => editor.chain().focus().toggleBold().run()}
                className="h-8 w-8 p-0"
                title="Bold"
              >
                <Bold className="w-4 h-4" />
              </Button>
              <Button
                type="button"
                variant={editor.isActive('italic') ? 'secondary' : 'ghost'}
                size="sm"
                onClick={() => editor.chain().focus().toggleItalic().run()}
                className="h-8 w-8 p-0"
                title="Italic"
              >
                <Italic className="w-4 h-4" />
              </Button>
              <Button
                type="button"
                variant={editor.isActive('strike') ? 'secondary' : 'ghost'}
                size="sm"
                onClick={() => editor.chain().focus().toggleStrike().run()}
                className="h-8 w-8 p-0"
                title="Strikethrough"
              >
                <Strikethrough className="w-4 h-4" />
              </Button>
              <Button
                type="button"
                variant={editor.isActive('code') ? 'secondary' : 'ghost'}
                size="sm"
                onClick={() => editor.chain().focus().toggleCode().run()}
                className="h-8 w-8 p-0"
                title="Inline Code"
              >
                <Code className="w-4 h-4" />
              </Button>
              <div className="w-px h-6 bg-border self-center mx-1" />
              <Button
                type="button"
                variant={editor.isActive('bulletList') ? 'secondary' : 'ghost'}
                size="sm"
                onClick={() => editor.chain().focus().toggleBulletList().run()}
                className="h-8 w-8 p-0"
                title="Bullet List"
              >
                <List className="w-4 h-4" />
              </Button>
              <Button
                type="button"
                variant={editor.isActive('orderedList') ? 'secondary' : 'ghost'}
                size="sm"
                onClick={() => editor.chain().focus().toggleOrderedList().run()}
                className="h-8 w-8 p-0"
                title="Numbered List"
              >
                <ListOrdered className="w-4 h-4" />
              </Button>
              <Button
                type="button"
                variant={editor.isActive('blockquote') ? 'secondary' : 'ghost'}
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
                variant={editor.isActive('link') ? 'secondary' : 'ghost'}
                size="sm"
                onClick={setLink}
                className="h-8 w-8 p-0"
                title="Add Link"
              >
                <LinkIcon className="w-4 h-4" />
              </Button>
              {/*
                The picker is the discoverable path; pasting or dragging an
                image into the editor does the same thing — see `handlePaste`.
              */}
              <input
                ref={fileInputRef}
                type="file"
                accept={IMAGE_ACCEPT_ATTRIBUTE}
                className="hidden"
                data-testid="editor-image-input"
                onChange={(e) => void handleImagePicked(e.currentTarget)}
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploadingImage}
                className="h-8 w-8 p-0"
                title="Insert an image — or just paste or drag one in"
                aria-label="Insert image"
                data-testid="editor-insert-image"
              >
                {uploadingImage ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <ImagePlus className="w-4 h-4" />
                )}
              </Button>
              {editor.isActive('link') && (
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
              <div className="w-px h-6 bg-border self-center mx-1" />
              <Button
                type="button"
                variant={showPreview ? 'secondary' : 'ghost'}
                size="sm"
                onClick={() => setShowPreview((v) => !v)}
                className="h-8 px-2 gap-1.5"
                title={showPreview ? 'Hide the rendered preview' : 'Show the rendered preview'}
                aria-pressed={showPreview}
                data-testid="editor-toggle-preview"
              >
                <Columns2 className="w-4 h-4" />
                <span className="text-xs hidden sm:inline">Preview</span>
              </Button>
            </div>

            {/*
              Editor and preview side by side. The editor shows maths as the
              raw `$...$` the generators emit; the preview runs the SAME
              renderer the student view uses, so what an author checks here is
              what a student gets — not an approximation of it.

              Stacks on narrow viewports, where two columns of dense prose
              would leave neither readable.
            */}
            <div className="flex flex-col lg:flex-row flex-1 overflow-hidden">
              <ScrollArea className={showPreview ? 'flex-1 overflow-auto lg:w-1/2' : 'flex-1 overflow-auto'}>
                <EditorContent
                  editor={editor}
                  className="[&_.ProseMirror]:min-h-[300px] [&_.ProseMirror]:p-4"
                />
              </ScrollArea>
              {showPreview && (
                <>
                  <div className="hidden lg:block w-px bg-border shrink-0" />
                  <div className="lg:hidden h-px bg-border shrink-0" />
                  <ScrollArea className="flex-1 overflow-auto lg:w-1/2 bg-muted/20">
                    <div className="px-2 pt-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                      Preview — as students see it
                    </div>
                    <div
                      className="prose prose-sm dark:prose-invert max-w-none p-4 min-h-[300px]"
                      data-testid="editor-preview"
                      dangerouslySetInnerHTML={{ __html: previewHtml }}
                    />
                  </ScrollArea>
                </>
              )}
            </div>
          </div>
        </TabsContent>
        
        <TabsContent value="html" className="flex-1 mt-2 overflow-hidden data-[state=active]:flex data-[state=active]:flex-col">
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
