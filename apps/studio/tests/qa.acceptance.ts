import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { test } from "node:test";
import { artifactRoutes, browserQA } from "../lib/qa";
import { business, type JsonValue } from "../lib/types";

test("QA covers unlinked generated pages, tests real form receipts, and preserves actionable browser evidence", {
	timeout: 300_000,
}, async () => {
	const root = await mkdtemp(join(tmpdir(), "studio-route-qa-"));
	let broken = false;
	let reviewFailures = false;
	let testMode = true;
	let writes = 0;
	let waitingResponses = 0;
	let unapprovedWrites = 0;
	let loadingPageNavigations = 0;
	const server = createServer(async (req, res) => {
		try {
			const path = new URL(req.url ?? "/", "http://fixture").pathname;
			const json = (value: JsonValue) => {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify(value));
			};
			if (path === "/__open") {
				if (req.headers["sec-fetch-mode"] === "navigate") {
					loadingPageNavigations++;
					res.writeHead(503, {
						"content-type": "text/html",
						"x-studio-preview-state": "starting",
						refresh: "0.1",
					});
					res.end("<title>Starting preview</title>");
					return;
				}
				res.writeHead(302, {
					location: "/",
					"set-cookie": "qa_session=fixture; HttpOnly; SameSite=Strict; Path=/",
				});
				res.end();
				return;
			}
			if (!req.headers.cookie?.includes("qa_session=fixture")) {
				res.writeHead(401);
				res.end("Missing preview session");
				return;
			}
			if (path === "/site-kit/qa") {
				json({ testMode, organization: "harbour" });
				return;
			}
			if (path === "/site-kit/data") {
				json(business);
				return;
			}
			if (path === "/site-kit/leads" && req.method === "POST") {
				writes++;
				let body = "";
				for await (const chunk of req) body += chunk;
				const value = JSON.parse(body);
				if (value.email !== "qa@example.test" || value.consent !== "yes")
					unapprovedWrites++;
				json({
					ok: true,
					testMode,
					organization: "harbour",
					attribution: "microsite",
				});
				return;
			}
			if (path === "/book") {
				res.writeHead(200, { "content-type": "text/html" });
				res.end(
					'<!doctype html><html lang="en"><head><title>Book</title></head><body><main data-booking-organization="harbour"><h1>Test booking</h1><a href="/">Home</a></main></body></html>',
				);
				return;
			}
			const pages: Record<string, string> = {
				"/": "index",
				"/services": "services",
				"/contact": "contact",
				"/extra": "contact",
			};
			const page = pages[path.replace(/\/$/, "") || "/"];
			if (page) {
				let html = await readFile(
					join("seed/src/pages", `${page}.astro`),
					"utf8",
				);
				if (broken && path.startsWith("/extra")) {
					html = html.replace(
						'aria-label="Toggle navigation"',
						'aria-label="Toggle navigation" disabled',
					);
					html = html.replace(
						'href="/book"',
						'href="https://wrong-org.example/book"',
					);
					html = html.replace(
						"<h1>",
						'<img src="https://unapproved.example.test/blocked.svg" alt="Blocked asset"/><img src="/missing-required-image.png" alt="The studio"/><a href="/missing-route">Missing page</a><h1>',
					);
					html = html.replace(
						'name="consent" value="yes" required',
						'name="consent" value="yes"',
					);
				}
				if (reviewFailures && path.startsWith("/extra")) {
					html = html.replace(/<form\b[\s\S]*?<\/form>/g, "");
					html = html.replace(
						'<html lang="en">',
						'<html lang="en" xml:lang="fr">',
					);
					html = html
						.replace('<p data-business="email"></p>', "")
						.replace('<p data-business="phone"></p>', "");
					html = html.replace(
						"</body>",
						`<script>
						if (matchMedia('(max-width: 500px)').matches) document.querySelector('nav a[href="/book"]').href = '/wrong-booking-org';
					</script></body>`,
					);
				}
				const waiting = waitingResponses > 0 && path.startsWith("/contact");
				if (waiting) waitingResponses--;
				res.writeHead(waiting ? 503 : 200, {
					"content-type": "text/html",
					...(waiting ? { "x-studio-preview-state": "starting" } : {}),
				});
				res.end(html);
				return;
			}
			if (path.includes("..")) throw new Error("Invalid fixture path");
			const asset = await readFile(join("seed/public", path));
			res.writeHead(200, {
				"content-type":
					(
						{
							".js": "application/javascript",
							".css": "text/css",
							".woff2": "font/woff2",
							".jpg": "image/jpeg",
							".svg": "image/svg+xml",
						} as Record<string, string>
					)[extname(path)] ?? "application/octet-stream",
			});
			res.end(asset);
		} catch {
			res.writeHead(404);
			res.end("Not found");
		}
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const origin = `http://127.0.0.1:${address.port}`;
	try {
		const routes = artifactRoutes(
			[
				"index.html",
				"services/index.html",
				"contact/index.html",
				"extra/index.html",
			].map((path) => ({ path })),
		);
		const healthy = await browserQA(
			"fixture",
			"release",
			join(root, "healthy"),
			{ origin, routes, business },
		);
		assert.deepEqual(
			healthy.errors,
			[],
			JSON.stringify(healthy.errors, null, 2),
		);
		assert.equal(healthy.status, "passed");
		assert.equal(loadingPageNavigations, 0);
		assert.ok(
			healthy.evidence?.some(
				(e) =>
					e.route === "/extra/" &&
					e.viewport.width === 390 &&
					e.action === "Page health",
			),
		);
		assert.equal(
			writes,
			6,
			"Both contact forms are tested at each viewport exactly once",
		);
		assert.equal(unapprovedWrites, 0);
		assert.ok(
			healthy.evidence?.some(
				(e) =>
					e.action.startsWith("Booking link") &&
					new URL(e.url).pathname === "/book" &&
					e.screenshot,
			),
		);
		for (const item of healthy.evidence ?? []) {
			assert.ok(item.expected && item.actual && item.url);
			assert.ok(item.screenshot);
			assert.ok(
				(await readFile(join(root, "healthy", item.screenshot))).length,
			);
		}
		for (const route of ["/contact/", "/services/"]) {
			assert.ok(
				healthy.evidence?.some(
					(e) =>
						e.route === route &&
						e.viewport.width === 390 &&
						e.action.startsWith("Booking link") &&
						e.status === "passed",
				),
				`Mobile booking not exercised on ${route}`,
			);
		}
		reviewFailures = true;
		const reviewRejected = await browserQA(
			"fixture",
			"release",
			join(root, "review-failures"),
			{ origin, routes: ["/", "/services/", "/extra/"], business },
		);
		assert.equal(reviewRejected.status, "failed");
		assert.match(
			reviewRejected.errors.join("\n"),
			/No enquiry form was exercised/,
		);
		assert.ok(
			reviewRejected.evidence?.some(
				(e) =>
					e.route === "/extra/" &&
					e.viewport.width === 390 &&
					e.action.startsWith("Booking link") &&
					e.status === "failed" &&
					e.actual.includes("Booking bypasses Site Kit"),
			),
		);
		assert.ok(
			!reviewRejected.evidence?.some(
				(e) =>
					e.viewport.width !== 390 &&
					e.action.startsWith("Booking link") &&
					e.status === "failed",
			),
		);
		assert.match(reviewRejected.errors.join("\n"), /No live email binding/);
		assert.match(reviewRejected.errors.join("\n"), /No live phone binding/);
		assert.ok(
			reviewRejected.errors
				.filter((error) => /No live (email|phone) binding/.test(error))
				.every((error) => error.startsWith("Site-wide at ")),
			"Missing global bindings must not be attributed to the last route",
		);
		assert.ok(
			reviewRejected.evidence?.some(
				(e) =>
					e.action === "Accessibility" &&
					e.status === "warning" &&
					e.actual.includes("html-xml-lang-mismatch"),
			),
		);
		assert.ok(
			!reviewRejected.checks.some(
				(check) =>
					check.startsWith("/extra/") && check.endsWith("Accessibility"),
			),
		);
		reviewFailures = false;
		broken = true;
		const rejected = await browserQA(
			"fixture",
			undefined,
			join(root, "broken"),
			{ origin, routes: ["/extra/"], business },
		);
		assert.equal(rejected.status, "failed");
		assert.ok(
			rejected.evidence?.some(
				(e) => e.route === "/extra/" && e.status === "failed",
			),
		);
		assert.match(rejected.errors.join("\n"), /missing-required-image/);
		assert.match(
			rejected.errors.join("\n"),
			/Unapproved network destination: https:\/\/unapproved\.example\.test/,
		);
		assert.ok(
			!rejected.errors.some((error) =>
				error.includes("GET https://unapproved.example.test/blocked.svg"),
			),
			"An intentionally aborted request must not create a duplicate requestfailed issue",
		);
		assert.ok(
			rejected.evidence?.some((item) =>
				item.network.some((entry) =>
					entry.includes("GET https://unapproved.example.test/blocked.svg"),
				),
			),
			"The raw aborted request remains available as network evidence",
		);
		assert.match(rejected.errors.join("\n"), /Broken internal link/);
		assert.match(rejected.errors.join("\n"), /Booking bypasses Site Kit/);
		assert.match(rejected.errors.join("\n"), /Consent is not required/);
		const persisted = JSON.parse(
			await readFile(join(root, "broken/qa-report.json"), "utf8"),
		);
		assert.ok(
			persisted.evidence.some((e: { network: string[] }) =>
				e.network.some((entry) => entry.includes("404")),
			),
		);
		broken = false;
		waitingResponses = 1;
		const intermittent = await browserQA(
			"fixture",
			undefined,
			join(root, "intermittent"),
			{ origin, routes: ["/contact/", "/services/"], business },
		);
		assert.equal(
			intermittent.failureCategory,
			"infrastructure",
			"A later successful viewport must not spend repairs for an earlier provider failure",
		);
		assert.equal(waitingResponses, 0);
		const before = writes;
		testMode = false;
		const unsafe = await browserQA("fixture", undefined, join(root, "unsafe"), {
			origin,
			routes: ["/contact/"],
			business,
		});
		assert.equal(unsafe.failureCategory, "integration");
		assert.equal(
			writes,
			before,
			"No submissions occur without the explicit test-mode contract",
		);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(root, { recursive: true, force: true });
	}
});
