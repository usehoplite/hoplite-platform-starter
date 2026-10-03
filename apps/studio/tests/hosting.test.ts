import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	clientAddress,
	endpointFor,
	needsHttps,
	readHosting,
} from "../lib/hosting";
import { previewPolicy, siteResourcePolicy } from "../lib/safety";

const hostedEnv = {
	STUDIO_LISTEN_HOST: "0.0.0.0",
	STUDIO_LISTEN_PORT: "8080",
	STUDIO_ORIGIN: "https://studio.example.com",
	STUDIO_PREVIEW_ORIGIN: "https://preview.studio.example.com",
	STUDIO_SITES_ORIGIN: "https://sites.studio.example.com",
	STUDIO_TRUST_PROXY: "fly",
};

test("without configuration the three local loopback ports are unchanged", () => {
	const hosting = readHosting({});
	assert.equal(hosting.studioOrigin, "http://127.0.0.1:4320");
	assert.equal(hosting.previewOrigin, "http://127.0.0.1:4321");
	assert.equal(hosting.sitesOrigin, "http://127.0.0.1:4322");
	assert.equal(hosting.checkOrigin, "http://127.0.0.1:4321");
	assert.equal(hosting.frameOrigin, "https://studio.example.invalid");
	assert.equal(hosting.trustProxy, false);
	assert.deepEqual(
		hosting.listeners.map(({ host, port, endpoints }) => ({
			host,
			port,
			roles: endpoints.map((endpoint) => endpoint.role),
		})),
		[
			{ host: "127.0.0.1", port: 4320, roles: ["studio"] },
			{ host: "127.0.0.1", port: 4321, roles: ["preview"] },
			{ host: "127.0.0.1", port: 4322, roles: ["sites"] },
		],
	);
	const [studio, preview, sites] = hosting.listeners;
	assert.equal(endpointFor(studio, "127.0.0.1:4320")?.role, "studio");
	assert.equal(endpointFor(preview, "127.0.0.1:4321")?.role, "preview");
	assert.equal(endpointFor(sites, "127.0.0.1:4322")?.role, "sites");
	// Each local port still refuses the other roles' hosts.
	assert.equal(endpointFor(studio, "127.0.0.1:4321"), undefined);
	assert.equal(endpointFor(studio, "localhost:4320"), undefined);
	assert.equal(endpointFor(studio, undefined), undefined);
	assert.equal(
		previewPolicy(hosting.previewOrigin, hosting.studioOrigin),
		`${siteResourcePolicy}; connect-src 'self' ws://127.0.0.1:4321; frame-ancestors http://127.0.0.1:4320`,
	);
});

test("hosted origins share one proxy port and route by Host header", () => {
	const hosting = readHosting(hostedEnv);
	assert.equal(hosting.studioOrigin, "https://studio.example.com");
	assert.equal(hosting.frameOrigin, "https://studio.example.com");
	assert.equal(hosting.trustProxy, true);
	const [publicListener, checks] = hosting.listeners;
	assert.equal(hosting.listeners.length, 2);
	assert.deepEqual(
		{ host: publicListener.host, port: publicListener.port },
		{ host: "0.0.0.0", port: 8080 },
	);
	assert.equal(
		endpointFor(publicListener, "studio.example.com")?.role,
		"studio",
	);
	assert.equal(
		endpointFor(publicListener, "PREVIEW.studio.example.com:443")?.role,
		"preview",
	);
	assert.equal(
		endpointFor(publicListener, "sites.studio.example.com")?.role,
		"sites",
	);
	for (const host of [
		"studio-demo.fly.dev",
		"127.0.0.1:8080",
		"127.0.0.1:4321",
		"evil.example",
		"studio.example.com:8443",
	])
		assert.equal(endpointFor(publicListener, host), undefined, host);
	// Browser checks reach the gateway on a loopback-only listener.
	assert.equal(hosting.checkOrigin, "http://127.0.0.1:4321");
	assert.deepEqual(
		{ host: checks.host, port: checks.port },
		{ host: "127.0.0.1", port: 4321 },
	);
	assert.equal(endpointFor(checks, "127.0.0.1:4321")?.role, "preview");
	assert.equal(endpointFor(checks, "preview.studio.example.com"), undefined);
	assert.equal(
		previewPolicy(hosting.previewOrigin, hosting.studioOrigin),
		`${siteResourcePolicy}; connect-src 'self' wss://preview.studio.example.com; frame-ancestors https://studio.example.com`,
	);
	assert.match(
		previewPolicy(hosting.checkOrigin, hosting.studioOrigin),
		/connect-src 'self' ws:\/\/127\.0\.0\.1:4321; frame-ancestors https:\/\/studio\.example\.com$/,
	);
});

