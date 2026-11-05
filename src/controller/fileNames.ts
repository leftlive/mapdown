// Pure file-name rules (behaviour spec 6.1, 6.3, 6.5).

/** File name for a root heading's text: forbidden characters removed, whitespace collapsed, at most 80 characters. */
export function fileNameFromRoot(text: string): string {
	return text
		.replace(/[*"\\/<>:|?#[\]]/g, '')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 80)
		.trim();
}

/** `2026-11-04 213045`: sortable, and legal in file names everywhere. */
export function timestamp(date = new Date()): string {
	const p = (n: number): string => String(n).padStart(2, '0');
	return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

export function folderOf(path: string): string {
	const i = path.lastIndexOf('/');
	return i < 0 ? '' : path.slice(0, i);
}

/** `<folder>/<base><suffix>.md`, adding ` 1`, ` 2`… while `taken` says the path exists. */
export function availablePath(folder: string, base: string, taken: (path: string) => boolean, except?: string): string {
	const make = (n: number): string => `${folder ? folder + '/' : ''}${base}${n === 0 ? '' : ' ' + String(n)}.md`;
	for (let n = 0; n < 1000; n++) {
		const p = make(n);
		if (p === except || !taken(p)) return p;
	}
	return make(Date.now());
}
