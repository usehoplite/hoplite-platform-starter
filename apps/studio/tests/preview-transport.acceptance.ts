import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { chromium } from "playwright";
import { PreviewUnavailableError, visitPreview } from "../lib/qa";

test("navigation stalls are infrastructure failures while generated HTTP errors remain repairable", async () => {
	const server = createServer((req, res) => {
		if (req.url === "/stall") return;
		res.writeHead(req.url === "/broken" ? 500 : 503, {
			"content-type": "text/html",
			...(req.url === "/waiting"
				? { "x-studio-preview-state": "starting" }
				: {}),
		});
		res.end("<h1>Unavailable</h1>");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const origin = `http://127.0.0.1:${address.port}`;
	const browser = await chromium.launch({ channel: "chrome", headless: true });
	try {
		const page = await browser.newPage();
		page.setDefaultNavigationTimeout(2000);
		await assert.rejects(
			visitPreview(page, `${origin}/stall`),
			PreviewUnavailableError,
		);
		await assert.rejects(
			visitPreview(page, `${origin}/waiting`),
			PreviewUnavailableError,
		);
		assert.equal((await visitPreview(page, `${origin}/broken`))?.status(), 500);
		assert.equal(
			(await visitPreview(page, `${origin}/generated-503`))?.status(),
			503,
		);
	} finally {
		await browser.close();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});