test("hosted roles may also listen on separate internal ports", () => {
	const hosting = readHosting({
		...hostedEnv,
		STUDIO_LISTEN_PORT: "",
		STUDIO_PORT: "8080",
		STUDIO_PREVIEW_PORT: "8081",
		STUDIO_SITES_PORT: "8082",
	});
	assert.deepEqual(
		hosting.listeners.map((listener) => [
			listener.port,
			listener.endpoints.map((endpoint) => endpoint.host),
		]),
		[
			[8080, ["studio.example.com"]],
			[8081, ["preview.studio.example.com"]],
			[8082, ["sites.studio.example.com"]],
			[4321, ["127.0.0.1:4321"]],
		],
	);
});

test("invalid hosting configuration fails at startup", () => {
	for (const [env, message] of [
		[{ STUDIO_LISTEN_PORT: "8080" }, /distinct hosts/],
		[{ STUDIO_ORIGIN: "https://a.example/studio" }, /origin/],
		[{ STUDIO_PREVIEW_ORIGIN: "ftp://a.example" }, /origin/],
		[{ STUDIO_SITES_ORIGIN: "not a url" }, /origin/],
		[{ STUDIO_PORT: "70000" }, /TCP port/],
		[{ STUDIO_TRUST_PROXY: "yes" }, /STUDIO_TRUST_PROXY/],
		[{ ...hostedEnv, STUDIO_LISTEN_PORT: "4321" }, /STUDIO_CHECK_PORT/],
	] as const)
		assert.throws(() => readHosting(env), message, JSON.stringify(env));
});

test("proxy headers are honoured only when the Fly proxy is trusted", () => {
	const trusted = readHosting(hostedEnv);
	const untrusted = readHosting({ ...hostedEnv, STUDIO_TRUST_PROXY: "" });
	const [listener] = trusted.listeners;
	const studio = endpointFor(listener, "studio.example.com");
	assert.ok(studio);
	const headers = {
		"fly-client-ip": "203.0.113.9",
		"x-forwarded-proto": "http",
	};
	assert.equal(clientAddress(trusted, headers, "172.16.0.2"), "203.0.113.9");
	assert.equal(clientAddress(untrusted, headers, "172.16.0.2"), "172.16.0.2");
	assert.equal(needsHttps(trusted, studio, headers), true);
	assert.equal(
		needsHttps(trusted, studio, { "x-forwarded-proto": "https" }),
		false,
	);
	assert.equal(needsHttps(untrusted, studio, headers), false);
	const local = readHosting({ STUDIO_TRUST_PROXY: "fly" });
	assert.equal(
		needsHttps(local, local.listeners[0].endpoints[0], headers),
		false,
		"plain HTTP origins are never redirected",
	);
});

test("metadata and local release files live under STUDIO_DATA_DIR", async () => {
	const root = await mkdtemp(join(tmpdir(), "studio-data-dir-"));
	try {
		process.env.STUDIO_DATA_DIR = root;
		const store = await import("../lib/store");
		assert.equal(store.dataRoot, root);
		const db = await store.database();
		db.business = { ...db.business, name: "Volume Test" };
		await store.save();
		const saved = JSON.parse(
			await readFile(join(root, "metadata.json"), "utf8"),
		);
		assert.equal(saved.business.name, "Volume Test");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
