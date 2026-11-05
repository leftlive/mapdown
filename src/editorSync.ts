// Editor side of text/map selection sync: a CodeMirror extension that briefly
// highlights the line of the node selected in the map.
import { StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';
import { MarkdownView } from 'obsidian';
import { DOM } from './view/contract.ts';

const FLASH_MS = 1200;

const setFlashLine = StateEffect.define<number | null>();

const flashLineField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(decorations, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setFlashLine)) {
        if (effect.value === null || effect.value > tr.state.doc.lines) {
          return Decoration.none;
        }
        const line = tr.state.doc.line(effect.value);
        return Decoration.set([
          Decoration.line({ class: DOM.syncLine }).range(line.from),
        ]);
      }
    }
    return decorations.map(tr.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});

export const editorSyncExtension = [flashLineField];

// Text -> map: report user cursor moves. Only a focused editor counts, so the
// cursor moves made by map -> text sync (editor unfocused) never echo back.
export function createCursorListener(onCursor: (cm: EditorView) => void) {
  return EditorView.updateListener.of((update) => {
    if (update.selectionSet && update.view.hasFocus) {
      onCursor(update.view);
    }
  });
}

/** The CodeMirror view behind a Markdown view's editor, if it has one. */
export function getEditorView(view: MarkdownView): EditorView | null {
  const cm = (view.editor as unknown as { cm?: unknown } | undefined)?.cm;
  return cm instanceof EditorView ? cm : null;
}

const flashTimers = new WeakMap<EditorView, number>();

function flashLine(cm: EditorView, line: number) {
  // CodeMirror lines are 1-based.
  cm.dispatch({ effects: setFlashLine.of(line + 1) });
  const ownerWindow = cm.dom.ownerDocument.defaultView ?? window;
  const previous = flashTimers.get(cm);
  if (previous !== undefined) {
    ownerWindow.clearTimeout(previous);
  }
  flashTimers.set(cm, ownerWindow.setTimeout(() => {
    flashTimers.delete(cm);
    cm.dispatch({ effects: setFlashLine.of(null) });
  }, FLASH_MS));
}

// Move a Markdown view to a 0-based file line without taking focus.
export function revealLineInMarkdown(view: MarkdownView, line: number) {
  if (view.getMode() === 'preview') {
    view.setEphemeralState({ line });
    return;
  }
  const editor = view.editor;
  const target = Math.max(0, Math.min(line, editor.lineCount() - 1));
  const pos = { line: target, ch: 0 };
  editor.setCursor(pos);
  editor.scrollIntoView({ from: pos, to: pos }, true);
  const cm = getEditorView(view);
  if (cm) {
    flashLine(cm, target);
  }
}
