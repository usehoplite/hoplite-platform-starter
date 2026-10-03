import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import type { Database } from "../lib/store";
import type { Site } from "../lib/types";

// These tests exercise Site Studio's optional browser checks.
process.env.STUDIO_QA_CHECKS = "on";

test("automatic repair keeps the website reserved while its checkpoint is being written", async () => {
	const root = await fs.mkdtemp(join(tmpdir(), "studio-repair-handoff-"));
	process.env.STUDIO_DATA_DIR = root;
	const { database, deleteConversation } = await import("../lib/store");
	const {
		cancelQueuedChange,
		hoplite,
		sendMessage,
		seedFiles,
		tick,
		retryGeneration,
		startBuild,
	} = await import("../lib/service");
	const db = await database();
	const site: Site = {
		id: "site",
		appId: "app",
		name: "Site",
		phase: "idle",
		threadId: "thread",
		sourceId: "ready-source",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		messages: [],
		versions: [],
		previewRevision: 0,
		activeVersionId: "ready",
		publishedVersionId: "public",
	};
	db.sites = [site];
	Object.defineProperty(hoplite, "configured", { value: true });
	const source = (await seedFiles()).filter(
		(file) => file.path !== "public/site-kit.js",
	);
	const originalJson = hoplite.json;
	const operations: string[] = [];
	hoplite.json = async <T>(
		path: string,
		body?: Parameters<typeof originalJson>[1],
		operationId?: string,
	): Promise<T> => {
		if (path.endsWith("/messages") && body) {
			assert.ok(operationId);
			operations.push(operationId);
			return { run: { id: `run-${operationId}` } } as T;
		}
		if (path.includes("/runs/"))
			return {
				run: { status: "completed", resultSourceId: "candidate-source" },
			} as T;
		if (path.endsWith("/messages")) return { messages: [] } as T;
		if (path.endsWith("/files")) return { files: source } as T;
		if (path.endsWith("/workspace/activity")) return { ok: true } as T;
		throw new Error(`Unexpected call: ${path}`);
	};
	let enter!: () => void;
	const entered = new Promise<void>((resolve) => {
		enter = resolve;
	});
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let processing: Promise<void> | undefined;
	const originalWrite = fs.writeFile;
	let held = false;
	try {
		await sendMessage(site, "Make the website orange");
		const generationId = site.generationId;
		mock.method(
			fs,
			"writeFile",
			async (...args: Parameters<typeof originalWrite>) => {
				if (
					args[0] === join(root, "metadata.json.tmp") &&
					typeof args[1] === "string"
				) {
					const snapshot: Database = JSON.parse(args[1]);
					if (!held && snapshot.sites[0].generations?.[0].attempts[0].failure) {
						held = true;
						enter();
						await gate;
					}
				}
				return originalWrite(...args);
			},
		);
		syncBuiltinESMExports();
		processing = tick();
		await Promise.race([
			entered,
			processing.then(() => {
				throw new Error("Repair checkpoint was not reached");
			}),
		]);
		assert.equal(site.phase, "generating");
		assert.equal(site.generations?.[0].status, "admitting");
		assert.equal(site.generations?.[0].attempts.length, 2);
		assert.equal(
			operations.length,
			1,
			"Repair admission must wait for the durable checkpoint",
		);
		// An overlapping request waits its turn instead of being admitted. Its
		// save queues behind the held checkpoint, so it is not awaited here.
		const overlapping = sendMessage(site, "An overlapping request");
		assert.equal(site.queuedChange?.prompt, "An overlapping request");
		assert.equal(site.generationId, generationId);
		const withdrawn = cancelQueuedChange(site);
		await assert.rejects(retryGeneration(site), /no failed update/);
		await assert.rejects(startBuild(site, "ready"), /pending change/);
		assert.equal(
			await deleteConversation(site, site.conversationId ?? ""),
			"busy",
		);
		assert.equal(site.generationId, generationId);
		assert.equal(site.activeVersionId, "ready");
		assert.equal(site.publishedVersionId, "public");
		release();
		await processing;
		await Promise.all([overlapping, withdrawn]);
		assert.equal(site.queuedChange, undefined);
		assert.equal(operations.length, 2);
		assert.equal(new Set(operations).size, 2);
		const persisted: Database = JSON.parse(
			await fs.readFile(join(root, "metadata.json"), "utf8"),
		);
		assert.equal(persisted.sites[0].generations?.length, 1);
		assert.equal(persisted.sites[0].generationId, generationId);
		assert.equal(persisted.sites[0].generations?.[0].status, "running");
		assert.equal(persisted.sites[0].generations?.[0].attempts.length, 2);
		assert.equal(persisted.sites[0].activeVersionId, "ready");
		assert.equal(persisted.sites[0].publishedVersionId, "public");
	} finally {
		release();
		try {
			await processing;
		} finally {
			mock.restoreAll();
			syncBuiltinESMExports();
			hoplite.json = originalJson;
			await fs.rm(root, { recursive: true, force: true });
		}
	}
});
