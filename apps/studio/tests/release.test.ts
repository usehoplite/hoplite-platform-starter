import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Hoplite } from "../lib/hoplite";
import { artifactRoutes } from "../lib/qa";
import { safeArtifactPath, sourceGates } from "../lib/safety";
import type { JsonValue, Site, Version } from "../lib/types";

// These tests exercise Site Studio's optional browser checks.
process.env.STUDIO_QA_CHECKS = "on";

test("retries failed builds while keeping preview QA tied to the current completed edit", async () => {
	const root = await mkdtemp(join(tmpdir(), "studio-build-retry-"));
	process.env.STUDIO_DATA_DIR = root;
	const { database } = await import("../lib/store");
	const { hoplite, startBuild, publish, sendMessage } = await import(
		"../lib/service"
	);
	const db = await database();
	const old = {
		id: "old",
		sourceId: "old-source",
		label: "Old",
		createdAt: "2026-09-23",
		artifactDirectory: "retained",
		qa: { status: "passed" as const, checks: [], errors: [], screenshots: [] },
	};
	const latest: Version = {
		id: "latest",
		sourceId: "new-source",
		generationId: "generation",
		sourceChecked: true,
		label: "Latest",
		createdAt: "2026-09-24",
		buildId: "failed-build",
	};
	const site: Site = {
		id: "site",
		appId: "app",
		name: "Test",
		createdAt: "2026-09-23",
		updatedAt: "2026-09-24",
		threadId: "thread",
		runId: "run",
		phase: "failed",
		messages: [],
		versions: [old, latest],
		previewRevision: 0,
		generationId: "generation",
		generations: [
			{
				id: "generation",
				prompt: "Change the page",
				status: "failed",
				createdAt: "2026-09-24",
				attempts: [{ id: "attempt", versionId: "latest" }],
			},
		],
	};
	db.sites.push(site);
	const original = hoplite.json;
	const operations: string[] = [];
	let runStatus = "completed";
	let uncertain = true;
	let previewStarts = 0;
	hoplite.json = async <T>(
		path: string,
		_body?: JsonValue,
		operation?: string,
	): Promise<T> => {
		if (path.endsWith("/runs/run"))
			return { run: { status: runStatus, resultSourceId: "new-source" } } as T;
		if (path.endsWith("/preview/start")) {
			previewStarts++;
			return { preview: { status: "starting" } } as T;
		}
		if (path.endsWith("/builds/failed-build"))
			return { build: { status: "failed" } } as T;
		assert.ok(path.endsWith("/threads/thread/builds"));
		assert.ok(operation);
		operations.push(operation);
		if (uncertain) throw new Error("connection interrupted");
		return { build: { id: "retry-build" } } as T;
	};
	try {
		await startBuild(site, "old");
		assert.equal(
			old.qa.status,
			"passed",
			"a ready release is immutable and does not get rechecked against newer source",
		);
		site.versions.splice(1, 0, {
			...old,
			id: "unchecked-old",
			artifactDirectory: undefined,
			qa: undefined,
		});
		await assert.rejects(
			startBuild(site, "unchecked-old"),
			/latest saved version/,
		);
		await publish(site, "old");
		assert.equal(site.publishedVersionId, "old");
		latest.failure = {
			category: "repairable",
			stage: "source",
			errors: ["Site Kit changed"],
		};
		await assert.rejects(
			startBuild(site, "latest"),
			/can't be finished as it is/,
		);
		assert.equal(
			operations.length,
			0,
			"source rejection cannot be bypassed with a manual build",
		);
		latest.failure = undefined;
		await assert.rejects(startBuild(site, "latest"), /connection interrupted/);
		assert.equal(site.generations?.[0].status, "failed");
		assert.ok(site.generations?.[0].finishedAt);
		assert.equal(
			JSON.parse(
				await (await import("node:fs/promises")).readFile(
					join(root, "metadata.json"),
					"utf8",
				),
			).sites[0].generations[0].status,
			"failed",
		);
		uncertain = false;
		await startBuild(site, "latest");
		assert.equal(operations.length, 2);
		assert.equal(previewStarts, 2);
		assert.equal(operations[0], operations[1]);
		assert.notEqual(operations[0], "build-latest");
		assert.equal(latest.buildId, "retry-build");
		assert.equal(site.phase, "building");
		site.phase = "failed";
		runStatus = "failed";
		await assert.rejects(startBuild(site, "latest"), /Finish a new edit/);
		assert.equal(old.qa.status, "passed");
		site.activeVersionId = old.id;
		Object.defineProperty(hoplite, "configured", { value: true });
		hoplite.json = async <T>(path: string, body?: JsonValue): Promise<T> => {
			assert.ok(
				path.endsWith("/threads"),
				"retry creates a fresh thread instead of messaging the failed one",
			);
			assert.equal((body as { sourceId: string }).sourceId, old.sourceId);
			return { thread: { id: "fresh-thread" }, run: { id: "fresh-run" } } as T;
		};
		await sendMessage(site, "Try a different headline");
		assert.equal(site.threadId, "fresh-thread");
		assert.equal(site.generations?.length, 2);
	} finally {
		hoplite.json = original;
		await rm(root, { recursive: true, force: true });
	}
});

