import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { PublicFetcher, publicAddress } from "../lib/public-fetch";

test("website imports reject private ranges, pin DNS and recheck every redirect", async () => {
	for (const address of [
		"127.0.0.1",
		"10.0.0.1",
		"172.16.0.1",
		"192.168.0.1",
		"169.254.169.254",
		"100.64.0.1",
		"0.0.0.0",
		"255.255.255.255",
		"224.0.0.1",
		"::1",
		"::",
		"fe80::1",
		"fc00::1",
		"::ffff:127.0.0.1",
		"2001:db8::1",
	])
		assert.equal(publicAddress(address), false, address);
	assert.equal(publicAddress("1.1.1.1"), true);
	assert.equal(publicAddress("2606:4700:4700::1111"), true);
	let requests = 0;
	const server = createServer((req, res) => {
		requests++;
		assert.equal(req.headers.authorization, undefined);
		assert.equal(req.headers.cookie, undefined);
		if (req.url === "/private") {
			res.writeHead(302, {
				location: "http://169.254.169.254/latest/meta-data",
			});
			res.end();
		} else if (req.url === "/redirect") {
			res.writeHead(302, { location: "/page" });
			res.end();
		} else if (req.url === "/loop") {
			res.writeHead(302, { location: "/loop" });
			res.end();
		} else if (req.url === "/large") {
			res.writeHead(200);
			res.end(Buffer.alloc(7 * 1024 * 1024));
		} else {
			res.writeHead(200, {
				"content-type": "text/html",
				"content-encoding": "gzip",
			});
			res.end(gzipSync("<h1>Public website</h1>"));
		}
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	let lookups = 0;
	const fetcher = new PublicFetcher({
		resolve: async () => {
			lookups++;
			return [{ address: "1.1.1.1", family: 4 }];
		},
		request: (url, options, callback) => {
			assert.ok(options.lookup);
			options.lookup(url.hostname, {}, (error, pinned, family) => {
				assert.equal(error, null);
				assert.equal(pinned, "1.1.1.1");
				assert.equal(family, 4);
			});
			assert.equal(options.agent, false);
			return request(
				new URL(url.pathname, `http://127.0.0.1:${address.port}`),
				{ ...options, lookup: undefined },
				callback,
			);
		},
	});
	try {
		for (const url of [
			"file:///etc/passwd",
			"http://127.0.0.1/",
			"http://2130706433/",
			"http://[::ffff:127.0.0.1]/",
			"https://user:password@public.example/",
			"https://public.example:8080/",
		])
			await assert.rejects(fetcher.fetch(url));
		assert.equal(requests, 0);
		const page = await fetcher.fetch("https://public.example/redirect");
		assert.equal(page.url, "https://public.example/page");
		assert.equal(page.body.toString(), "<h1>Public website</h1>");
		assert.equal(lookups, 2);
		await assert.rejects(
			fetcher.fetch("https://public.example/private"),
			/private or reserved/,
		);
		assert.equal(
			requests,
			3,
			"The metadata service must never receive a request",
		);
		await assert.rejects(
			fetcher.fetch("https://public.example/loop"),
			/too many redirects/,
		);
		await assert.rejects(
			fetcher.fetch("https://public.example/large"),
			/download limit/,
		);
		await assert.rejects(
			new PublicFetcher({
				resolve: async () => [
					{ address: "1.1.1.1", family: 4 },
					{ address: "10.0.0.1", family: 4 },
				],
			}).fetch("https://mixed.example/"),
			/private or reserved/,
		);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});
