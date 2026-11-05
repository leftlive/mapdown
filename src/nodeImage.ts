// Images in nodes (behaviour spec 5.8): the pure parts. Which files count as
// images, how a pasted image is named, the embed written into the node, and
// the `[[` / `![[` query the link suggest reacts to. No Obsidian imports, so
// unit tests load it.

/** Image formats Obsidian shows as images (spec 5.8). */
export const IMAGE_EXTENSIONS: readonly string[] = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif'];

/** Extension of a file name or path, lower case, without the dot; '' when none. */
export function extensionOf(name: string): string {
	const base = name.slice(name.lastIndexOf('/') + 1);
	const dot = base.lastIndexOf('.');
	return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/** True for a file name (or path) with one of the image extensions. */
export function isImageName(name: string): boolean {
	return IMAGE_EXTENSIONS.includes(extensionOf(name));
}

const MIME_EXT: Record<string, string> = {
	'image/png': 'png',
	'image/jpeg': 'jpg',
	'image/jpg': 'jpg',
	'image/gif': 'gif',
	'image/webp': 'webp',
	'image/svg+xml': 'svg',
	'image/bmp': 'bmp',
	'image/avif': 'avif',
};

/** Extension for an image MIME type; null when it is not a supported image. */
export function extensionForMime(mime: string): string | null {
	return MIME_EXT[mime.toLowerCase().split(';')[0].trim()] ?? null;
}

/** True when a file (name or MIME type) is a supported image. */
export function isImageFile(file: { name: string; type: string }): boolean {
	return isImageName(file.name) || extensionForMime(file.type) !== null;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** Name of a pasted image, as Obsidian's editor names it: `Pasted image 20261105143000.png`. */
export function pastedImageName(at: Date, ext: string): string {
	const stamp = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
	return `Pasted image ${stamp}.${ext}`;
}

/**
 * File name to save an image under: its own name when it has an image
 * extension, else a pasted-image name with the extension of its MIME type.
 * Null when the file is not a supported image.
 */
export function attachmentName(file: { name: string; type: string }, at: Date): string | null {
	const name = file.name.trim();
	if (isImageName(name) && !/^image\.\w+$/i.test(name)) return name;
	const ext = isImageName(name) ? extensionOf(name) : extensionForMime(file.type);
	return ext ? pastedImageName(at, ext) : null;
}

/** The embed written into the node: `![[target]]`. */
export function embedLink(target: string): string {
	return `![[${target}]]`;
}

/**
 * Builds the link text for a file, honouring the user's link settings (shortest
 * / relative / absolute, wikilinks or Markdown links). In Obsidian this is
 * `app.fileManager.generateMarkdownLink`: no leading `!`, and `alias` becomes
 * the `|alias` of a wikilink or the text of a Markdown link.
 */
export type LinkBuilder<F> = (file: F, alias?: string) => string;

/**
 * The embed for a file: the built link with a `!` in front. A width becomes the
 * alias, which is Obsidian's size syntax in both forms: `![[a.png|200]]`,
 * `![200](a.png)`.
 */
export function embedFor<F>(file: F, build: LinkBuilder<F>, width?: number): string {
	const link = build(file, width === undefined ? undefined : String(Math.round(width)));
	return link.startsWith('!') ? link : `!${link}`;
}

/** Node text with `line` added on a new line at the end (spec 5.8). */
export function appendLine(text: string, line: string): string {
	const base = text.replace(/\s+$/, '');
	return base === '' ? line : `${base}\n${line}`;
}

/** The `[[query` the caret is in, or null. `embed` when it is `![[query`. */
export function linkQueryAt(textBeforeCaret: string): { start: number; query: string; embed: boolean } | null {
	const start = textBeforeCaret.lastIndexOf('[[');
	if (start < 0) return null;
	const query = textBeforeCaret.slice(start + 2);
	if (query.includes(']]') || query.includes('\n')) return null;
	return { start, query, embed: start > 0 && textBeforeCaret[start - 1] === '!' };
}
