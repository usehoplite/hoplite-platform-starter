import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { extname } from "node:path";
import type { Duplex } from "node:stream";
import { pipeline } from "node:stream/promises";
import httpProxy from "http-proxy";
import next from "next";
import {
	approveBrand,
	brandState,
	importBrand,
	migrateBrandStorage,
} from "./lib/brand";
import { BusinessDetailsError, validBusiness } from "./lib/business";
import {
	customerErrorMessage,
	customerSummary,
	publicGeneration,
	replyFallback,
} from "./lib/customer-copy";
import { access, hosting } from "./lib/deployment";
import {
	type Endpoint,
	endpointFor,
	type Listener,
	needsHttps,
} from "./lib/hosting";
import { logStudioError } from "./lib/log";
import {
	classifyUpstream,
	isNavigation,
	previewFallback,
	readUpstreamBody,
	sanitizePreviewHtml,
	type UpstreamVerdict,
} from "./lib/preview-gateway";
import { stallLevel } from "./lib/progress";
import { releaseStorage } from "./lib/release-storage";
import { previewPolicy, siteResourcePolicy } from "./lib/safety";
import {
	browserChecksEnabled,
	cancelQueuedChange,
	createSite,
	generationPolling,
	grants,
	hoplite,
	migrateReleaseStorage,
	notePreviewState,
	previewGrant,
	previewState,
	publish,
	recordWorkspaceActivity,
	resolveBusinessProposal,
	retryGeneration,
	sendMessage,
	settleAdmissions,
	staffTools,
	startBuild,
	stopChange,
	tick,
	WebsiteExists,
	wakePreview,
	wakingPreview,
} from "./lib/service";
import {
	bookingPage,
	organizationSlug,
	pausedPage,
	safePreviewPath,
	waitingPage,
} from "./lib/site-pages";
import {
	customerMessages,
	database,
	deleteConversation,
	findSite,
	organisationSite,
	PublicationConflict,
	save,
	siteConversations,
} from "./lib/store";
import type { JsonObject, JsonValue, Site, Version } from "./lib/types";

