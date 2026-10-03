import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// These tests exercise Site Studio's optional browser checks.
process.env.STUDIO_QA_CHECKS = "on";

test("a follow-up admission cannot complete from the previous run while its HTTP response is pending", async () => {
	const root = await mkdtemp(join(tmpdir(), "studio-admission-"));
	process.env.STUDIO_DATA_DIR = root;
	const { database } = await import("../lib/store");
	const { hoplite, sendMessage, tick, createSite } = await import(
		"../lib/service"
	);
	const db = await database();
	assert.equal(
		db.sites.length,
		0,
		"a fresh studio must not invent a sample site",
	);
	await assert.rejects(createSite("x".repeat(12001)), /12,000 characters/);
	assert.equal(
		db.sites.length,
		0,
		"invalid creation must not leave a phantom site",
	);
	const site = {
		id: "test_site",
		appId: "app_test",
		name: "Test site",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		phase: "idle" as const,
		messages: [],
		versions: [],
		previewRevision: 0,
		threadId: "thread_test",
		runId: "previous_completed_run" as string | undefined,
		activity: { runId: "previous_completed_run", text: "Old task" } as
			| { runId: string; text: string }
			| undefined,
	};
	db.sites.push(site);
	site.threadId = "thread_test";
	site.runId = "previous_completed_run";
	Object.defineProperty(hoplite, "configured", { value: true });
	let admit: (result: { run: { id: string } }) => void = () => {
		throw new Error("Promise resolver was not initialized");
	};
	let dispatched: () => void = () => {
		throw new Error("Promise resolver was not initialized");
	};
	const started = new Promise<void>((resolve) => {
		dispatched = resolve;
	});
	const response = new Promise<{ run: { id: string } }>((resolve) => {
		admit = resolve;
	});
	const original = hoplite.json.bind(hoplite);
	hoplite.json = async <T>(path: string): Promise<T> => {
		assert.match(
			path,
			/\/messages$/,
			"the poller must not read the previous run during admission",
		);
		dispatched();
		return response as Promise<T>;
	};
	try {
		const pending = sendMessage(site, "Change the button");
		await started;
		assert.equal(site.runId, undefined);
		assert.equal(site.activity, undefined);
		await tick();
		assert.equal(site.phase, "generating");
		assert.equal(site.versions.length, 0);
		admit({ run: { id: "new_run" } });
		await pending;
		assert.equal(site.runId, "new_run");
		assert.equal(site.phase, "generating");
		assert.equal(site.messages.length, 1);
	} finally {
		hoplite.json = original;
		await rm(root, { recursive: true, force: true });
	}
});
