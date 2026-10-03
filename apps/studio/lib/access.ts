import {
	createHash,
	createHmac,
	randomBytes,
	timingSafeEqual,
} from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { clientAddress, type Endpoint, type Hosting } from "./hosting";

/**
 * Optional shared-password gate for a hosted demo.
 *
 * - The studio requires a signed session cookie (`studio_session`), set by
 *   the login form. It is HttpOnly, SameSite=Lax, host-only on the studio
 *   origin, and Secure when that origin is HTTPS.
 * - The preview gateway lives on another origin, so it keeps its own signed
 *   cookie (`studio_preview_access`), host-only on the preview origin. A
 *   preview request without it is redirected to the studio's
 *   `/__preview-auth`, which (given a studio session) redirects back to the
 *   gateway's `/__auth` with a single-use token valid for one minute. The
 *   gateway's cookie never outlives the studio session that granted it.
 * - Published websites are public and never see either cookie.
 *
 * Changing the password or `STUDIO_SESSION_SECRET` signs everyone out.
 */
export const sessionCookie = "studio_session";
export const previewAccessCookie = "studio_preview_access";
const sessionMs = 12 * 60 * 60 * 1000;
const handoffMs = 60 * 1000;
const loginBodyLimit = 4096;
/** Studio paths the login page itself needs. */
const publicStudioPaths = [
	/^\/login$/,
	/^\/_next\/static\//,
	/^\/fonts\//,
	/^\/studio-logo\.svg$/,
];

export type AccessConfig = { password: string; secret: string };

export function readAccess(
	env: Partial<Record<string, string>> = process.env,
): AccessConfig | undefined {
	const password = env.STUDIO_ACCESS_PASSWORD;
	if (!password) return;
	const secret = env.STUDIO_SESSION_SECRET ?? "";
	if (secret.length < 32)
		throw new Error(
			"STUDIO_SESSION_SECRET must be at least 32 characters when STUDIO_ACCESS_PASSWORD is set",
		);
	return { password, secret };
}

export function readCookie(header: string | undefined, name: string) {
	for (const part of header?.split(";") ?? []) {
		const index = part.indexOf("=");
		if (index > 0 && part.slice(0, index).trim() === name)
			return part.slice(index + 1).trim();
	}
}

/** Only same-origin paths; never `//host` or `/\host`. */
export function safeReturnPath(value: string | null | undefined) {
	return value?.startsWith("/") && !/^\/[/\\]/.test(value) ? value : "/";
}

/**
 * Failed login attempts per client and overall within a sliding window.
 * Successful sign-in clears the client's failures.
 */
export class LoginLimiter {
	private readonly failures = new Map<string, number[]>();
	private all: number[] = [];
	constructor(
		private readonly perClient = 10,
		private readonly overall = 100,
		private readonly windowMs = 15 * 60 * 1000,
	) {}
	private prune(now: number) {
		const since = now - this.windowMs;
		this.all = this.all.filter((time) => time > since);
		for (const [client, times] of this.failures) {
			const kept = times.filter((time) => time > since);
			if (kept.length) this.failures.set(client, kept);
			else this.failures.delete(client);
		}
	}
	allowed(client: string, now = Date.now()) {
		this.prune(now);
		return (
			(this.failures.get(client)?.length ?? 0) < this.perClient &&
			this.all.length < this.overall
		);
	}
	failed(client: string, now = Date.now()) {
		this.failures.set(client, [...(this.failures.get(client) ?? []), now]);
		this.all.push(now);
	}
	succeeded(client: string) {
		this.failures.delete(client);
	}
}

type Headers = Record<string, string | number | string[]>;

