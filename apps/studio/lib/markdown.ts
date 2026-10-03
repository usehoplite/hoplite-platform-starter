/*
 * The small Markdown subset agent replies use: paragraphs, bulleted and
 * numbered lists, headings, bold, italic, inline code and links. It returns
 * plain data rendered as React elements, so raw HTML is never interpreted.
 */
export type Inline =
	| { type: "text"; text: string }
	| { type: "strong" | "em"; children: Inline[] }
	| { type: "code"; text: string }
	| { type: "link"; href: string; children: Inline[] };
export type Block =
	| { type: "paragraph"; content: Inline[] }
	| { type: "list"; ordered: boolean; items: Inline[][] };

const token =
	/\*\*(.+?)\*\*|__(.+?)__|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|\*([^*\s][^*]*?)\*|(?<![\w])_([^_\s][^_]*?)_(?![\w])/g;

/** Only web and email links; anything else stays plain text. */
function safeHref(href: string) {
	try {
		const url = new URL(href);
		return ["http:", "https:", "mailto:"].includes(url.protocol)
			? url.href
			: undefined;
	} catch {
		return;
	}
}

export function inline(text: string): Inline[] {
	const parts: Inline[] = [];
	let last = 0;
	for (const match of text.matchAll(token)) {
		const index = match.index ?? 0;
		if (index > last)
			parts.push({ type: "text", text: text.slice(last, index) });
		const [whole, strong, strongAlt, code, label, href, em, emAlt] = match;
		if (strong ?? strongAlt)
			parts.push({ type: "strong", children: inline(strong ?? strongAlt) });
		else if (code) parts.push({ type: "code", text: code });
		else if (label && href) {
			const safe = safeHref(href);
			parts.push(
				safe
					? { type: "link", href: safe, children: inline(label) }
					: { type: "text", text: whole },
			);
		} else parts.push({ type: "em", children: inline(em ?? emAlt) });
		last = index + whole.length;
	}
	if (last < text.length) parts.push({ type: "text", text: text.slice(last) });
	return parts;
}

export function markdown(text: string): Block[] {
	const blocks: Block[] = [];
	let paragraph: string[] = [];
	const endParagraph = () => {
		if (paragraph.length)
			blocks.push({ type: "paragraph", content: inline(paragraph.join("\n")) });
		paragraph = [];
	};
	for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
		const item = line.match(/^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/);
		const heading = line.match(/^\s*#{1,6}\s+(.*?)\s*#*\s*$/);
		if (item) {
			endParagraph();
			const ordered = !item[1];
			const list = blocks.at(-1);
			if (list?.type === "list" && list.ordered === ordered)
				list.items.push(inline(item[3]));
			else blocks.push({ type: "list", ordered, items: [inline(item[3])] });
		} else if (heading) {
			endParagraph();
			// Headings keep the chat's body size; weight carries the hierarchy.
			blocks.push({
				type: "paragraph",
				content: [{ type: "strong", children: inline(heading[1]) }],
			});
		} else if (!line.trim()) endParagraph();
		else paragraph.push(line);
	}
	endParagraph();
	return blocks;
}
