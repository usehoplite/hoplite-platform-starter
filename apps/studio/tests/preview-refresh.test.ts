import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Site } from "../lib/types";

// These tests exercise Site Studio's optional browser checks.
process.env.STUDIO_QA_CHECKS = "on";

test("completion refreshes the iframe after the new preview grant is ready, once per run", async () => {
	const root = await mkdtemp(join(tmpdir(), "studio-preview-refresh-"));
	process.env.STUDIO_DATA_DIR = root;
	const { database } = await import("../lib/store");
	const { hoplite, tick, grants, seedFiles, startBuild } = await import(
		"../lib/service"
	);
	const original = hoplite.json;
	const db = await database();
	const site: Site = {
		id: "site",
		appId: "app",
		name: "Test",
		createdAt: "2026-09-23",
		updatedAt: "2026-09-23",
		threadId: "thread",
		runId: "run",
		phase: "generating",
		messages: [],
		versions: [],
		previewRevision: 4,
	};
	db.sites.push(site);
	grants.set(site.id, {
		url: "https://old.example",
		token: "old",
		header: "x-preview",
		expiresAt: Date.now() + 60000,
	});
	let begin: () => void = () => {
		throw new Error("Promise resolver was not initialized");
	};
	let finish: () => void = () => {
		throw new Error("Promise resolver was not initialized");
	};
	const starting = new Promise<void>((resolve) => {
		begin = resolve;
	});
	const ready = new Promise<void>((resolve) => {
		finish = resolve;
	});
	let calls = 0;
	hoplite.json = async <T>(path: string): Promise<T> => {
		calls++;
		if (path.endsWith("/runs/run"))
			return { run: { status: "completed", resultSourceId: "source" } } as T;
		if (path.endsWith("/messages")) return { messages: [] } as T;
		if (path.endsWith("/sources/source/files"))
			return { files: await seedFiles() } as T;
		if (path.endsWith("/threads/thread/builds"))
			return { build: { id: "build" } } as T;
		if (path.endsWith("/builds/build"))
			return { build: { status: "building" } } as T;
		assert.ok(path.endsWith("/preview/start"));
		begin();
		await ready;
		return {
			preview: {
				url: "https://new.example",
				gateway: {
					token: "new",
					header: "x-preview",
					expiresAt: new Date(Date.now() + 60000).toISOString(),
				},
			},
		} as T;
	};
	try {
		const pending = tick();
		await starting;
		assert.equal(
			site.previewRevision,
			4,
			"do not reload through the previous grant",
		);
		assert.equal(
			site.versions.length,
			1,
			"save completed source before preview startup",
		);
		finish();
		await pending;
		assert.equal(site.previewRevision, 5);
		assert.equal(grants.get(site.id)?.url, "https://new.example");
		assert.equal(site.phase, "building");
		assert.equal(
			site.activeVersionId,
			undefined,
			"unchecked source must not become the ready draft",
		);
		const persisted = JSON.parse(
			await readFile(join(root, "metadata.json"), "utf8"),
		);
		assert.equal(persisted.sites[0].previewRevision, 5);
		const completedCalls = calls;
		await tick();
		assert.equal(site.previewRevision, 5);
		assert.equal(
			calls,
			completedCalls + 1,
			"later polling checks only the build; it must not replay the completed run",
		);

		// An older saved candidate must get a new bounded preview-start window
		// when the customer retries checks after the workspace has gone idle.
		const version = site.versions[0];
		version.createdAt = "2026-09-23";
		version.artifactDirectory = join(root, "saved-dist");
		version.previewWaitStartedAt = "2026-09-23";
		site.phase = "failed";
		let previewStarts = 0;
		hoplite.json = async <T>(path: string): Promise<T> => {
			if (path.endsWith("/runs/run"))
				return { run: { status: "completed", resultSourceId: "source" } } as T;
			if (path.endsWith("/builds/build"))
				return { build: { status: "ready" } } as T;
			if (path.endsWith("/preview/start")) {
				previewStarts++;
				return { preview: { status: "starting" } } as T;
			}
			assert.ok(path.includes("/preview?"));
			return { preview: { status: "starting" } } as T;
		};
		await startBuild(site, version.id);
		assert.equal(previewStarts, 1);
		assert.equal(version.previewWaitStartedAt, undefined);
		await tick();
		assert.equal(site.phase, "checking");
		assert.ok(version.previewWaitStartedAt);
		assert.ok(Date.now() - Date.parse(version.previewWaitStartedAt) < 5_000);
		const waiting = JSON.parse(
			await readFile(join(root, "metadata.json"), "utf8"),
		);
		assert.equal(
			waiting.sites[0].versions[0].previewWaitStartedAt,
			version.previewWaitStartedAt,
		);
		version.previewWaitStartedAt = new Date(Date.now() - 301_000).toISOString();
		await tick();
		assert.equal(site.phase, "failed");
		assert.match(
			version.failure?.errors.join(" ") || "",
			/within five minutes/,
		);
		await startBuild(site, version.id);
		await tick();
		assert.equal(previewStarts, 2);
		assert.equal(site.phase, "checking");
		assert.equal(site.versions.length, 1);
		assert.equal(site.runId, "run");
		assert.equal(version.buildId, "build");
	} finally {
		finish();
		hoplite.json = original;
		await rm(root, { recursive: true, force: true });
	}
});