const origin = hosting.studioOrigin;
const studioListener = hosting.listeners.find((listener) =>
	listener.endpoints.some((endpoint) => endpoint.role === "studio"),
) as Listener;
const previewGatewayId = randomUUID();
const nextApp = next({
	webpack: true,
	dev: process.env.NODE_ENV !== "production",
	hostname: studioListener.host,
	port: studioListener.port,
});
await nextApp.prepare();
const handle = nextApp.getRequestHandler();
let acceptingRequests = false;
function starting(res: ServerResponse) {
	if (acceptingRequests) return false;
	res.writeHead(503, { "cache-control": "no-store", "retry-after": "1" });
	res.end("Studio is starting. Please retry.");
	return true;
}
function json(res: ServerResponse, value: JsonValue, status = 200) {
	res.writeHead(status, {
		"content-type": "application/json",
		"cache-control": "no-store",
	});
	res.end(JSON.stringify(value));
}
async function body(req: IncomingMessage): Promise<JsonObject> {
	let size = 0;
	const chunks: Buffer[] = [];
	for await (const part of req) {
		const chunk = Buffer.from(part);
		size += chunk.length;
		if (size > 50000) throw new Error("Request too large");
		chunks.push(chunk);
	}
	const value = JSON.parse(Buffer.concat(chunks).toString() || "{}");
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Expected a JSON object");
	return value;
}
function publicSite(site: Site) {
	const conversations = siteConversations(site);
	// Older metadata has one implicit conversation; attribute its messages to it.
	const fallback = conversations[0]?.id;
	// Deleted conversations are hidden, including their messages and requests.
	const deleted = new Set(
		conversations
			.filter((conversation) => conversation.deletedAt)
			.map((conversation) => conversation.id),
	);
	return {
		...site,
		stall: stallLevel(site),
		conversationId: site.conversationId ?? fallback,
		conversations: conversations
			.filter((conversation) => !conversation.deletedAt)
			.toSorted((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "")),
		messages: customerMessages(site)
			.map((message) => ({
				...message,
				// Replies are short and plain whatever the agent wrote. A reply
				// that was only tooling notes says what actually happened to its
				// change; its original wording never reaches the owner.
				content:
					message.role === "assistant"
						? customerSummary(message.content) || replyFallback(site, message)
						: message.content,
				conversationId: message.conversationId ?? fallback,
			}))
			.filter((message) => !deleted.has(message.conversationId ?? "")),
		generations: site.generations
			?.map((generation) => ({
				...publicGeneration(generation),
				conversationId: generation.conversationId ?? fallback,
			}))
			.filter(
				(generation) =>
					generation.id === site.generationId ||
					!deleted.has(generation.conversationId ?? ""),
			),
		// Technical failure detail stays on the server (logs and the stored
		// check report); the browser only needs the failure's kind.
		versions: site.versions.map(
			({ artifactDirectory, storage, ...version }) => ({
				...version,
				failure: version.failure && { ...version.failure, errors: [] },
				qa: version.qa && { ...version.qa, errors: [] },
			}),
		),
	};
}
async function website() {
	const site = organisationSite(await database());
	if (!site) throw new Error("Create your website first.");
	return site;
}
function text(value: JsonValue | undefined) {
	if (typeof value !== "string") throw new Error("Expected text");
	return value;
}
async function studio(req: IncomingMessage, res: ServerResponse) {
	try {
		const url = new URL(req.url || "/", origin);
		if (await access.studio(req, res, url)) return;
		if (!url.pathname.startsWith("/api/")) {
			await handle(req, res);
			return;
		}
		if (
			req.method !== "GET" &&
			(req.headers.origin !== origin ||
				req.headers["x-studio-action"] !== "studio")
		) {
			json(res, { error: "Request must come from this studio." }, 403);
			return;
		}
		const db = await database();
		if (url.pathname === "/api/state" && req.method === "GET") {
			const site = organisationSite(db);
			json(res, {
				site: site ? publicSite(site) : null,
				business: db.business,
				configured: hoplite.configured,
				browserChecks: browserChecksEnabled(),
				previewGatewayId,
				previewOrigin: hosting.previewOrigin,
				sitesOrigin: hosting.sitesOrigin,
				previewState: (site && previewState(site.id)) ?? null,
				staff: staffTools(),
			});
			return;
		}
		if (url.pathname === "/api/brand" && req.method === "GET") {
			json(res, await brandState());
			return;
		}
		if (url.pathname === "/api/brand/import" && req.method === "POST") {
			json(res, { brief: await importBrand(text((await body(req)).url)) });
			return;
		}
		if (url.pathname === "/api/brand/approve" && req.method === "POST") {
			const value = await body(req);
			if (
				!Array.isArray(value.assetIds) ||
				value.assetIds.some((id) => typeof id !== "string")
			)
				throw new Error("Choose the assets to reuse.");
			json(res, {
				selected: await approveBrand(
					text(value.importId),
					value.assetIds.map((id) => text(id)),
				),
			});
			return;
		}
		const brandFile = url.pathname.match(/^\/api\/brand\/([^/]+)\/file$/);
		if (brandFile && req.method === "GET") {
			const record = db.brandImports?.find((item) => item.id === brandFile[1]);
			if (!record) throw new Error("Website reference not found");
			const path = url.searchParams.get("path") || "reference.png";
			if (path !== "reference.png" && !/^assets\/[a-f0-9]{64}\.png$/.test(path))
				throw new Error("Reference image not found");
			const image = await releaseStorage.readBrand(record, path);
			res.writeHead(200, {
				"content-type": "image/png",
				"cache-control": "private, no-store",
				"x-content-type-options": "nosniff",
			});
			res.end(image);
			return;
		}
		if (url.pathname === "/api/business" && req.method === "POST") {
			db.business = validBusiness(await body(req));
			await save();
			json(res, { ok: true });
			return;
		}
		if (url.pathname === "/api/site" && req.method === "POST") {
			const site = await createSite(text((await body(req)).prompt));
			json(
				res,
				{ site: publicSite(site), conversationId: site.conversationId ?? null },
				201,
			);
			return;
		}
		if (
			url.pathname === "/api/site/business-proposal" &&
			req.method === "POST"
		) {
			const site = await website();
			const value = await body(req);
			if (value.action !== "apply" && value.action !== "dismiss")
				throw new Error("Choose Update or Not now.");
			await resolveBusinessProposal(site, text(value.id), value.action);
			json(res, { site: publicSite(site), business: db.business });
			return;
		}
		const deletion = url.pathname.match(
			/^\/api\/site\/conversations\/([^/]+)$/,
		);
		if (deletion && req.method === "DELETE") {
			const result = await deleteConversation(await website(), deletion[1]);
			if (result === "not-found") {
				json(res, { error: "Conversation not found." }, 404);
			} else if (result === "busy") {
				json(
					res,
					{
						error:
							"Finish or recover the current change before deleting this conversation.",
					},
					409,
				);
			} else json(res, { ok: true });
			return;
		}
		const match = url.pathname.match(
			/^\/api\/site\/(messages|build|publish|retry|activity|stop|unqueue)$/,
		);
		if (match && req.method === "POST") {
			const site = await website();
			const value = await body(req);
			let conversationId = site.conversationId;
			if (match[1] === "messages") {
				if (
					value.conversationId !== undefined &&
					value.conversationId !== null &&
					typeof value.conversationId !== "string"
				)
					throw new Error("Choose a conversation for this change.");
				// A request sent while another change runs is queued in its own
				// conversation; the browser follows that conversation.
				conversationId =
					(await sendMessage(site, text(value.prompt), value.conversationId)) ??
					site.conversationId;
			}
			if (match[1] === "stop") await stopChange(site);
			if (match[1] === "unqueue") await cancelQueuedChange(site);
			if (match[1] === "build") await startBuild(site, text(value.versionId));
			if (match[1] === "publish") {
				if (
					typeof value.operationId !== "string" ||
					!/^[a-zA-Z0-9-]{1,128}$/.test(value.operationId) ||
					(value.expectedPublishedVersionId !== null &&
						typeof value.expectedPublishedVersionId !== "string") ||
					(value.action !== "publish" && value.action !== "rollback")
				)
					throw new Error("Review this release before publishing.");
				await publish(site, text(value.versionId), {
					id: value.operationId,
					action: value.action,
					expectedVersionId: value.expectedPublishedVersionId,
				});
			}
			if (match[1] === "retry") await retryGeneration(site);
			// Real owner activity (typing, sending, studio navigation, the tab
			// becoming visible) wakes a paused preview; background polling of
			// /api/state never does. Throttled to one restart per 20 seconds.
			if (
				(match[1] === "messages" ||
					(match[1] === "activity" && value.wake === true)) &&
				previewState(site.id) !== "live"
			)
				void wakePreview(site);
			if (match[1] === "activity") {
				// The studio's keep-warm heartbeat only renews a running preview;
				// renewing one that is paused or still archiving would fail.
				if (value.keepWarm !== true || previewState(site.id) === "live")
					await recordWorkspaceActivity(site);
				const current = session(req);
				if (current?.siteId === site.id && !current.versionId)
					res.setHeader("set-cookie", previewCookie(current.token));
			}
			json(res, {
				site: publicSite(site),
				conversationId: conversationId ?? null,
			});
			return;
		}
		const evidence = url.pathname.match(
			/^\/api\/site\/versions\/([^/]+)\/evidence$/,
		);
		if (evidence && req.method === "GET") {
			const site = await website();
			const version = site.versions.find(
				(version) => version.id === evidence[1],
			);
			if (!version?.qa) throw new Error("Checks are not complete");
			const file = url.searchParams.get("file");
			if (!file) {
				// The raw report is for staff and developers; owners see a summary.
				if (!staffTools()) {
					json(res, { error: "Not found" }, 404);
					return;
				}
				json(
					res,
					version.qaReport
						? JSON.parse(
								(
									await releaseStorage.require(
										site.id,
										version,
										version.qaReport,
									)
								).toString(),
							)
						: version.qa,
				);
				return;
			}
			if (!version.qa.screenshots.includes(file))
				throw new Error("Screenshot not found");
			const image = await releaseStorage.require(
				site.id,
				version,
				`qa/${file}`,
			);
			res.writeHead(200, {
				"content-type": "image/png",
				"cache-control": "private, no-store",
			});
			res.end(image);
			return;
		}
		const artifact = url.pathname.match(
			/^\/api\/site\/versions\/([^/]+)\/artifact$/,
		);
		if (artifact && req.method === "GET") {
			const site = await website();
			const version = site.versions.find((v) => v.id === artifact[1]);
			if (!version?.artifactDirectory)
				throw new Error("Build artifact is not ready");
			const archive = await releaseStorage.materialize(
				site.id,
				version,
				"artifact.tar.gz",
			);
			try {
				res.writeHead(200, {
					"content-type": "application/gzip",
					"content-disposition": `attachment; filename="${organizationSlug(db.business)}-${version.label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.tar.gz"`,
					"content-length": archive.size,
					"cache-control": "no-store",
				});
				await pipeline(createReadStream(archive.file), res);
			} finally {
				await archive.dispose();
			}
			return;
		}
		json(res, { error: "Not found" }, 404);
	} catch (error) {
		const failure = error instanceof Error ? error : new Error(String(error));
		if (!(failure instanceof BusinessDetailsError))
			logStudioError("studio.request.failed", failure, {
				method: req.method,
				path: req.url?.split("?")[0],
			});
		if (!res.headersSent)
			json(
				res,
				{ error: customerErrorMessage(failure) },
				error instanceof PublicationConflict || error instanceof WebsiteExists
					? 409
					: 400,
			);
		else res.end();
	}
}
const mime: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".astro": "text/html; charset=utf-8",
	".css": "text/css",
	".js": "text/javascript",
	".mjs": "text/javascript",
	".json": "application/json",
	".jpg": "image/jpeg",
	".png": "image/png",
	".svg": "image/svg+xml",
	".woff2": "font/woff2",
	".ico": "image/x-icon",
};
const sessions = new Map<
	string,
	{ siteId: string; versionId?: string; expiresAt: number }
