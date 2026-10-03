import assert from "node:assert/strict";
import { createServer, type IncomingMessage, request } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import {
	createAccess,
	LoginLimiter,
	previewAccessCookie,
	readAccess,
	safeReturnPath,
	sessionCookie,
} from "../lib/access";
import { endpointFor, readHosting } from "../lib/hosting";

const studio = "https://studio.example.com";
const previewHost = "preview.studio.example.com";
const preview = `https://${previewHost}`;
const sitesHost = "sites.studio.example.com";
const env = {
	STUDIO_LISTEN_HOST: "0.0.0.0",
	STUDIO_LISTEN_PORT: "8080",
	STUDIO_ORIGIN: studio,
	STUDIO_PREVIEW_ORIGIN: preview,
	STUDIO_SITES_ORIGIN: `https://${sitesHost}`,
	STUDIO_TRUST_PROXY: "fly",
	STUDIO_ACCESS_PASSWORD: "correct horse battery staple",
	STUDIO_SESSION_SECRET: "s".repeat(48),
};

type Reply = {
	status: number;
	headers: IncomingMessage["headers"];
	body: string;
};

/**
 * A stand-in for server.ts: the same Host routing and gate calls, with a
 * trivial response wherever the real server would continue.
 */
async function gatedServer(
	environment: Partial<Record<string, string>> = env,
	options: Parameters<typeof createAccess>[2] = {},
) {
	const hosting = readHosting(environment);
	const access = createAccess(hosting, readAccess(environment), options);
	const [listener] = hosting.listeners;
	const server = createServer(async (req, res) => {
		const endpoint = endpointFor(listener, req.headers.host);
		if (!endpoint) {
			res.writeHead(403);
			res.end("Invalid host");
			return;
		}
		const url = new URL(req.url || "/", endpoint.origin);
		if (endpoint.role === "studio" && (await access.studio(req, res, url)))
			return;
		if (endpoint.role === "preview" && access.preview(req, res, url, endpoint))
			return;
		res.writeHead(200);
		res.end(`${endpoint.role} ${url.pathname}`);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as AddressInfo).port;
	function send(
		host: string,
		path: string,
		init: {
			method?: string;
			headers?: Record<string, string>;
			body?: string;
		} = {},
	) {
		return new Promise<Reply>((resolve, reject) => {
			const req = request(
				{
					host: "127.0.0.1",
					port,
					path,
					method: init.method ?? "GET",
					headers: { host, ...init.headers },
				},
				(res) => {
					let body = "";
					res.setEncoding("utf8");
					res.on("data", (chunk) => {
						body += chunk;
					});
					res.on("end", () =>
						resolve({
							status: res.statusCode ?? 0,
							headers: res.headers,
							body,
						}),
					);
				},
			);
			req.on("error", reject);
			req.end(init.body);
		});
	}
	function login(password: string, client = "198.51.100.1", next = "/") {
		return send("studio.example.com", "/login", {
			method: "POST",
			headers: {
				origin: studio,
				"content-type": "application/x-www-form-urlencoded",
				"fly-client-ip": client,
			},
			body: new URLSearchParams({ password, next }).toString(),
		});
	}
	return { server, access, send, login };
}

function cookieFrom(reply: Reply, name: string) {
	const header = reply.headers["set-cookie"]?.find((value) =>
		value.startsWith(`${name}=`),
	);
	assert.ok(header, `expected ${name} cookie`);
	return { header, pair: header.split(";")[0] };
}

test("without a password the studio is open and /login goes home", async () => {
	const { server, access, send } = await gatedServer({
		...env,
		STUDIO_ACCESS_PASSWORD: "",
	});
	try {
		assert.equal(access.enabled, false);
		assert.equal((await send("studio.example.com", "/")).status, 200);
		assert.equal(
			(await send("studio.example.com", "/api/state")).status,
			200,
		);
		assert.equal((await send(previewHost, "/__open?site=x")).status, 200);
		const login = await send("studio.example.com", "/login");
		assert.equal(login.status, 303);
		assert.equal(login.headers.location, "/");
		assert.equal(access.checkCookie("http://127.0.0.1:4321"), undefined);
	} finally {
		server.close();
	}
});

test("the password needs a strong session secret", () => {
	assert.equal(readAccess({}), undefined);
	assert.throws(
		() =>
			readAccess({
				STUDIO_ACCESS_PASSWORD: "pw",
				STUDIO_SESSION_SECRET: "short",
			}),
		/STUDIO_SESSION_SECRET/,
	);
});

test("the studio requires a signed session cookie from the login form", async () => {
	const { server, send, login } = await gatedServer();
	try {
		const home = await send("studio.example.com", "/");
		assert.equal(home.status, 303);
		assert.equal(home.headers.location, "/login");
		const deep = await send("studio.example.com", "/business?tab=1");
		assert.equal(
			deep.headers.location,
			`/login?next=${encodeURIComponent("/business?tab=1")}`,
		);
		const api = await send("studio.example.com", "/api/state");
		assert.equal(api.status, 401);
		assert.deepEqual(JSON.parse(api.body), { error: "Sign in to continue." });
		// The login page and its assets are reachable without a session.
		for (const path of [
			"/login",
			"/_next/static/chunk.js",
			"/studio-logo.svg",
		])
			assert.equal(
				(await send("studio.example.com", path)).status,
				200,
				path,
			);
		// Cross-site form posts are refused.
		const forged = await send("studio.example.com", "/login", {
			method: "POST",
			headers: { origin: "https://evil.example" },
			body: "password=x",
		});
		assert.equal(forged.status, 403);
		const wrong = await login("guess");
		assert.equal(wrong.status, 303);
		assert.equal(wrong.headers.location, "/login?error=invalid");
		assert.equal(wrong.headers["set-cookie"], undefined);
		const right = await login(
			env.STUDIO_ACCESS_PASSWORD,
			undefined,
			"/business",
		);
		assert.equal(right.status, 303);
		assert.equal(right.headers.location, "/business");
		const cookie = cookieFrom(right, sessionCookie);
		assert.match(cookie.header, /; HttpOnly/);
		assert.match(cookie.header, /; SameSite=Lax/);
		assert.match(cookie.header, /; Secure/);
		assert.match(cookie.header, /; Path=\//);
		assert.doesNotMatch(cookie.header, /Domain=/i, "host-only on the studio");
		const signedIn = await send("studio.example.com", "/api/state", {
			headers: { cookie: cookie.pair },
		});
		assert.equal(signedIn.status, 200);
		const loginAgain = await send(
			"studio.example.com",
			"/login?next=/business",
			{
				headers: { cookie: cookie.pair },
			},
		);
		assert.equal(loginAgain.headers.location, "/business");
		const tampered = `${cookie.pair.slice(0, -2)}xx`;
		assert.equal(
			(
				await send("studio.example.com", "/api/state", {
					headers: { cookie: tampered },
				})
			).status,
			401,
		);
		// The session is not valid for the preview gateway's own cookie.
		assert.equal(
			(
				await send(previewHost, "/__preview-state", {
					headers: {
						cookie: `${previewAccessCookie}=${cookie.pair.split("=")[1]}`,
					},
				})
			).status,
			401,
		);
		// Open redirects are refused.
		const offsite = await login(
			env.STUDIO_ACCESS_PASSWORD,
			undefined,
			"//evil.example",
		);
		assert.equal(offsite.headers.location, "/");
	} finally {
		server.close();
	}
});

test("sessions expire and a new password signs everyone out", async () => {
	let now = Date.now();
	const first = await gatedServer(env, { now: () => now });
	let pair: string;
	try {
		pair = cookieFrom(
			await first.login(env.STUDIO_ACCESS_PASSWORD),
			sessionCookie,
		).pair;
		const state = () =>
			first.send("studio.example.com", "/api/state", {
				headers: { cookie: pair },
			});
		assert.equal((await state()).status, 200);
		now += 13 * 60 * 60 * 1000;
		assert.equal((await state()).status, 401);
	} finally {
		first.server.close();
	}
	const old = await gatedServer();
	const fresh = cookieFrom(
		await old.login(env.STUDIO_ACCESS_PASSWORD),
		sessionCookie,
	).pair;
	old.server.close();
	const second = await gatedServer({ ...env, STUDIO_ACCESS_PASSWORD: "new" });
	try {
		assert.equal(
			(
				await second.send("studio.example.com", "/api/state", {
					headers: { cookie: fresh },
				})
			).status,
			401,
		);
	} finally {
		second.server.close();
	}
});

test("login attempts are rate-limited per client and overall", async () => {
	const { server, login } = await gatedServer(env, {
		limiter: new LoginLimiter(3, 5),
	});
	try {
		for (let attempt = 0; attempt < 3; attempt++)
			assert.equal(
				(await login("guess")).headers.location,
				"/login?error=invalid",
			);
		// Even the right password waits once the client is limited.
		const limited = await login(env.STUDIO_ACCESS_PASSWORD);
		assert.equal(limited.headers.location, "/login?error=limited");
		assert.equal(limited.headers["set-cookie"], undefined);
		// Another client (Fly-Client-IP, trusted) is unaffected...
		assert.equal(
			(await login(env.STUDIO_ACCESS_PASSWORD, "198.51.100.2")).headers
				.location,
			"/",
		);
		// ...until the overall limit is reached.
		await login("guess", "198.51.100.3");
		await login("guess", "198.51.100.4");
		assert.equal(
			(await login(env.STUDIO_ACCESS_PASSWORD, "198.51.100.5")).headers
				.location,
			"/login?error=limited",
		);
	} finally {
		server.close();
	}
	const limiter = new LoginLimiter(1, 10, 1000);
	limiter.failed("a", 0);
	assert.equal(limiter.allowed("a", 500), false);
	assert.equal(limiter.allowed("a", 1500), true, "failures age out");
});

test("the preview gateway requires access handed over from a studio session", async () => {
	const { server, access, send, login } = await gatedServer();
	try {
		const open = "/__open?site=s1&version=&path=%2F";
		const frame = await send(previewHost, open, {
			headers: { "sec-fetch-dest": "iframe" },
		});
		assert.equal(frame.status, 303);
		const handoff = new URL(frame.headers.location ?? "");
		assert.equal(handoff.origin, studio);
		assert.equal(handoff.pathname, "/__preview-auth");
		assert.equal(handoff.searchParams.get("return"), `${preview}${open}`);
		// Without a studio session the studio grants nothing.
		const refused = await send(
			"studio.example.com",
			handoff.pathname + handoff.search,
		);
		assert.equal(refused.status, 401);
		const session = cookieFrom(
			await login(env.STUDIO_ACCESS_PASSWORD),
			sessionCookie,
		).pair;
		// Only the preview origin can be the return target.
		const elsewhere = await send(
			"studio.example.com",
			`/__preview-auth?return=${encodeURIComponent("https://evil.example/")}`,
			{ headers: { cookie: session } },
		);
		assert.equal(elsewhere.status, 400);
		const granted = await send(
			"studio.example.com",
			handoff.pathname + handoff.search,
			{ headers: { cookie: session } },
		);
		assert.equal(granted.status, 303);
		const landing = new URL(granted.headers.location ?? "");
		assert.equal(landing.origin, preview);
		assert.equal(landing.pathname, "/__auth");
		assert.equal(landing.searchParams.get("return"), open);
		const accepted = await send(previewHost, landing.pathname + landing.search);
		assert.equal(accepted.status, 303);
		assert.equal(accepted.headers.location, open);
		const access_ = cookieFrom(accepted, previewAccessCookie);
		assert.match(access_.header, /; HttpOnly/);
		assert.match(access_.header, /; Secure/);
		assert.match(access_.header, /; SameSite=Lax/);
		assert.doesNotMatch(access_.header, /Domain=/i, "host-only on the preview");
		const maxAge = Number(access_.header.match(/Max-Age=(\d+)/)?.[1]);
		assert.ok(
			maxAge > 0 && maxAge <= 12 * 60 * 60,
			"never outlives the session",
		);
		// The handoff token is single-use.
		assert.equal(
			(await send(previewHost, landing.pathname + landing.search)).status,
			401,
		);
		assert.equal(
			(await send(previewHost, "/__auth?token=1.abc.def&return=/")).status,
			401,
		);
		const opened = await send(previewHost, open, {
			headers: { cookie: access_.pair },
		});
		assert.equal(opened.status, 200);
		assert.equal(opened.body, "preview /__open");
		// Sub-resources and polls without access are refused, not redirected.
		const poll = await send(previewHost, "/__preview-state");
		assert.equal(poll.status, 401);
		// WebSocket upgrades need the same access.
		const upgrade = (cookie?: string) =>
			access.previewUpgrade({
				headers: cookie ? { cookie } : {},
			} as IncomingMessage);
		assert.equal(upgrade(), false);
		assert.equal(upgrade(access_.pair), true);
		// In-process browser checks get their own preview access.
		const check = access.checkCookie("http://127.0.0.1:4321");
		assert.ok(check);
		assert.equal(check.url, "http://127.0.0.1:4321");
		assert.equal(
			(
				await send(previewHost, "/", {
					headers: { cookie: `${check.name}=${check.value}` },
				})
			).status,
			200,
		);
	} finally {
		server.close();
	}
});

test("published websites stay public while the gate is on", async () => {
	const { server, send } = await gatedServer();
	try {
		for (const path of ["/", "/services/", "/book", "/site-kit/data"]) {
			const reply = await send(sitesHost, path);
			assert.equal(reply.status, 200, path);
			assert.equal(reply.body, `sites ${path}`);
			assert.equal(reply.headers["set-cookie"], undefined);
		}
		assert.equal((await send("studio-demo.fly.dev", "/")).status, 403);
	} finally {
		server.close();
	}
});

test("return paths never leave the origin", () => {
	assert.equal(safeReturnPath("/business?x=1"), "/business?x=1");
	for (const value of [
		"//evil.example",
		"/\\evil.example",
		"https://evil.example",
		"",
		null,
	])
		assert.equal(safeReturnPath(value), "/");
});