const trusted = [
	{ path: "package.json", content: '{"dependencies":{"astro":"5.13.5"}}' },
	{ path: "astro.config.mjs", content: "static config" },
	{ path: "public/site-kit.js", content: "owned integration" },
];
test("rejects an agent replacing booking behavior or adding a server route", () => {
	assert.deepEqual(sourceGates(trusted, trusted), []);
	assert.match(
		sourceGates(
			trusted.map((f) =>
				f.path === "public/site-kit.js"
					? { ...f, content: "malicious replacement" }
					: f,
			),
			trusted,
		).join(" "),
		/owned/,
	);
	assert.match(
		sourceGates(
			[
				...trusted,
				{
					path: "src/pages/api/book.ts",
					content: "export const POST = () => {}",
				},
			],
			trusted,
		).join(" "),
		/Unsupported file/,
	);
});
test("rejects generated pages that remove Site Kit or expose server credentials", () => {
	assert.match(
		sourceGates(
			[
				...trusted,
				{
					path: "src/pages/index.astro",
					content: "<h1>Missing integration</h1>",
				},
			],
			trusted,
		).join(" "),
		/Missing Site Kit/,
	);
	assert.match(
		sourceGates(
			[
				...trusted,
				{
					path: "src/pages/index.astro",
					content: '<script src="/site-kit.js"></script>process.env.SECRET',
				},
			],
			trusted,
		).join(" "),
		/Server code/,
	);
});
test("never serves traversal paths or source maps from build archives", () => {
	for (const path of [
		"../secret",
		"/root",
		"assets/../../secret",
		"a\\b",
		"assets/site.js.map",
		"a//b",
	])
		assert.equal(safeArtifactPath(path), false, path);
	assert.equal(safeArtifactPath("assets/app.css"), true);
});
test("credentials stay in the backend and remote API connections require HTTPS", async () => {
	assert.throws(() => new Hoplite("http://remote.example", "key"), /HTTPS/);
	const client = new Hoplite("", "");
	await assert.rejects(client.response("/api/projects"), /not configured/);
});

test("immutable evidence survives orphaned writes and rejects conflicting retries", async () => {
	const { immutableFile } = await import("../lib/service");
	const { readFile, writeFile } = await import("node:fs/promises");
	const root = await mkdtemp(join(tmpdir(), "studio-evidence-"));
	try {
		const path = join(root, "source.json");
		await writeFile(`${path}.interrupted.tmp`, '{"partial":');
		const content = JSON.stringify({ source: "complete" });
		await Promise.all([
			immutableFile(path, content),
			immutableFile(path, content),
		]);
		assert.equal(await readFile(path, "utf8"), content);
		await assert.rejects(
			immutableFile(path, "different source"),
			/differs from the immutable/,
		);
		assert.equal(await readFile(path, "utf8"), content);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("build manifests discover nested and unlinked HTML pages without inventing asset routes", () => {
	assert.deepEqual(
		artifactRoutes(
			[
				"index.html",
				"services/index.html",
				"new page/index.html",
				"about.html",
				"myindex.html",
				"site.js",
			].map((path) => ({ path })),
		),
		["/", "/about.html", "/myindex.html", "/new%20page/", "/services/"],
	);
	assert.throws(() => artifactRoutes([{ path: "site.js" }]), /no home page/);
	assert.throws(
		() => artifactRoutes([{ path: "index.html" }, { path: "../escape.html" }]),
		/Unsafe page/,
	);
});