>();
function previewCookie(token: string) {
	return `studio_preview=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=1200${hosting.previewOrigin.startsWith("https:") ? "; Secure" : ""}`;
}
function session(req: IncomingMessage) {
	const token = req.headers.cookie
		?.split(";")
		.map((s) => s.trim())
		.find((s) => s.startsWith("studio_preview="))
		?.slice("studio_preview=".length);
	const value = token ? sessions.get(token) : undefined;
	if (token && value && value.expiresAt > Date.now()) {
		value.expiresAt = Date.now() + 20 * 60 * 1000;
		return { ...value, token };
	}
	return;
}
const proxy = httpProxy.createProxyServer({
	ws: true,
	xfwd: false,
	proxyTimeout: 120000,
});
function previewHeaders(
	headers: IncomingMessage["headers"],
	previewOrigin = hosting.previewOrigin,
) {
	const relayed = { ...headers };
	delete relayed["set-cookie"];
	relayed["cache-control"] = "private, no-store";
	relayed["x-robots-tag"] = "noindex, nofollow";
	relayed["content-security-policy"] = previewPolicy(previewOrigin, origin);
	return relayed;
}
proxy.on("proxyRes", (response) => {
	Object.assign(response.headers, previewHeaders(response.headers));
	delete response.headers["set-cookie"];
});
function waitingPreview(res: ServerResponse, message?: string) {
	if (res.headersSent) {
		res.end();
		return;
	}
	res.writeHead(503, {
		"content-type": "text/html; charset=utf-8",
		"cache-control": "no-store",
		refresh: "2",
		"x-studio-preview-state": "starting",
		"content-security-policy": `frame-ancestors ${origin}`,
	});
	res.end(waitingPage(message));
}
proxy.on("error", (_error, _req, response) => {
	if ("writeHead" in response) waitingPreview(response as ServerResponse);
	else response.destroy();
});
/**
 * Live-preview HTTP responses are relayed by the gateway itself, so upstream
 * error bodies and the platform's startup page never reach the owner.
 */
