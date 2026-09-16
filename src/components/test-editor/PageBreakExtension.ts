/**
 * Issue #728: hard page-break node for the test document editor.
 *
 * Renders as `<div class="page-break"></div>` so the print stylesheet in
 * `convert-html-to-pdf` (which sets `page-break-after: always` on
 * `.page-break`) drops a new page after the node when the document is
 * sent to ConvertAPI. The node is `atom: true` so the editor treats it
 * as a non-editable block — instructors insert/remove it as a unit.
 */
import { Node, mergeAttributes } from "@tiptap/core";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    pageBreak: {
      /** Insert a hard page break at the cursor. */
      insertPageBreak: () => ReturnType;
    };
  }
}

export const PageBreak = Node.create({
  name: "pageBreak",
  group: "block",
  atom: true,
  selectable: true,
  draggable: false,

  parseHTML() {
    return [{ tag: 'div[class~="page-break"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        class: "page-break",
        "data-page-break": "true",
      }),
    ];
  },

  addCommands() {
    return {
      insertPageBreak:
        () =>
        ({ commands }) =>
          commands.insertContent({ type: this.name }),
    };
  },
});
