import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { chromium } from "playwright";
import { siteResourcePolicy } from "../lib/safety";

test("the browser resource policy blocks external images, scripts and dynamic requests while Site Kit-style requests work", {
	timeout: 30_000,
}, async () => {
	let externalRequests = 0;
	const external = createServer((_req, res) => {
		externalRequests++;
		res.end("unexpected");
	});
	await new Promise<void>((resolve) =>
		external.listen(0, "127.0.0.1", resolve),
	);
	const address = external.address();
	assert.ok(address && typeof address !== "string");
	const outside = `http://127.0.0.1:${address.port}`;
	const server = createServer((req, res) => {
		if (req.url === "/data") {
			res.setHeader("content-type", "application/json");
			res.end('{"ok":true}');
			return;
		}
		if (req.url === "/owned.js") {
			res.setHeader("content-type", "application/javascript");
			res.end(
				"fetch('/data').then(r=>r.json()).then(v=>document.body.dataset.ready=String(v.ok))",
			);
			return;
		}
		res.setHeader("content-security-policy", siteResourcePolicy);
		res.setHeader("content-type", "text/html");
		res.end(
			`<!doctype html><html lang="en"><head><title>Policy</title></head><body><h1>Local website</h1><img alt="Blocked test image" src="${outside}/image"><script src="${outside}/script"></script><script src="/owned.js"></script><script>fetch('${outside}/dynamic').catch(()=>{});const img=new Image();img.src='${outside}/created';</script></body></html>`,
		);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const local = server.address();
	assert.ok(local && typeof local !== "string");
	const browser = await chromium.launch({ channel: "chrome", headless: true });
	try {
		const page = await browser.newPage();
		const blocked: string[] = [];
		page.on("console", (message) => {
			if (message.type() === "error") blocked.push(message.text());
		});
		await page.goto(`http://127.0.0.1:${local.port}/`);
		await page.locator('body[data-ready="true"]').waitFor();
		assert.equal(externalRequests, 0);
		assert.ok(
			blocked.filter((message) => message.includes("Content Security Policy"))
				.length >= 3,
		);
	} finally {
		await browser.close();
		server.closeAllConnections();
		external.closeAllConnections();
		await Promise.all([
			new Promise<void>((resolve) => server.close(() => resolve())),
			new Promise<void>((resolve) => external.close(() => resolve())),
		]);
	}
});
