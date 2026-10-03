import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { test } from "node:test";
import sharp from "sharp";
import { scanBrand } from "../lib/brand-scan";
import { PublicFetcher } from "../lib/public-fetch";
import { sha256 } from "../lib/safety";

test("a brand scan saves computed style and copied images without running website scripts or reaching private hosts", {
	timeout: 45_000,
}, async () => {
	const image = await sharp({
		create: { width: 240, height: 160, channels: 3, background: "#f26228" },
	})
		.png()
		.toBuffer();
	const requests: string[] = [];
	const server = createServer((req, res) => {
		requests.push(req.url || "/");
		if (req.url === "/image.png") {
			res.writeHead(200, { "content-type": "image/png" });
			res.end(image);
			return;
		}
		res.writeHead(200, { "content-type": "text/html" });
		res.end(
			'<!doctype html><html lang="en"><head><title>Fixture brand</title><style>body{background:rgb(20,30,40);color:rgb(250,240,220);font-family:Georgia;font-size:18px}main{max-width:1100px;margin:auto}</style></head><body><main><section><h1>A warm welcome to the studio</h1><p>Thoughtful movement and time to feel like yourself, in a friendly space beside the sea.</p><img src="/image.png" alt="Studio photograph" width="240" height="160"></section></main><script>fetch("/side-effect")</script><iframe src="http://169.254.169.254/private"></iframe></body></html>',
		);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const fetcher = new PublicFetcher({
		resolve: async () => [{ address: "1.1.1.1", family: 4 }],
		request: (url, options, callback) => {
			assert.equal(url.hostname, "brand.example");
			return request(
				new URL(url.pathname, `http://127.0.0.1:${address.port}`),
				{ ...options, lookup: undefined },
				callback,
			);
		},
	});
	try {
		const result = await scanBrand("https://brand.example/", fetcher);
		assert.equal(result.brief.title, "Fixture brand");
		assert.ok(
			result.brief.palette.some((sample) => sample.color === "rgb(20, 30, 40)"),
		);
		assert.ok(
			result.brief.typography.some((sample) => sample.family === "Georgia"),
		);
		assert.equal(result.brief.layout.contentWidth, 1100);
		assert.equal(result.brief.assets.length, 1);
		const asset = result.brief.assets[0];
		const copied = result.files.find((file) => file.path === asset.path);
		assert.ok(copied);
		assert.equal(sha256(copied.body), asset.sha256);
		assert.equal((await sharp(copied.body).metadata()).format, "png");
		assert.ok(
			result.files.find((file) => file.path === "reference.png")?.body.length,
		);
		assert.ok(result.files.find((file) => file.path === "visual-brief.json"));
		assert.equal(requests.includes("/side-effect"), false);
		assert.equal(requests.includes("/private"), false);
		assert.ok(result.brief.warnings.length);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});
