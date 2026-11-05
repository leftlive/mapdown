// Images in nodes (behaviour spec 5.8), the Obsidian side: saving pasted or
// dropped images as attachments, the drop target on the map, and the image
// picker behind the `insert-image` command, the node menu and the touch
// toolbar. Every way ends in MapView.addImageLink, so the result is the same:
// an embed (`![[name]]` by default) in the node's text, one undo step.

import { Notice, SuggestModal, TFile, normalizePath, prepareFuzzySearch, type App } from 'obsidian';
import { attachmentName, embedFor, isImageFile, isImageName } from '../nodeImage.ts';
import { t } from '../i18n.ts';
import { DOM } from './contract.ts';
import type { MapView } from './MapView.ts';

/** Save `data` as an attachment of `sourcePath`, where Obsidian's attachment setting says. */
export async function saveAttachment(app: App, name: string, data: ArrayBuffer, sourcePath: string): Promise<TFile> {
	const path = normalizePath(await app.fileManager.getAvailablePathForAttachment(name, sourcePath));
	const slash = path.lastIndexOf('/');
	if (slash > 0) {
		const dir = path.slice(0, slash);
		if (!app.vault.getAbstractFileByPath(dir)) await app.vault.createFolder(dir).catch(() => undefined);
	}
	return app.vault.createBinary(path, data);
}

/** The embed of a vault file, written the way the user's link settings say (spec 5.8), relative to the map's note. */
export function embedOf(app: App, file: TFile, sourcePath: string, width?: number): string {
	return embedFor(file, (f, alias) => app.fileManager.generateMarkdownLink(f, sourcePath, undefined, alias), width);
}

/** Image files in a paste or drop (OS files; a screenshot on the clipboard is one too). */
export function imageFiles(dt: DataTransfer | null): File[] {
	if (!dt) return [];
	const out: File[] = [];
	for (const f of Array.from(dt.files)) if (isImageFile(f)) out.push(f);
	if (out.length === 0) {
		for (const item of Array.from(dt.items ?? [])) {
			if (item.kind !== 'file') continue;
			const f = item.getAsFile();
			if (f && isImageFile(f)) out.push(f);
		}
	}
	return out;
}

/** During dragover the files are hidden; the item types tell whether an image is coming. */
function mayHoldImage(dt: DataTransfer | null): boolean {
	return Array.from(dt?.items ?? []).some((i) => i.kind === 'file' && i.type.startsWith('image/'));
}

interface Draggable {
	type?: string;
	file?: unknown;
	files?: unknown;
}

/** Vault images dragged from Obsidian's file explorer. Uses the internal drag manager, guarded. */
export function draggedVaultImages(app: App): TFile[] {
	const drag = (app as unknown as { dragManager?: { draggable?: Draggable | null } }).dragManager?.draggable;
	if (!drag) return [];
	const list = drag.type === 'file' ? [drag.file] : drag.type === 'files' && Array.isArray(drag.files) ? drag.files : [];
	return list.filter((f): f is TFile => f instanceof TFile && isImageName(f.name));
}

/** Save image files from outside the vault and add them to node `id`. */
export async function addImageFiles(view: MapView, id: string, files: readonly File[], atCaret: boolean): Promise<void> {
	const source = view.file?.path ?? '';
	const now = new Date();
	const links: string[] = [];
	for (const f of files) {
		const name = attachmentName(f, now);
		if (!name) continue;
		try {
			const saved = await saveAttachment(view.app, name, await f.arrayBuffer(), source);
			links.push(embedOf(view.app, saved, source));
		} catch (err) {
			console.error('Mapdown: could not save the image:', err);
			new Notice(t('image-save-failed'));
		}
	}
	if (links.length > 0) view.addImageLink(id, links.join(atCaret ? ' ' : '\n'), atCaret);
}

