import { createHash } from "node:crypto";
import { parse as parseAstro } from "@astrojs/compiler/sync";
import type { Node } from "@astrojs/compiler/types";
import { parse as parseCSS, walk as walkCSS } from "css-tree";
import type { SourceFile } from "./hoplite";
import type { Business } from "./types";
export const siteResourcePolicy =
	"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; frame-src 'none'; base-uri 'self'; form-action 'self'";
/**
 * Live-preview policy: the site resource policy plus the preview's own
 * development WebSocket (ws:// or wss:// to match the gateway origin), framed
 * only by the studio.
 */
export function previewPolicy(previewOrigin: string, studioOrigin: string) {
	return `${siteResourcePolicy}; connect-src 'self' ${previewOrigin.replace(/^http/, "ws")}; frame-ancestors ${studioOrigin}`;
}
export function bytes(file: SourceFile) {
	return Buffer.from(
		file.content,
		file.encoding === "base64" ? "base64" : "utf8",
	);
}
export function containsPrivateCredential(content: string) {
	return /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{30,}|AKIA[A-Z0-9]{16})|-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/.test(
		content,
	);
}
function localResource(value: string) {
	const path = value.trim();
	return (
		Boolean(path) &&
		!/^[a-z][a-z\d+.-]*:|^\/\//i.test(path) &&
		new URL(path, "https://studio.invalid/").origin ===
			"https://studio.invalid"
	);
}
function checkCSSResources(content: string, inline = false) {
	const ast = parseCSS(content, {
		context: inline ? "declarationList" : "stylesheet",
		parseCustomProperty: true,
		onParseError(error) {
			throw error;
		},
	});
	walkCSS(ast, function (node) {
		const resourceString =
			node.type === "String" &&
			(this.atrule?.name.toLowerCase() === "import" ||
				["image-set", "-webkit-image-set"].includes(
					this.function?.name.toLowerCase() || "",
				));
		if (
			(node.type === "Url" || resourceString) &&
			"value" in node &&
			typeof node.value === "string" &&
			!localResource(node.value)
		)
			throw new Error("External CSS resource");
	});
}
function checkAstroResources(content: string, controlled: boolean) {
	const parsed = parseAstro(content, { position: false });
	if (parsed.diagnostics.some((item) => item.severity === 1))
		throw new Error("Invalid Astro markup");
	const frontmatter = parsed.ast.children.find(
		(node) => node.type === "frontmatter",
	);
	// Keep the starter import first: a comment or string elsewhere is not an import.
	const hasTailwind =
		!controlled ||
		Boolean(
			frontmatter &&
				/^\s*import\s+(["'])\.\.\/styles\/tailwind\.css\1\s*(?:;|$)/.test(
					frontmatter.value,
				),
		);
	const nodes: Node[] = [parsed.ast];
	let invalidConsent = false;
	while (nodes.length) {
		const node = nodes.pop();
		if (!node) continue;
		if ("children" in node) nodes.push(...node.children);
		if (!("attributes" in node)) continue;
		const tag = node.name.toLowerCase();
		if (
			tag === "input" &&
			node.attributes.some(
				(attribute) =>
					attribute.name === "name" && attribute.value === "consent",
			) &&
			!node.attributes.some(
				(attribute) =>
					attribute.name === "value" &&
					attribute.kind === "quoted" &&
					attribute.value === "yes",
			)
		)
			invalidConsent = true;
		for (const attribute of node.attributes) {
			const name = attribute.name.toLowerCase();
			if (
				attribute.kind === "spread" ||
				name === "set:html" ||
				name === "srcdoc"
			)
				throw new Error("Resource-producing markup must be explicit");
			const resource =
				[
					"src",
					"srcset",
					"poster",
					"background",
					"action",
					"formaction",
				].includes(name) ||
				(name === "data" && tag === "object") ||
				(["href", "xlink:href"].includes(name) &&
					["link", "image", "use", "feimage"].includes(tag));
			if (!resource && name !== "style") continue;
			if (attribute.kind !== "quoted")
				throw new Error("Use literal local resource paths");
			if (
				tag === "link" &&
				name === "href" &&
				attribute.value === "data:," &&
				node.attributes.some(
					(item) => item.name === "rel" && item.value === "icon",
				)
			)
				continue;
			if (name === "style") checkCSSResources(attribute.value, true);
			else {
				const urls =
					name === "srcset"
						? attribute.value
								.split(",")
								.map((candidate) => candidate.trim().split(/\s+/)[0])
						: [attribute.value];
				if (urls.some((url) => !localResource(url)))
					throw new Error("External HTML resource");
			}
		}
		if (tag === "style")
			checkCSSResources(
				node.children
					.map((child) => ("value" in child ? child.value : ""))
					.join(""),
			);
	}
	return { hasTailwind, invalidConsent };
}
export function sourceGates(files: SourceFile[], seed: SourceFile[]) {
	const errors: string[] = [];
	const map = new Map(files.map((f) => [f.path, f]));
	const controlled = seed.some((file) => file.path === "studio-starter.json");
	const owned = controlled
		? seed
				.filter(
					(file) =>
						!/^src\/pages\/[^/]+\.astro$/.test(file.path) &&
						file.path !== "public/site.css",
				)
				.map((file) => file.path)
		: seed
				.filter(
					(file) =>
						["package.json", "astro.config.mjs"].includes(file.path) ||
						(file.path.startsWith("public/") &&
							file.path !== "public/site.css"),
				)
				.map((file) => file.path);
	for (const path of owned) {
		const file = map.get(path);
		const original = seed.find((f) => f.path === path);
		if (!file || !original || !bytes(file).equals(bytes(original)))
			errors.push(`The Studio-owned ${path} was changed or removed.`);
	}
	for (const original of seed.filter((file) =>
		file.path.startsWith("public/brand-assets/"),
	)) {
		const file = map.get(original.path);
		if (!file || !bytes(file).equals(bytes(original)))
			errors.push(
				`The approved brand asset was changed or removed: ${original.path}`,
			);
	}
	for (const f of files) {
		if (
			controlled &&
			!seed.some((file) => file.path === f.path) &&
			!/^src\/pages\/[^/]+\.astro$/.test(f.path) &&
			f.path !== "README.md"
		)
			errors.push(`Unapproved starter file: ${f.path}`);
		if (
			!owned.includes(f.path) &&
			!/^(src\/pages\/[^/]+\.astro$|public\/site\.css$|package\.json$|astro\.config\.mjs$|tsconfig\.json$|pnpm-lock\.yaml$|package-lock\.json$|README\.md$)/.test(
				f.path,
			)
		)
			errors.push(`Unsupported file: ${f.path}`);
		if (f.path.includes("..") || f.path.startsWith("/"))
			errors.push(`Unsafe file path: ${f.path}`);
		if (
			f.path.startsWith("public/brand-assets/") &&
			!seed.some((original) => original.path === f.path)
		)
			errors.push(`Unapproved brand asset: ${f.path}`);
		if (/\.(astro|css)$/.test(f.path)) {
			try {
				if (f.path.endsWith(".astro")) {
					const markup = checkAstroResources(bytes(f).toString(), controlled);
					if (!markup.hasTailwind)
						errors.push(
							`Start the frontmatter of ${f.path} with import "../styles/tailwind.css"; to preserve Tailwind styling.`,
						);
					if (markup.invalidConsent)
						errors.push(
							`Set the consent input in ${f.path} to value="yes". Site Studio's lead endpoint rejects other values, including "on" and "true".`,
						);
				} else checkCSSResources(bytes(f).toString());
			} catch {
				errors.push(
					`Use copied local assets and literal resource paths instead of external or unsupported resource syntax in ${f.path}`,
				);
			}
		}
		if (f.path.endsWith(".astro")) {
			const content = bytes(f).toString();
			if (content.includes("data-studio-blank"))
				errors.push(`Replace the unfinished website placeholder in ${f.path}`);
			if (
				/export\s+const\s+prerender\s*=\s*false|Astro\.request|process\.env|<script[^>]+src=["']https?:/i.test(
					content,
				)
			)
				errors.push(`Server code or an external script in ${f.path}`);
			if (!content.includes("/site-kit.js"))
				errors.push(`Missing Site Kit in ${f.path}`);
		}
		if (containsPrivateCredential(bytes(f).toString()))
			errors.push(`Possible private credential in ${f.path}`);
	}
	return errors;
}
const timeRange = /(\d{1,2})[:.](\d{2})\s*[–—-]\s*(\d{1,2})[:.](\d{2})/g;
function timeRanges(text: string) {
	return new Set(
		[...text.matchAll(timeRange)].map(
			([, h1, m1, h2, m2]) => `${Number(h1)}:${m1}–${Number(h2)}:${m2}`,
		),
	);
}
function pattern(text: string) {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
/**
 * Page text, frontmatter and text-bearing attributes (meta content, alt,
 * title, aria-label), excluding Site Kit bindings, scripts and styles. Link
 * targets such as tel: and mailto: are not copy: Site Kit has no href binding.
 */
function copyText(content: string) {
	const parsed = parseAstro(content, { position: false });
	const text: string[] = [];
	const nodes: Node[] = [parsed.ast];
	while (nodes.length) {
		const node = nodes.pop();
		if (!node || node.type === "comment") continue;
		if (node.type === "text" || node.type === "frontmatter") {
			text.push(node.value);
			continue;
		}
		if (
			"attributes" in node &&
			(["script", "style"].includes(node.name.toLowerCase()) ||
				node.attributes.some((attribute) =>
					["data-business", "data-services", "data-team"].includes(
						attribute.name,
					),
				))
		)
			continue;
		if ("attributes" in node)
			for (const attribute of node.attributes)
				if (
					attribute.kind === "quoted" &&
					["content", "alt", "title", "aria-label"].includes(
						attribute.name.toLowerCase(),
					)
				)
					text.push(attribute.value);
		if ("children" in node) nodes.push(...node.children);
	}
	return text.join("\n");
}
/**
 * Live business facts copied into page copy go stale when the owner edits
 * their business details. Detects only exact, high-confidence duplicates of
 * the saved data: opening-hour ranges, service prices with their currency,
 * minute durations, phone and email.
 */
export function hardcodedBusinessFacts(
	files: SourceFile[],
	business: Business,
) {
	const findings = new Set<string>();
	const hours = timeRanges(business.hours);
	const currency = business.currency || "EUR";
	let symbol = currency;
	try {
		symbol =
			new Intl.NumberFormat("en", { style: "currency", currency })
				.formatToParts(0)
				.find((part) => part.type === "currency")?.value ?? currency;
	} catch {
		// An unknown code still matches when written as the code itself.
	}
	const money = `(?:${pattern(symbol)}|${pattern(currency)})`;
	const phone = business.phone.replace(/\D/g, "");
	const email = business.email.trim().toLowerCase();
	const squash = (value: string) => value.replace(/\s+/g, " ");
	const address = squash(business.address.trim());
	for (const file of files) {
		if (!/^src\/pages\/[^/]+\.astro$/.test(file.path)) continue;
		let text: string;
		try {
			text = copyText(bytes(file).toString());
		} catch {
			continue;
		}
		const where = file.path;
		for (const range of timeRanges(text))
			if (hours.has(range))
				findings.add(
					`${where}: the opening hours ${range} are written into the page. Remove them and show hours only through an empty [data-business="hours"] element so they update when the business details change.`,
				);
		for (const service of business.services) {
			const amount = Number.isInteger(service.price)
				? `${service.price}(?:[.,]00)?`
				: pattern(service.price.toFixed(2)).replace("\\.", "[.,]");
			if (
				new RegExp(
					`${money}\\s?${amount}(?![\\d.,]*\\d)|(?<![\\d.,])${amount}\\s?${money}(?![A-Za-z])`,
					"i",
				).test(text)
			)
				findings.add(
					`${where}: the price of ${service.name} is written into the page. Remove it and show prices only through a [data-services] list so they update when the business details change.`,
				);
			const minutes = service.duration.match(
				/^\s*(\d+)\s*(?:m|min|mins|minutes?)\b/i,
			)?.[1];
			if (
				minutes &&
				new RegExp(
					`(?<![\\d.,])${minutes}(?:\\s|-)?(?:mins?|minutes?)\\b`,
					"i",
				).test(text)
			)
				findings.add(
					`${where}: the ${service.duration} duration of ${service.name} is written into the page. Remove it and show durations only through a [data-services] list so they update when the business details change.`,
				);
		}
		if (
			phone.length >= 7 &&
			[...text.matchAll(/\+?\d[\d\s().-]{5,}\d/g)].some(
				([match]) => match.replace(/\D/g, "") === phone,
			)
		)
			findings.add(
				`${where}: the phone number is written into the page text. Show it only through an empty [data-business="phone"] element so it updates when the business details change.`,
			);
		if (email.includes("@") && text.toLowerCase().includes(email))
			findings.add(
				`${where}: the email address is written into the page text. Show it only through an empty [data-business="email"] element so it updates when the business details change.`,
			);
		// The full street address (not a town mentioned in passing), including
		// in titles and meta descriptions.
		if (
			address.length >= 12 &&
			squash(text).toLowerCase().includes(address.toLowerCase())
		)
			findings.add(
				`${where}: the full address is written into the page text or its title/description. Show it only through an empty [data-business="address"] element so it updates when the business details change.`,
			);
	}
	return [...findings];
}
export function sha256(body: Buffer) {
	return createHash("sha256").update(body).digest("hex");
}
export function safeArtifactPath(path: string) {
	return (
		Boolean(path) &&
		!path.startsWith("/") &&
		!path.includes("\\") &&
		!path.split("/").some((part) => part === ".." || part === "") &&
		!path.endsWith(".map")
	);
}