const liveProxy = httpProxy.createProxyServer({
	xfwd: false,
	proxyTimeout: 120000,
	selfHandleResponse: true,
});
const liveRequests = new WeakMap<
	IncomingMessage,
	{ site: Site; navigation: boolean; path: string; origin: string }
>();
const waking = "Waking your preview…";
/** Site Studio's paused page: only the owner's "Wake preview" restarts it. */
function pausedPreview(res: ServerResponse, site: Site, path: string) {
	if (res.headersSent) {
		res.end();
		return;
	}
	res.writeHead(503, {
		"content-type": "text/html; charset=utf-8",
		"cache-control": "no-store",
		// Browser checks treat this like the waiting page: not the website.
		"x-studio-preview-state": "starting",
		"content-security-policy": `frame-ancestors ${origin}`,
	});
	res.end(pausedPage(site.id, safePreviewPath(path)));
}
/**
 * The live preview cannot answer. The gateway never restarts it: its own
 * pages reload and poll automatically. An owner wake in progress shows the
 * waiting page; otherwise the owner sees the paused page.
 */
function previewUnavailable(
	site: Site,
	verdict: Exclude<UpstreamVerdict, "ok" | "error"> | "no_grant",
	path: string,
	res: ServerResponse,
) {
	const fallback = previewFallback(verdict, wakingPreview(site.id));
	if (fallback.dropGrant) grants.delete(site.id);
	notePreviewState(site.id, fallback.state);
	if (fallback.page === "waiting") waitingPreview(res, waking);
	else pausedPreview(res, site, path);
}
liveProxy.on("proxyRes", (upstream, req, res) => {
	void (async () => {
		const context = liveRequests.get(req);
		const status = upstream.statusCode ?? 502;
		const contentType = String(upstream.headers["content-type"] ?? "");
		const headers = previewHeaders(upstream.headers, context?.origin);
		const inspect =
			/text\/html/i.test(contentType) ||
			status >= 400 ||
			status === 202 ||
			!context;
		if (!inspect) {
			if (context) notePreviewState(context.site.id, "live");
			res.writeHead(status, headers);
			await pipeline(upstream, res);
			return;
		}
		let raw: Buffer;
		try {
			raw = await readUpstreamBody(
				upstream,
				String(upstream.headers["content-encoding"] ?? ""),
			);
		} catch (error) {
			logStudioError(
				"preview.relay.failed",
				error instanceof Error ? error : new Error(String(error)),
				{ status },
			);
			waitingPreview(res, waking);
			return;
		}
		if (!context) {
			waitingPreview(res);
			return;
		}
		const body = raw.toString("utf8");
		const verdict = classifyUpstream({
			status,
			contentType,
			body,
			navigation: context.navigation,
		});
		if (verdict === "error") {
			// The website's own error page is technical; keep only its status.
			res.writeHead(status, {
				"content-type": "text/html; charset=utf-8",
				"cache-control": "no-store",
				refresh: "5",
				"content-security-policy": `frame-ancestors ${origin}`,
			});
			res.end(
				waitingPage(
					"This page can’t be shown right now. It will come back on its own.",
				),
			);
			return;
		}
		if (verdict !== "ok") {
			previewUnavailable(context.site, verdict, context.path, res);
			return;
		}
		notePreviewState(context.site.id, "live");
		delete headers["content-length"];
		delete headers["content-encoding"];
		delete headers["transfer-encoding"];
		res.writeHead(status, headers);
		res.end(/text\/html/i.test(contentType) ? sanitizePreviewHtml(body) : raw);
	})().catch(() => {
		if (!res.headersSent) waitingPreview(res, waking);
		else res.destroy();
	});
});
liveProxy.on("error", (_error, req, response) => {
	const context = liveRequests.get(req);
	if (!("writeHead" in response)) {
		response.destroy();
		return;
	}
	if (context)
		previewUnavailable(
			context.site,
			"unavailable",
			context.path,
			response as ServerResponse,
		);
	else waitingPreview(response as ServerResponse);
});
async function siteKit(
	req: IncomingMessage,
	res: ServerResponse,
	url: URL,
	style?: Version["bookingStyle"],
) {
	const db = await database();
	if (url.pathname === "/site-kit/qa" && req.method === "GET") {
		json(res, { testMode: true, organization: organizationSlug(db.business) });
		return true;
	}
	if (url.pathname === "/site-kit/data") {
		json(res, db.business);
		return true;
	}
	if (url.pathname === "/site-kit/leads" && req.method === "POST") {
		const value = await body(req);
		if (
			typeof value.name !== "string" ||
			!value.name.trim() ||
			typeof value.email !== "string" ||
			!/^\S+@\S+\.\S+$/.test(value.email) ||
			typeof value.message !== "string" ||
			!value.message.trim() ||
			value.consent !== "yes"
		) {
			json(
				res,
				{ error: "Name, email, message and consent are required" },
				422,
			);
			return true;
		}
		json(res, {
			ok: true,
			testMode: true,
			organization: organizationSlug(db.business),
			attribution: "microsite",
		});
		return true;
	}
	if (url.pathname === "/book") {
		res.writeHead(200, {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store",
		});
		res.end(bookingPage(db.business, url.searchParams, undefined, { style }));
		return true;
	}
	return false;
}
async function staticSite(
	res: ServerResponse,
	site: Site,
	version: Version,
	path: string,
) {
	let decoded: string;
	try {
		decoded = decodeURIComponent(path);
		if (
			decoded.includes("..") ||
			decoded.includes("\\") ||
			decoded.includes("\0")
		)
			throw new Error("Invalid path");
	} catch {
		res.writeHead(400, {
			"content-type": "text/plain",
			"cache-control": "no-store",
		});
		res.end("Invalid path");
		return;
	}
	const relative = decoded.replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
	let file = relative || "index.html";
	let data = await releaseStorage.read(site.id, version, `dist/${file}`);
	if (!data && relative) {
		file = `${relative}/index.html`;
		data = await releaseStorage.read(site.id, version, `dist/${file}`);
	}
	if (!data) {
		res.writeHead(404, { "content-type": "text/plain" });
		res.end("Page not found");
		return;
	}
	res.writeHead(200, {
		"content-type": mime[extname(file)] || "application/octet-stream",
		"cache-control": "no-store",
		"x-content-type-options": "nosniff",
		"content-security-policy": `${siteResourcePolicy}; frame-ancestors ${res.hasHeader("content-security-policy") ? origin : "'none'"}`,
	});
	res.end(data);
}
async function preview(
	req: IncomingMessage,
	res: ServerResponse,
	endpoint: Endpoint,
) {
	try {
		const url = new URL(req.url || "/", endpoint.origin);
		res.setHeader("content-security-policy", `frame-ancestors ${origin}`);
		res.setHeader("x-robots-tag", "noindex, nofollow");
		if (access.preview(req, res, url, endpoint)) return;
		if (url.pathname === "/__open") {
			if (req.headers["sec-fetch-site"] === "cross-site")
				throw new Error("Open previews from the studio");
			const site = await findSite(url.searchParams.get("site") || "");
			const versionId = url.searchParams.get("version") || undefined;
			if (versionId && !site.versions.some((v) => v.id === versionId))
				throw new Error("Version not found");
			// Opening the frame never restarts anything by itself (the studio
			// remounts it automatically); only the "Wake preview" button does.
			// The wake renews the workspace's idle deadline before restoring it.
			// The owner is redirected at once to "Waking your preview…", which
			// refreshes until the website answers.
			if (!versionId && site.threadId && url.searchParams.get("wake") === "1")
				void wakePreview(site, true);
			const token = randomUUID();
			sessions.set(token, {
				siteId: site.id,
				versionId,
				expiresAt: Date.now() + 20 * 60 * 1000,
			});
			const path = url.searchParams.get("path");
			res.writeHead(302, {
				"set-cookie": previewCookie(token),
				location: safePreviewPath(path),
				"cache-control": "no-store",
			});
			res.end();
			return;
		}
		const current = session(req);
		if (!current) {
			res.writeHead(401);
			res.end("Preview session expired. Refresh the preview from Site Studio.");
			return;
		}
		// Owner activity in the studio renews this cookie only where the two
		// origins share a host (locally); pages renew it on the gateway itself.
		if (isNavigation(req.headers))
			res.setHeader("set-cookie", previewCookie(current.token));
		const site = await findSite(current.siteId);
		// The paused page polls this; it reads the gateway's own state only and
		// never touches (or wakes) the workspace.
		if (url.pathname === "/__preview-state") {
			json(res, { state: previewState(site.id) ?? "paused" });
			return;
		}
		// The booking page takes the colours of the version being viewed (the
		// latest measured one for the live draft).
		const viewed = current.versionId
			? site.versions.find((v) => v.id === current.versionId)
			: site.versions.findLast((v) => v.bookingStyle);
		if (await siteKit(req, res, url, viewed?.bookingStyle)) return;
		if (current.versionId) {
			const version = site.versions.find((v) => v.id === current.versionId);
			if (version?.artifactDirectory) {
				await staticSite(res, site, version, url.pathname);
				return;
			}
			res.writeHead(409, { "content-type": "text/html" });
			res.end(
				'<p style="font:14px system-ui;padding:30px;color:#666">This version isn’t ready to view yet. Your latest draft is still available in the preview.</p>',
			);
			return;
		}
		if (site.threadId) {
			const navigation = isNavigation(req.headers);
			const grant = await previewGrant(site);
			if (grant) {
				const target = new URL(grant.url);
				const upstream =
					process.env.HOPLITE_PREVIEW_TRANSPORT_URL || target.origin;
				req.headers = {
					...req.headers,
					host: target.host,
					[grant.header.toLowerCase()]: grant.token,
				};
				delete req.headers.cookie;
				delete req.headers.authorization;
				delete req.headers.origin;
				// Pages are inspected before relaying; ask for them uncompressed.
				if (navigation) req.headers["accept-encoding"] = "identity";
				liveRequests.set(req, {
					site,
					navigation,
					path: url.pathname,
					origin: endpoint.origin,
				});
				liveProxy.web(req, res, { target: upstream, changeOrigin: false });
				return;
			}
			// No usable grant: the workspace is paused after idle or stopped.
			// Nothing here wakes it, so an idle preview still expires.
			previewUnavailable(site, "no_grant", url.pathname, res);
			return;
		}
		waitingPreview(res);
	} catch {
		if (session(req)?.versionId) {
			res.writeHead(503, {
				"content-type": "text/plain",
				"cache-control": "no-store",
			});
			res.end("Saved preview is temporarily unavailable. Please retry.");
		} else waitingPreview(res);
	}
}
async function previewUpgrade(
	req: IncomingMessage,
	socket: Duplex,
	head: Buffer,
	endpoint: Endpoint,
) {
	try {
		if (req.headers.origin !== endpoint.origin || !access.previewUpgrade(req))
			throw new Error("Invalid preview origin");
		const current = session(req);
		if (!current || current.versionId) throw new Error("No live preview");
		const site = await findSite(current.siteId);
		const grant = await previewGrant(site);
		if (!grant) throw new Error("Preview not ready");
		const target = new URL(grant.url);
		req.headers = {
			...req.headers,
			host: target.host,
			[grant.header.toLowerCase()]: grant.token,
		};
		delete req.headers.cookie;
		delete req.headers.authorization;
		req.headers.origin = target.origin;
		proxy.ws(req, socket, head, {
			target: process.env.HOPLITE_PREVIEW_TRANSPORT_URL || target.origin,
			changeOrigin: false,
		});
	} catch {
		socket.destroy();
	}
}
/**
 * Published websites are public (no access gate); their booking and lead
 * endpoints are test-only and create nothing.
 */