/** Spec 5.8 drop: an image onto a node is added to that node; onto empty canvas nothing happens. */
export function installImageDrop(view: MapView): void {
	const el = view.contentEl;
	const nodeId = (target: EventTarget | null): string | null => {
		const node = target instanceof Element ? target.closest(`.${DOM.node}`) : null;
		return node?.getAttribute(DOM.nodeIdAttr) ?? null;
	};
	view.registerDomEvent(el, 'dragover', (evt) => {
		if (!view.canEdit()) return;
		const vault = draggedVaultImages(view.app).length > 0;
		if (!vault && !mayHoldImage(evt.dataTransfer)) return;
		const onNode = nodeId(evt.target) !== null;
		// over empty canvas a vault file keeps Obsidian's own handling
		if (vault && !onNode) return;
		evt.preventDefault();
		// a vault file over a node is ours, not the workspace's "open here"
		if (vault) evt.stopPropagation();
		if (evt.dataTransfer) evt.dataTransfer.dropEffect = !onNode ? 'none' : vault ? 'link' : 'copy';
	}, { capture: true });
	// Capture: runs before the node editor's own drop handler, which then leaves the event alone.
	view.registerDomEvent(el, 'drop', (evt) => {
		if (!view.canEdit()) return;
		const files = imageFiles(evt.dataTransfer);
		const vault = files.length === 0 ? draggedVaultImages(view.app) : [];
		if (files.length === 0 && vault.length === 0) return;
		const id = nodeId(evt.target);
		if (vault.length > 0 && id === null) return;
		evt.preventDefault();
		if (id === null) return;
		// keep the drop from Obsidian's own handlers; a .xmind in the same drop still reaches its handler
		const xmind = Array.from(evt.dataTransfer?.files ?? []).some((f) => /\.xmind$/i.test(f.name));
		if (!xmind) evt.stopPropagation();
		if (files.length > 0) void addImageFiles(view, id, files, false);
		else view.addImageLink(id, vault.map((f) => embedOf(view.app, f, view.file?.path ?? '')).join('\n'), false);
	}, { capture: true });
}

type Pick = { kind: 'device' } | { kind: 'file'; file: TFile };

/** Spec 5.8 picker: "Choose from this device…" first, then the vault's images, filtered as you type. */
export class ImagePickerModal extends SuggestModal<Pick> {
	private readonly view: MapView;
	private readonly nodeId: string;

	constructor(view: MapView, nodeId: string) {
		super(view.app);
		this.view = view;
		this.nodeId = nodeId;
		this.modalEl.addClass(DOM.imagePicker);
		this.setPlaceholder(t('image-picker-placeholder'));
		this.emptyStateText = t('image-picker-empty');
	}

	getSuggestions(query: string): Pick[] {
		const images = this.app.vault.getFiles().filter((f) => isImageName(f.name));
		let files: TFile[];
		if (query.trim() === '') {
			files = images.sort((a, b) => b.stat.mtime - a.stat.mtime);
		} else {
			const fuzzy = prepareFuzzySearch(query);
			files = images
				.map((file) => ({ file, match: fuzzy(file.path) }))
				.filter((x) => x.match !== null)
				.sort((a, b) => (b.match?.score ?? 0) - (a.match?.score ?? 0))
				.map((x) => x.file);
		}
		return [{ kind: 'device' }, ...files.map((file): Pick => ({ kind: 'file', file }))];
	}

	renderSuggestion(pick: Pick, el: HTMLElement): void {
		el.addClass(DOM.imagePickerItem);
		if (pick.kind === 'device') {
			el.setAttr(DOM.actionAttr, 'choose-device');
			el.createDiv({ text: t('image-picker-device') });
			return;
		}
		el.setAttr('data-path', pick.file.path);
		el.createDiv({ text: pick.file.name });
		const dir = pick.file.parent && !pick.file.parent.isRoot() ? pick.file.parent.path : '';
		if (dir) el.createEl('small', { cls: 'mapdown-image-picker-path', text: dir });
	}

	onChooseSuggestion(pick: Pick): void {
		const view = this.view;
		const id = this.nodeId;
		if (pick.kind === 'file') {
			view.addImageLink(id, embedOf(this.app, pick.file, view.file?.path ?? ''), false);
			view.focusMap();
			return;
		}
		// the system file picker; no fs, so it works on mobile too
		const input = createEl('input');
		input.type = 'file';
		input.accept = 'image/*';
		input.addEventListener('change', () => {
			const files = Array.from(input.files ?? []).filter(isImageFile);
			if (files.length > 0) void addImageFiles(view, id, files, false).then(() => view.focusMap());
		});
		input.click();
	}
}

/** Open the picker for the primary node (falls back to the root). */
export function openImagePicker(view: MapView): void {
	if (!view.canEdit()) return;
	const id = view.session.view.selection.primary ?? view.session.doc.root.id;
	new ImagePickerModal(view, id).open();
}
