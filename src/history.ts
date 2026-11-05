// The map's own undo history (development plan 3.2). Each step stores the
// edits that redo it (on the text before) and undo it (on the text after),
// plus the selection on each side. Edits made elsewhere (the Markdown editor,
// another program) are mapped through every stored step; a step that the
// outside edit touches cannot be mapped and is dropped together with every
// older step, since those were recorded against text that no longer exists.

import type { TextEdit } from './core/types.ts';
import { mapPos, rebaseEdits } from './controller/textEdits.ts';

/** A selection that survives re-parsing: each id with its node's first-line offset. */
export interface SelectionSnapshot {
	ids: string[];
	primary: string | null;
	/** Offset of each id's first line (same order as ids); -1 for the virtual root. */
	offsets: number[];
}

export interface HistoryStep {
	/** Edits on the text before the step. */
	forward: TextEdit[];
	/** Edits on the text after the step. */
	inverse: TextEdit[];
	before: SelectionSnapshot;
	after: SelectionSnapshot;
}

const LIMIT = 200;

function mapSelection(sel: SelectionSnapshot, edits: readonly TextEdit[]): SelectionSnapshot {
	return { ...sel, offsets: sel.offsets.map((o) => (o < 0 ? o : mapPos(o, edits, 1))) };
}

export class History {
	private undos: HistoryStep[] = [];
	private redos: HistoryStep[] = [];

	get undoSize(): number {
		return this.undos.length;
	}

	get redoSize(): number {
		return this.redos.length;
	}

	clear(): void {
		this.undos = [];
		this.redos = [];
	}

	push(step: HistoryStep): void {
		if (step.forward.length === 0) return;
		this.undos.push(step);
		if (this.undos.length > LIMIT) this.undos.shift();
		this.redos = [];
	}

	/** Takes the step to undo; the caller applies `inverse` and calls `didUndo`. */
	peekUndo(): HistoryStep | null {
		return this.undos[this.undos.length - 1] ?? null;
	}

	peekRedo(): HistoryStep | null {
		return this.redos[this.redos.length - 1] ?? null;
	}

	didUndo(): void {
		const step = this.undos.pop();
		if (step) this.redos.push(step);
	}

	didRedo(): void {
		const step = this.redos.pop();
		if (step) this.undos.push(step);
	}

	/** Map every step through `edits`, made on the current text by someone else. */
	mapOutside(edits: readonly TextEdit[]): void {
		if (edits.length === 0) return;
		this.undos = rebaseStack(this.undos, edits, 'inverse');
		this.redos = rebaseStack(this.redos, edits, 'forward');
	}
}

/**
 * Rebase a stack (top = last) whose top step's `onCurrent` edits apply to the
 * current text. Walks down: each step's other side applies to the text the
 * next step's `onCurrent` side produces.
 */
function rebaseStack(stack: HistoryStep[], outside: readonly TextEdit[], onCurrent: 'inverse' | 'forward'): HistoryStep[] {
	const other = onCurrent === 'inverse' ? 'forward' : 'inverse';
	const kept: HistoryStep[] = [];
	let change: readonly TextEdit[] = outside;
	for (let i = stack.length - 1; i >= 0; i--) {
		const step = stack[i];
		if (!step) break;
		// `change` is on the text that step[onCurrent] applies to.
		const r = rebaseEdits(step[onCurrent], change);
		if (!r) break; // unmappable: drop this step and everything older
		// r.other: `change` on the text after step[onCurrent], which step[other] applies to.
		const r2 = rebaseEdits(step[other], r.other);
		if (!r2) break;
		const currentSel = onCurrent === 'inverse' ? 'after' : 'before';
		const otherSel = onCurrent === 'inverse' ? 'before' : 'after';
		kept.unshift({
			...step,
			[onCurrent]: r.edits,
			[other]: r2.edits,
			[currentSel]: mapSelection(step[currentSel], change),
			[otherSel]: mapSelection(step[otherSel], r.other),
		});
		change = r.other;
	}
	return kept;
}