export function createAccess(
	hosting: Hosting,
	config: AccessConfig | undefined,
	options: { limiter?: LoginLimiter; now?: () => number } = {},
) {
	const now = options.now ?? Date.now;
	const limiter = options.limiter ?? new LoginLimiter();
	const usedHandoffs = new Map<string, number>();
	// Changing the password invalidates every signature made with the old one.
	const key = config
		? createHmac("sha256", config.secret)
				.update(createHash("sha256").update(config.password).digest())
				.digest()
		: Buffer.alloc(0);
	const expected = config
		? createHash("sha256").update(config.password).digest()
		: Buffer.alloc(0);

	function mac(purpose: string, expires: number, data: string) {
		return createHmac("sha256", key)
			.update(`${purpose}.${expires}.${data}`)
			.digest("base64url");
	}
	function sign(purpose: string, expires: number, data: string) {
		return `${expires}.${data}.${mac(purpose, expires, data)}`;
	}
	/** Returns the token's expiry and data if it is valid for this purpose. */
	function verify(purpose: string, token: string | undefined | null) {
		const match = token?.match(
			/^(\d{1,16})\.([A-Za-z0-9_-]{1,128})\.([A-Za-z0-9_-]{43})$/,
		);
		if (!config || !match) return;
		const expires = Number(match[1]);
		if (expires <= now()) return;
		const actual = Buffer.from(match[3]);
		const wanted = Buffer.from(mac(purpose, expires, match[2]));
		if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted))
			return;
		return { expires, data: match[2] };
	}
	function cookie(
		name: string,
		value: string,
		expires: number,
		origin: string,
	) {
		const maxAge = Math.max(0, Math.floor((expires - now()) / 1000));
		return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${origin.startsWith("https:") ? "; Secure" : ""}`;
	}
	function redirect(
		res: ServerResponse,
		location: string,
		headers: Headers = {},
	) {
		res.writeHead(303, { location, "cache-control": "no-store", ...headers });
		res.end();
	}
	function plain(res: ServerResponse, status: number, message: string) {
		res.writeHead(status, {
			"content-type": "text/plain; charset=utf-8",
			"cache-control": "no-store",
		});
		res.end(message);
	}
	function studioSession(req: IncomingMessage) {
		return verify("session", readCookie(req.headers.cookie, sessionCookie));
	}
	function passwordMatches(value: string) {
		const actual = createHash("sha256").update(value).digest();
		return timingSafeEqual(actual, expected);
	}
	async function form(req: IncomingMessage) {
		let size = 0;
		const chunks: Buffer[] = [];
		for await (const part of req) {
			const chunk = Buffer.from(part);
			size += chunk.length;
			if (size > loginBodyLimit) return;
			chunks.push(chunk);
		}
		return new URLSearchParams(Buffer.concat(chunks).toString());
	}
	async function login(req: IncomingMessage, res: ServerResponse) {
		// Browsers send Origin on form posts; this refuses cross-site logins.
		if (req.headers.origin !== hosting.studioOrigin) {
			plain(res, 403, "Sign in from the studio.");
			return;
		}
		const client = clientAddress(
			hosting,
			req.headers,
			req.socket.remoteAddress,
		);
		const values = await form(req);
		const next = safeReturnPath(values?.get("next"));
		const retry = (error: string) =>
			redirect(
				res,
				`/login?error=${error}${next === "/" ? "" : `&next=${encodeURIComponent(next)}`}`,
			);
		if (!limiter.allowed(client)) {
			retry("limited");
			return;
		}
		if (!values || !passwordMatches(values.get("password") ?? "")) {
			limiter.failed(client);
			retry("invalid");
			return;
		}
		limiter.succeeded(client);
		const expires = now() + sessionMs;
		redirect(res, next, {
			"set-cookie": cookie(
				sessionCookie,
				sign("session", expires, randomBytes(12).toString("base64url")),
				expires,
				hosting.studioOrigin,
			),
		});
	}

	return {
		enabled: Boolean(config),
		/**
		 * Studio requests. Handles the login form and the preview handoff, and
		 * answers requests without a session. Returns true when it responded.
		 */
		async studio(req: IncomingMessage, res: ServerResponse, url: URL) {
			if (!config) {
				if (url.pathname !== "/login") return false;
				redirect(res, "/");
				return true;
			}
			if (url.pathname === "/login" && req.method === "POST") {
				await login(req, res);
				return true;
			}
			const session = studioSession(req);
			if (url.pathname === "/login" && session) {
				redirect(res, safeReturnPath(url.searchParams.get("next")));
				return true;
			}
			if (publicStudioPaths.some((path) => path.test(url.pathname)))
				return false;
			if (!session) {
				if (url.pathname.startsWith("/api/")) {
					res.writeHead(401, {
						"content-type": "application/json",
						"cache-control": "no-store",
					});
					res.end(JSON.stringify({ error: "Sign in to continue." }));
				} else if (url.pathname === "/__preview-auth")
					plain(res, 401, "Sign in to see the preview.");
				else if (req.method === "GET" || req.method === "HEAD")
					redirect(
						res,
						`/login${url.pathname === "/" && !url.search ? "" : `?next=${encodeURIComponent(url.pathname + url.search)}`}`,
					);
				else plain(res, 401, "Sign in to continue.");
				return true;
			}
			if (url.pathname === "/__preview-auth") {
				let target: URL;
				try {
					target = new URL(url.searchParams.get("return") ?? "");
				} catch {
					plain(res, 400, "Open the preview from the studio.");
					return true;
				}
				if (target.origin !== hosting.previewOrigin) {
					plain(res, 400, "Open the preview from the studio.");
					return true;
				}
				const token = sign(
					"preview-handoff",
					now() + handoffMs,
					`${session.expires}_${randomBytes(12).toString("base64url")}`,
				);
				redirect(
					res,
					`${hosting.previewOrigin}/__auth?token=${encodeURIComponent(token)}&return=${encodeURIComponent(target.pathname + target.search)}`,
				);
				return true;
			}
			return false;
		},
		studioUpgrade(req: IncomingMessage) {
			return !config || Boolean(studioSession(req));
		},
		/**
		 * Preview gateway requests. Handles the handoff landing and answers
		 * requests without preview access. Returns true when it responded.
		 */
		preview(
			req: IncomingMessage,
			res: ServerResponse,
			url: URL,
			endpoint: Endpoint,
		) {
			if (!config) return false;
			if (url.pathname === "/__auth") {
				const token = url.searchParams.get("token");
				const handoff = verify("preview-handoff", token);
				const expires = Number(handoff?.data.split("_")[0]);
				for (const [used, until] of usedHandoffs)
					if (until <= now()) usedHandoffs.delete(used);
				if (
					!handoff ||
					!token ||
					usedHandoffs.has(token) ||
					!(expires > now())
				) {
					plain(res, 401, "Open the preview from the studio.");
					return true;
				}
				usedHandoffs.set(token, handoff.expires);
				redirect(res, safeReturnPath(url.searchParams.get("return")), {
					"set-cookie": cookie(
						previewAccessCookie,
						sign("preview", expires, randomBytes(12).toString("base64url")),
						expires,
						endpoint.origin,
					),
				});
				return true;
			}
			if (
				verify("preview", readCookie(req.headers.cookie, previewAccessCookie))
			)
				return false;
			const navigation =
				req.method === "GET" &&
				(req.headers["sec-fetch-dest"] === "iframe" ||
					req.headers["sec-fetch-dest"] === "document" ||
					/text\/html/.test(req.headers.accept ?? ""));
			if (navigation && endpoint.origin === hosting.previewOrigin)
				redirect(
					res,
					`${hosting.studioOrigin}/__preview-auth?return=${encodeURIComponent(endpoint.origin + url.pathname + url.search)}`,
				);
			else plain(res, 401, "Sign in to the studio to see the preview.");
			return true;
		},
		previewUpgrade(req: IncomingMessage) {
			return (
				!config ||
				Boolean(
					verify(
						"preview",
						readCookie(req.headers.cookie, previewAccessCookie),
					),
				)
			);
		},
		/**
		 * Preview access for the in-process browser checks, which reach the
		 * gateway over loopback without a studio session.
		 */
		checkCookie(origin: string) {
			if (!config) return;
			const expires = now() + 60 * 60 * 1000;
			return {
				name: previewAccessCookie,
				value: sign("preview", expires, randomBytes(12).toString("base64url")),
				url: origin,
				httpOnly: true,
				sameSite: "Lax" as const,
				expires: Math.floor(expires / 1000),
			};
		},
	};
}
export type Access = ReturnType<typeof createAccess>;
