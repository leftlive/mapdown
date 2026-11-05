// File-side helpers for saving (behaviour spec 6.3, 6.5): the root-to-file
// name rule, names of conflict and recovery copies, and recovery drafts kept
// in the plugin folder (outside the vault index, so through the adapter).

import { normalizePath, type App, type DataAdapter, type TFile } from 'obsidian';
import { availablePath, folderOf, timestamp } from './controller/fileNames.ts';

export { availablePath, fileNameFromRoot, folderOf, timestamp } from './controller/fileNames.ts';

/** Write a copy of `text` next to `file`, named `<name> Mapdown <kind> <timestamp>.md`. Returns its path. */
export async function writeSafetyCopy(app: App, file: TFile, kind: 'conflict' | 'recovered' | 'backup', text: string): Promise<string> {
	const folder = folderOf(file.path);
	const path = availablePath(folder, `${file.basename} Mapdown ${kind} ${timestamp()}`, (p) => app.vault.getAbstractFileByPath(p) !== null);
	await app.vault.create(path, text);
	return path;
}

interface Draft {
	path: string;
	text: string;
	time: number;
}

/** Simple stable hash for draft file names. */
function hash(s: string): string {
	let h = 5381;
	for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
	return (h >>> 0).toString(36);
}

/** Recovery drafts in `<plugin dir>/recovery/`. */
export class RecoveryStore {
	private readonly adapter: DataAdapter;
	private readonly dir: string;

	constructor(adapter: DataAdapter, dir: string) {
		this.adapter = adapter;
		this.dir = dir;
	}

	private fileFor(path: string): string {
		return normalizePath(`${this.dir}/recovery/${hash(path)}.json`);
	}

	async write(path: string, text: string): Promise<void> {
		const folder = normalizePath(`${this.dir}/recovery`);
		if (!(await this.adapter.exists(folder))) await this.adapter.mkdir(folder);
		const draft: Draft = { path, text, time: Date.now() };
		await this.adapter.write(this.fileFor(path), JSON.stringify(draft));
	}

	async read(path: string): Promise<string | null> {
		const f = this.fileFor(path);
		if (!(await this.adapter.exists(f))) return null;
		try {
			const draft = JSON.parse(await this.adapter.read(f)) as Partial<Draft>;
			return draft.path === path && typeof draft.text === 'string' ? draft.text : null;
		} catch {
			return null;
		}
	}

	async remove(path: string): Promise<void> {
		const f = this.fileFor(path);
		if (!(await this.adapter.exists(f))) return;
		try {
			await this.adapter.remove(f);
		} catch (err) {
			// Two saves can race to remove the same copy; gone is what we wanted.
			if (await this.adapter.exists(f)) throw err;
		}
	}
}
