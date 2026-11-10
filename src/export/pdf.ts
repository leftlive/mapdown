// A minimal single-page PDF 1.4 around one JPEG (behaviour spec 2.3 "PDF 导出").
// No PDF library: catalog, page tree, one page, one DCT image object, one
// drawing instruction, the Info dictionary and the cross-reference table. The
// JPEG bytes go in unchanged. Pure: no DOM and no Obsidian.

/** Longest page side the common PDF readers accept, in points. */
export const MAX_PAGE_PT = 14400;

const enc = new TextEncoder();

/** A number for PDF content: at most 3 decimals, no exponent, no trailing zeros. */
function num(n: number): string {
	const s = n.toFixed(3);
	return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}

/** A PDF text string: UTF-16BE with a byte order mark, as hex. */
export function pdfTitle(title: string): string {
	let hex = 'FEFF';
	for (let i = 0; i < title.length; i++) hex += title.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0');
	return `<${hex}>`;
}

/** The page size in points: the given size, both sides scaled down together when one exceeds 14,400. */
export function pageSize(widthPt: number, heightPt: number): { width: number; height: number } {
	const big = Math.max(widthPt, heightPt);
	const k = big > MAX_PAGE_PT ? MAX_PAGE_PT / big : 1;
	return { width: widthPt * k, height: heightPt * k };
}

/**
 * A one-page PDF showing `jpeg` (pxWidth × pxHeight pixels) over the whole page
 * of pageWidthPt × pageHeightPt points. `title` goes into the Info dictionary.
 */
export function buildPdf(jpeg: Uint8Array, pxWidth: number, pxHeight: number, pageWidthPt: number, pageHeightPt: number, title: string): Uint8Array {
	const page = pageSize(pageWidthPt, pageHeightPt);
	const w = num(page.width);
	const h = num(page.height);
	const content = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;

	const chunks: Uint8Array[] = [];
	let length = 0;
	const push = (c: Uint8Array | string): void => {
		const b = typeof c === 'string' ? enc.encode(c) : c;
		chunks.push(b);
		length += b.length;
	};
	const offsets: number[] = [];
	const object = (body: string, stream?: Uint8Array): void => {
		offsets.push(length);
		const n = offsets.length;
		if (stream) {
			push(`${n} 0 obj\n<<${body} /Length ${stream.length}>>\nstream\n`);
			push(stream);
			push('\nendstream\nendobj\n');
		} else {
			push(`${n} 0 obj\n${body}\nendobj\n`);
		}
	};

	// the second line is binary bytes, so readers treat the file as binary
	push('%PDF-1.4\n');
	push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
	object('<< /Type /Catalog /Pages 2 0 R >>');
	object('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
	object(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`);
	object(`/Type /XObject /Subtype /Image /Width ${Math.round(pxWidth)} /Height ${Math.round(pxHeight)} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode`, jpeg);
	object('', enc.encode(content));
	object(`<< /Title ${pdfTitle(title)} /Producer (Mapdown) >>`);

	const xref = length;
	let table = `xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n`;
	for (const o of offsets) table += `${String(o).padStart(10, '0')} 00000 n \n`;
	table += `trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	push(table);

	const out = new Uint8Array(length);
	let at = 0;
	for (const c of chunks) {
		out.set(c, at);
		at += c.length;
	}
	return out;
}
