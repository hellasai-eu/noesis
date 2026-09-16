/**
 * Holds an author's place while an image uploads (#1217).
 *
 * An upload takes about a second, and the editor stays live throughout — the
 * author can carry on typing, click somewhere else, or select a paragraph.
 * Inserting at `state.selection` when the upload finally resolves therefore
 * drops the image wherever the caret has drifted to, and if the author has
 * selected text by then, `replaceSelectionWith` REPLACES it.
 *
 * The position has to be remembered from the paste/drop/pick and then carried
 * across every edit that lands in between. A plain number cannot do that — an
 * insertion above it silently makes it point somewhere else — so this is the
 * decoration recipe from the ProseMirror docs: a widget decoration is added at
 * the initiating position, and `DecorationSet.map` moves it in step with every
 * subsequent transaction. Reading the decoration back when the upload resolves
 * gives the position the author actually meant.
 *
 * It pays for itself twice: the widget is also the only feedback that an
 * upload is in flight at that spot in the text.
 */
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { Extension } from '@tiptap/core';

export const imageUploadPlaceholderKey = new PluginKey<DecorationSet>('imageUploadPlaceholder');

interface PlaceholderMeta {
  add?: { id: string; pos: number };
  remove?: { id: string };
}

function buildWidget(): HTMLElement {
  const el = document.createElement('span');
  el.className = 'editor-image-placeholder';
  el.setAttribute('aria-label', 'Uploading image');
  el.textContent = 'Uploading image…';
  return el;
}

/**
 * Exported so a test can build an EditorState around the same plugin the
 * editor uses. The position mapping is the whole behaviour here, and it cannot
 * be observed honestly through jsdom — a synthetic click does not move a
 * ProseMirror selection, so a component-level test of it passes whether the
 * mapping works or not.
 */
export function createImageUploadPlaceholderPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: imageUploadPlaceholderKey,
    state: {
      init: () => DecorationSet.empty,
      apply(tr: Transaction, set: DecorationSet) {
        // The mapping is the whole point: it walks the placeholder along with
        // whatever the author typed, deleted or pasted meanwhile.
        let next = set.map(tr.mapping, tr.doc);
        const meta = tr.getMeta(imageUploadPlaceholderKey) as PlaceholderMeta | undefined;

        if (meta?.add) {
          const deco = Decoration.widget(meta.add.pos, buildWidget(), { id: meta.add.id });
          next = next.add(tr.doc, [deco]);
        }
        if (meta?.remove) {
          const id = meta.remove.id;
          next = next.remove(next.find(undefined, undefined, (spec) => spec.id === id));
        }
        return next;
      },
    },
    props: {
      decorations(state: EditorState) {
        return imageUploadPlaceholderKey.getState(state);
      },
    },
  });
}

export const ImageUploadPlaceholder = Extension.create({
  name: 'imageUploadPlaceholder',

  addProseMirrorPlugins() {
    return [createImageUploadPlaceholderPlugin()];
  },
});

/** Marks where an upload started. Call before awaiting the upload. */
export function addPlaceholder(view: { state: EditorState; dispatch: (tr: Transaction) => void }, id: string): void {
  const { state } = view;
  const tr = state.tr.setMeta(imageUploadPlaceholderKey, {
    // `from`, not `to`: an author who pasted over a selection expects the
    // image where the selection began.
    add: { id, pos: state.selection.from },
  } satisfies PlaceholderMeta);
  view.dispatch(tr);
}

/**
 * Where the placeholder ended up, or null if it is gone — which happens when
 * the author deleted the surrounding text, or undid past it, while the upload
 * was in flight. Null means "the author no longer wants this here": drop the
 * image rather than guessing at a position.
 */
export function findPlaceholder(state: EditorState, id: string): number | null {
  const set = imageUploadPlaceholderKey.getState(state);
  const found = set?.find(undefined, undefined, (spec) => spec.id === id);
  return found && found.length > 0 ? found[0].from : null;
}

/** Clears the marker. Safe to call when it has already gone. */
export function removePlaceholder(
  view: { state: EditorState; dispatch: (tr: Transaction) => void },
  id: string,
): void {
  view.dispatch(
    view.state.tr.setMeta(imageUploadPlaceholderKey, { remove: { id } } satisfies PlaceholderMeta),
  );
}
