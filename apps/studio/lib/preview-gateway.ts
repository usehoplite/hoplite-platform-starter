import type { IncomingHttpHeaders } from "node:http";
import type { Readable } from "node:stream";
import {
	createBrotliDecompress,
	createGunzip,
	createInflate,
	type Gunzip,
} from "node:zlib";

/**
 * How the private preview gateway treats an upstream response. The owner only
 * ever sees their own website or Site Studio's neutral waiting page: upstream error
 * bodies, provider messages and the platform's startup page never pass through.
 *
 * - `ok`: the website answered; relay it (HTML is sanitized first).
 * - `starting`: the preview is starting; keep the grant and wait.
 * - `expired`: the grant was refused; drop it and request a fresh one.
 * - `unavailable`: the preview is gone or failing; drop the grant and wake it.
 * - `error`: the website's own server error page; replace it, keep its status.
 */
export type UpstreamVerdict =
	| "ok"
	| "starting"
	| "expired"
	| "unavailable"
	| "error";

/** Plain-text answers from the platform or provider when no website is there. */
const missingPreview =
	/sandbox not found|preview link is unavailable|preview unavailable|preview is starting|preview authentication required/i;

/**
 * The platform's own startup/interstitial page. Detected by its status
 * endpoint and by a platform-branded title, so it is replaced even before the
 * platform serves an unbranded page.
 */
export function isPlatformStartupPage(html: string) {
	return (
		html.includes("/.hoplite/preview-status") ||
		/<title>[^<]*\bhoplite\b[^<]*<\/title>/i.test(html) ||
		(/\bLoading preview\b/i.test(html) && /\bhoplite\b/i.test(html))
	);
}

export function classifyUpstream(response: {
	status: number;
	contentType: string;
	body: string;
	/** A page navigation (the iframe or a tab), not a script, style or ping. */
	navigation: boolean;
}): UpstreamVerdict {
	const html = /text\/html/i.test(response.contentType);
	// 202 is the platform's "still starting" answer, whatever its content type.
	if (response.status === 202) return "starting";
	if (response.status === 425) return "starting";
	if (response.status === 401 || response.status === 403) return "expired";
	if ([502, 503, 504].includes(response.status)) return "unavailable";
	if (response.status >= 500) {
		if (!html) return "unavailable";
		// The website's own server error (for example a page mid-edit): its
		// technical error page is replaced, but the workspace is left alone and
		// the status is kept, so browser checks still see the website's failure.
		// A platform error page carrying its startup markup is still waking.
		return isPlatformStartupPage(response.body) ? "unavailable" : "error";
	}
	if (response.status === 404) {
		if (missingPreview.test(response.body)) return "unavailable";
		// A navigation that returns something other than a page is the provider
		// answering, not the website's own "page not found".
		if (response.navigation && !html) return "unavailable";
	}
	if (html && isPlatformStartupPage(response.body)) return "starting";
	return "ok";
}

/**
 * What the gateway shows when the live preview cannot answer. It never
 * restarts anything itself: its pages reload and poll automatically, and an
 * automatic request must not keep an idle workspace alive. Only a wake the
 * owner asked for (still in progress) earns the self-refreshing waiting page;
 * otherwise the owner sees the paused page with its "Wake preview" button.
 */
export function previewFallback(
	verdict: Exclude<UpstreamVerdict, "ok" | "error"> | "no_grant",
	ownerWakeInProgress: boolean,
) {
	const starting = verdict === "starting" || ownerWakeInProgress;
	return {
		page: starting ? ("waiting" as const) : ("paused" as const),
		state: starting ? ("waking" as const) : ("paused" as const),
		// A refused or failing grant is never reused; a starting one is kept.
		dropGrant: verdict !== "starting" && verdict !== "no_grant",
	};
}

/**
 * Removes the sandbox's private workspace path from preview HTML. The
 * development server writes it into attributes such as `data-vite-dev-id`;
 * stripping the prefix leaves the project-relative path (`/src/…`). Module
 * URLs under `/@fs/` are left alone so the page still loads.
 */
export function sanitizePreviewHtml(html: string) {
	const clean = html.replace(
		/(?<!\/@fs)\/tmp\/hoplite\/workspaces\/[^\s"'<>/]+/g,
		"",
	);
	// Styles the development client injects later carry the same path; the
	// shim runs before any module script, so they never reach the page.
	const head = clean.match(/<head(?:\s[^>]*)?>/i);
	return head?.index === undefined
		? previewPathShim + clean
		: clean.slice(0, head.index + head[0].length) +
				previewPathShim +
				clean.slice(head.index + head[0].length);
}

/**
 * Preview-only client shim: the development server's style injection writes
 * the sandbox's workspace path into `data-*` attributes (for example
 * `data-vite-dev-id`). The shim rewrites those values to the project-relative
 * path as they are set. The development client keeps its own element
 * references, so live style updates still work. The pattern is built without
 * naming the provider, so the page never contains it.
 */
const previewPathShim = `<script>(()=>{const p=new RegExp("/tmp/[^\\\\s\\"'<>/]+/workspaces/[^\\\\s\\"'<>/]+","g");const f=(n,v)=>typeof v==="string"&&String(n).startsWith("data-")?v.replace(p,""):v;const s=Element.prototype.setAttribute;Element.prototype.setAttribute=function(n,v){return s.call(this,n,f(n,v))};new MutationObserver((l)=>{for(const m of l){const e=m.target;const v=e.getAttribute&&e.getAttribute(m.attributeName);if(v&&f(m.attributeName,v)!==v)s.call(e,m.attributeName,f(m.attributeName,v))}}).observe(document.documentElement,{subtree:true,attributes:true,attributeFilter:["data-vite-dev-id"]})})()</script>`;

/** Whether a request is a page navigation (iframe load, refresh or new tab). */
export function isNavigation(headers: IncomingHttpHeaders) {
	const mode = headers["sec-fetch-mode"];
	const dest = headers["sec-fetch-dest"];
	if (mode === "navigate" || dest === "document" || dest === "iframe")
		return true;
	if (mode || dest) return false;
	// Clients without fetch metadata: a page request asks for HTML.
	return /text\/html/i.test(String(headers.accept ?? ""));
}

export class UpstreamBodyTooLarge extends Error {}

/**
 * Reads (and decodes) an upstream body that the gateway must inspect before
 * relaying it. Bounded, so a large response cannot exhaust memory.
 */
export async function readUpstreamBody(
	stream: Readable,
	encoding: string | undefined,
	limit = 8 * 1024 * 1024,
) {
	let source: Readable | Gunzip = stream;
	const coding = (encoding ?? "").trim().toLowerCase();
	if (coding === "gzip" || coding === "x-gzip")
		source = stream.pipe(createGunzip());
	else if (coding === "br") source = stream.pipe(createBrotliDecompress());
	else if (coding === "deflate") source = stream.pipe(createInflate());
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of source) {
		const part = Buffer.from(chunk);
		size += part.length;
		if (size > limit) {
			stream.destroy();
			throw new UpstreamBodyTooLarge("Preview response is too large");
		}
		chunks.push(part);
	}
	return Buffer.concat(chunks);
}
