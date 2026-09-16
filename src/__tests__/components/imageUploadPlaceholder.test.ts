/**
 * The position an in-flight image upload is holding (#1217).
 *
 * These drive a real EditorState rather than a rendered editor, on purpose.
 * The behaviour under test is that the remembered position MOVES when the
 * author edits above it — and jsdom cannot demonstrate that: a synthetic click
 * does not move a ProseMirror selection, so a component-level version of this
 * test passes whether the mapping works or not. Asking the state directly is
 * the only way to make the assertion mean something.
 */
import { describe, it, expect } from 'vitest';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import type { Transaction } from '@tiptap/pm/state';
import { Schema } from '@tiptap/pm/model';
import {
  addPlaceholder,
  createImageUploadPlaceholderPlugin,
  findPlaceholder,
  removePlaceholder,
} from '@/components/editor/image-upload-placeholder';

// A minimal schema — this is about positions, not about node types.
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*', toDOM: () => ['p', 0] },
    text: { group: 'inline' },
  },
});

/** `<p>Alpha</p><p>Omega</p>`: "Alpha" spans 1..6, "Omega" spans 8..13. */
function makeState() {
  const doc = schema.node('doc', null, [
    schema.node('paragraph', null, [schema.text('Alpha')]),
    schema.node('paragraph', null, [schema.text('Omega')]),
  ]);
  return EditorState.create({ doc, plugins: [createImageUploadPlaceholderPlugin()] });
}

/** A stand-in for the ProseMirror view: somewhere to apply transactions. */
function makeView(initial: EditorState) {
  let state = initial;
  return {
    get state() {
      return state;
    },
    dispatch(tr: Transaction) {
      state = state.apply(tr);
    },
  };
}

type View = ReturnType<typeof makeView>;

/** Put the caret at `pos`, then start an upload there — as a paste would. */
function startUploadAt(view: View, id: string, pos: number) {
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
  addPlaceholder(view, id);
}

describe('image upload placeholder', () => {
  it('remembers where the upload started', () => {
    const view = makeView(makeState());
    startUploadAt(view, 'up-1', 9);
    expect(findPlaceholder(view.state, 'up-1')).toBe(9);
  });

  it('MOVES the position when the author types above it', () => {
    // The regression this guards. Without the mapping the marker would still
    // report 9, so the image would land four characters left of where the
    // author put it — or, with a selection live, replace their text.
    const view = makeView(makeState());
    startUploadAt(view, 'up-2', 9);
    expect(findPlaceholder(view.state, 'up-2')).toBe(9);

    view.dispatch(view.state.tr.insertText('XXXX', 1));

    expect(findPlaceholder(view.state, 'up-2')).toBe(13);
  });

  it('is unmoved by an edit BELOW it', () => {
    const view = makeView(makeState());
    startUploadAt(view, 'up-3', 3);
    view.dispatch(view.state.tr.insertText('ZZZZ', 9));
    expect(findPlaceholder(view.state, 'up-3')).toBe(3);
  });

  it('reports gone when the author deletes the region it was holding', () => {
    const view = makeView(makeState());
    startUploadAt(view, 'up-4', 3);
    expect(findPlaceholder(view.state, 'up-4')).toBe(3);

    // Wipe the document, as a select-all-delete or an undo would.
    view.dispatch(view.state.tr.delete(0, view.state.doc.content.size));

    // Null is the signal to drop the image rather than guess at a position.
    expect(findPlaceholder(view.state, 'up-4')).toBeNull();
  });

  it('clears only the marker it is asked to clear', () => {
    const view = makeView(makeState());
    startUploadAt(view, 'up-a', 2);
    startUploadAt(view, 'up-b', 4);

    removePlaceholder(view, 'up-a');

    expect(findPlaceholder(view.state, 'up-a')).toBeNull();
    expect(findPlaceholder(view.state, 'up-b')).toBe(4);
  });

  it('tolerates clearing a marker that has already gone', () => {
    const view = makeView(makeState());
    startUploadAt(view, 'up-5', 2);
    removePlaceholder(view, 'up-5');
    expect(() => removePlaceholder(view, 'up-5')).not.toThrow();
  });
});