async function published(
	req: IncomingMessage,
	res: ServerResponse,
	endpoint: Endpoint,
) {
	try {
		const url = new URL(req.url || "/", endpoint.origin);
		// The public host serves the organisation's one website.
		const site = organisationSite(await database());
		if (!site) {
			res.writeHead(404);
			res.end("No published website");
			return;
		}
		const version = site.versions.find((v) => v.id === site.publishedVersionId);
		if (!version?.artifactDirectory || version.qa?.status !== "passed") {
			res.writeHead(404);
			res.end("No published release");
			return;
		}
		if (await siteKit(req, res, url, version.bookingStyle)) return;
		await staticSite(res, site, version, url.pathname);
	} catch {
		res.writeHead(503, {
			"content-type": "text/plain",
			"cache-control": "no-store",
		});
		res.end("Published website is temporarily unavailable. Please retry.");
	}
}
/**
 * One server per listening port. A port that serves several public origins
 * (hosted behind one proxy port) picks the role from the Host header; any
 * other host is refused.
 */
const listeners = hosting.listeners.map((listener) => {
	const server = createServer(async (req, res) => {
		// Answers on any host, so the platform health check needs no Host.
		if (req.url === "/healthz" && req.method === "GET") {
			res.writeHead(acceptingRequests ? 200 : 503, {
				"content-type": "text/plain",
				"cache-control": "no-store",
			});
			res.end(acceptingRequests ? "ok" : "starting");
			return;
		}
		if (starting(res)) return;
		const endpoint = endpointFor(listener, req.headers.host);
		if (!endpoint) {
			res.writeHead(403);
			res.end("Invalid host");
			return;
		}
		if (needsHttps(hosting, endpoint, req.headers)) {
			res.writeHead(308, { location: `${endpoint.origin}${req.url || "/"}` });
			res.end();
			return;
		}
		if (endpoint.role === "studio") await studio(req, res);
		else if (endpoint.role === "preview") await preview(req, res, endpoint);
		else await published(req, res, endpoint);
	});
	server.on("upgrade", (req, socket, head) => {
		const endpoint = endpointFor(listener, req.headers.host);
		if (!acceptingRequests || !endpoint || endpoint.role === "sites") {
			socket.destroy();
			return;
		}
		if (endpoint.role === "preview") {
			void previewUpgrade(req, socket, head, endpoint);
			return;
		}
		if (!access.studioUpgrade(req)) {
			socket.destroy();
			return;
		}
		void nextApp.getUpgradeHandler()(req, socket, head);
	});
	return { server, ...listener };
});
try {
	await Promise.all(
		listeners.map(
			({ server, port, host }) =>
				new Promise<void>((resolve, reject) => {
					server.once("error", reject);
					server.listen(port, host, () => {
						server.removeListener("error", reject);
						resolve();
					});
				}),
		),
	);
	// Own all listeners before reading or migrating customer metadata. Requests
	// remain unavailable until initialization finishes, including S3 migration.
	await database();
	await migrateBrandStorage();
	await migrateReleaseStorage();
	acceptingRequests = true;
} catch (error) {
	process.stderr.write(
		`Site Studio could not start: ${error instanceof Error ? error.message : String(error)}\n`,
	);
	// A failed second process must not overwrite the first process's metadata.
	process.exit(1);
}
process.stdout.write(`Site Studio: ${origin}\n`);
generationPolling.readMs = 10_000;
const polling = setInterval(() => {
	void tick().catch((error) =>
		process.stderr.write(
			`Demo polling failed: ${error instanceof Error ? error.message : "unknown"}\n`,
		),
	);
}, 2500).unref();

let stopping = false;
async function shutdown() {
	if (stopping) return;
	stopping = true;
	clearInterval(polling);
	for (const { server } of listeners) {
		server.close();
		server.closeAllConnections();
	}
	try {
		await settleAdmissions();
		await save();
		// Next and Playwright register signal handlers, so Node no longer exits
		// automatically. Leave a durable checkpoint and release every listener.
		process.exit(0);
	} catch (error) {
		process.stderr.write(
			`Could not save the shutdown checkpoint: ${error instanceof Error ? error.message : String(error)}\n`,
		);
		process.exit(1);
	}
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
