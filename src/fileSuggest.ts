// `[[` link suggestions inside the node editor (behaviour spec, phase 2).
// Typing `[[` opens a list of notes, `![[` a list of attachments (images and
// other files that are not notes, spec 5.8); Up/Down move, Enter or Tab picks, Esc
// closes the list only and keeps the edit. While the list is open it owns a
// keymap Scope pushed on top of the map's, so those keys never reach the map.

import { prepareFuzzySearch, Scope, type App, type TFile } from 'obsidian';
import { isImageName, linkQueryAt } from './nodeImage.ts';

const MAX = 10;

export interface SuggestHost {
	/** Text and caret of the editor. */
	read(): { text: string; caret: number } | null;
	/** Replace the editor text and put the caret at `caret`. */
	write(text: string, caret: number): void;
	anchorRect(): DOMRect | null;
}

export class FileSuggest {
	readonly containerEl: HTMLElement;
	private readonly scope: Scope;
	private files: TFile[] = [];
	/** The list is for `![[` (attachments, named with their extension). */
	private embed = false;
	private index = 0;
	private host: SuggestHost | null = null;
	private pushed = false;

	private readonly app: App;

	private readonly sourcePath: () => string;

	constructor(app: App, doc: Document, sourcePath: () => string = () => '') {
		this.app = app;
		this.sourcePath = sourcePath;
		// Attached to the document only while open.
		this.containerEl = doc.body.createDiv({ cls: 'suggestion-container mapdown-file-suggest' });
		this.containerEl.detach();
		this.scope = new Scope(app.scope);
		this.scope.register([], 'ArrowDown', () => this.move(1));
		this.scope.register([], 'ArrowUp', () => this.move(-1));
		this.scope.register([], 'Enter', () => this.pick());
		this.scope.register([], 'Tab', () => this.pick());
		this.scope.register([], 'Escape', () => {
			this.close();
			return false;
		});
	}

	get isOpen(): boolean {
		return this.pushed;
	}

	/** Call on every input in the editor. */
	update(host: SuggestHost): void {
		const state = host.read();
		const q = state ? linkQueryAt(state.text.slice(0, state.caret)) : null;
		if (!q) {
			this.close();
			return;
		}
		this.host = host;
		this.embed = q.embed;
		const all = this.candidates();
		const label = (f: TFile): string => (this.embed ? f.name : f.basename);
		if (q.query === '') {
			this.files = all.slice(0, MAX);
		} else {
			const fuzzy = prepareFuzzySearch(q.query);
			this.files = all
				.map((file) => ({ file, match: fuzzy(label(file)) }))
				.filter((x) => x.match !== null)
				.sort((a, b) => (b.match?.score ?? 0) - (a.match?.score ?? 0))
				.slice(0, MAX)
				.map((x) => x.file);
		}
		if (this.files.length === 0) {
			this.close();
			return;
		}
		this.index = 0;
		this.render();
		const rect = host.anchorRect();
		if (rect) this.containerEl.setCssStyles({ top: `${rect.bottom + 4}px`, left: `${rect.left}px` });
		if (!this.containerEl.isConnected) this.containerEl.ownerDocument.body.appendChild(this.containerEl);
		if (!this.pushed) {
			this.app.keymap.pushScope(this.scope);
			this.pushed = true;
		}
	}

	/** Notes for `[[`; for `![[` attachments, images first. */
	private candidates(): TFile[] {
		if (!this.embed) return this.app.vault.getMarkdownFiles();
		const files = this.app.vault.getFiles().filter((f) => f.extension !== 'md');
		const images = files.filter((f) => isImageName(f.name));
		return [...images, ...files.filter((f) => !isImageName(f.name))];
	}

	close(): void {
		this.containerEl.detach();
		if (this.pushed) {
			this.app.keymap.popScope(this.scope);
			this.pushed = false;
		}
	}

	destroy(): void {
		this.close();
		this.containerEl.remove();
	}

	private render(): void {
		this.containerEl.empty();
		const list = this.containerEl.createDiv({ cls: 'suggestion' });
		this.files.forEach((file, i) => {
			const item = list.createDiv({ cls: 'suggestion-item', text: this.embed ? file.name : file.basename });
			if (i === this.index) item.addClass('is-selected');
			item.addEventListener('mousedown', (evt) => {
				evt.preventDefault();
				this.index = i;
				this.pick();
			});
		});
	}

	private move(by: number): boolean {
		if (this.files.length > 0) {
			this.index = (this.index + by + this.files.length) % this.files.length;
			this.render();
		}
		return false;
	}

	private pick(): boolean {
		const file = this.files[this.index];
		const host = this.host;
		const state = host?.read();
		if (file && host && state) {
			const q = linkQueryAt(state.text.slice(0, state.caret));
			if (q) {
				// the user's link settings decide the form; an embed's `!` is already in the text
				const link = this.app.fileManager.generateMarkdownLink(file, this.sourcePath()).replace(/^!/, '');
				let rest = state.text.slice(state.caret);
				if (rest.startsWith(']]')) rest = rest.slice(2);
				host.write(state.text.slice(0, q.start) + link + rest, q.start + link.length);
			}
		}
		this.close();
		return false;
	}
}
