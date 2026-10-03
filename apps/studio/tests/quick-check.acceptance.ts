import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { chromium } from "playwright";
import { validBusiness } from "../lib/business";
import { quickAccessibilityCheck, quickViewports } from "../lib/qa";
import { bookingButtonStyle, bookingPage } from "../lib/site-pages";
import { business } from "../lib/types";

test("the quick check scans every page and the booking page in seconds; booking times follow the chosen day", {
	timeout: 90_000,
}, async () => {
	let contrast = "#b8b8b8";
	const hours = validBusiness({
		...business,
		weeklyHours: {
			mon: { open: "08:00", close: "18:00" },
			sat: { open: "09:00", close: "14:00" },
		},
	});
	const server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		if (url.pathname === "/__open") {
			assert.equal(url.searchParams.get("version"), "version-1");
			res.writeHead(302, {
				"set-cookie": "studio_preview=quick; Path=/; HttpOnly",
				location: "/",
			});
			res.end();
			return;
		}
		if (!req.headers.cookie?.includes("quick")) {
			res.writeHead(404);
			res.end();
			return;
		}
		if (url.pathname === "/book") {
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			res.end(bookingPage(hours, url.searchParams));
			return;
		}
		if (url.pathname === "/site.css") {
			res.writeHead(200, { "content-type": "text/css" });
			res.end("body { background: #fff; color: #111; font: 16px system-ui; }");
			return;
		}
		const pages: Record<string, string> = {
			"/": `<h1>Salon Nua</h1><p>Walk-ins welcome most afternoons.</p><a href="/book" style="display:inline-block;padding:12px 20px;background:rgb(20, 60, 40);color:rgb(255, 255, 255)">Book a visit</a>`,
			"/services": `<h1>Services</h1><p style="color:${contrast}">Every treatment is tailored to you.</p>`,
		};
		const page = pages[url.pathname];
		if (!page) {
			res.writeHead(404);
			res.end();
			return;
		}
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		res.end(
			`<!doctype html><html lang="en"><head><title>Salon</title></head><body style="background:#fff;color:#111;font:16px system-ui"><main>${page}</main></body></html>`,
		);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const origin = `http://127.0.0.1:${address.port}`;
	try {
		const started = Date.now();
		// One viewport keeps local runs light; production scans phone and computer.
		const result = await quickAccessibilityCheck("site", "version-1", {
			origin,
			viewports: [quickViewports[0]],
			routes: ["/", "/services", "/book"],
		});
		assert.ok(Date.now() - started < 30_000, "a matter of seconds");
		// The low-contrast text is on a page other than the home page; the
		// booking page's own text (dimmed in run 4) passes.
		assert.equal(result.issues.length, 1, result.issues.join("\n"));
		assert.match(result.issues[0], /^Page \/services at 390px: color-contrast/);
		assert.match(result.issues[0], /insufficient color contrast/);
		assert.deepEqual(
			result.bookingStyle && bookingButtonStyle(result.bookingStyle),
			{
				background: "rgb(20 60 40)",
				color: "rgb(255 255 255)",
			},
		);
		contrast = "#595959";
		const fixed = await quickAccessibilityCheck("site", "version-1", {
			origin,
			viewports: [quickViewports[0]],
			routes: ["/", "/services", "/book"],
		});
		assert.deepEqual(fixed.issues, []);

		// The booking page's times follow the chosen day and service.
		const browser = await chromium.launch({
			headless: true,
			channel: "chrome",
		});
		try {
			const context = await browser.newContext({
				viewport: quickViewports[0],
			});
			await context.request.get(`${origin}/__open?version=version-1`, {
				maxRedirects: 0,
			});
			const page = await context.newPage();
			await page.goto(`${origin}/book?service=Sports%20massage`);
			const saturday = await page
				.locator("#booking-day option")
				.evaluateAll(
					(options) =>
						(options as HTMLOptionElement[]).find((option) =>
							option.textContent?.startsWith("Sat"),
						)?.value,
				);
			assert.ok(saturday);
			await page.selectOption("#booking-day", saturday);
			const times = await page
				.locator("#booking-time option")
				.evaluateAll((options) =>
					(options as HTMLOptionElement[])
						.map((option) => option.value)
						.filter(Boolean),
				);
			assert.equal(times[0], "09:00");
			assert.equal(times.at(-1), "13:00", "a 60-minute visit ends by 14:00");
			await page.selectOption("#booking-time", "13:00");
			await page.getByRole("button", { name: "Continue" }).click();
			await page.waitForURL(/requested=1/);
			assert.match(
				(await page.locator("h1").textContent()) ?? "",
				/Sports massage is noted for Saturday/,
			);
		} finally {
			await browser.close();
		}
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});
