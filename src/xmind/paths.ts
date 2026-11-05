// Pure file-name rule for the export (spec 2.2): next to the note, same name,
// ` 1`, ` 2`… while the path is taken. No Obsidian imports.

/** `<folder>/<base>.<extension>`, numbered while `taken` says the path exists. */
export function availableSiblingPath(folder: string, base: string, extension: string, taken: (path: string) => boolean): string {
	const make = (n: number): string => `${folder ? folder + '/' : ''}${base}${n === 0 ? '' : ' ' + String(n)}.${extension}`;
	for (let n = 0; n < 1000; n++) {
		const p = make(n);
		if (!taken(p)) return p;
	}
	return make(Date.now());
}
