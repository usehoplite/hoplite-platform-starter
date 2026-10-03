import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Site } from "../lib/types";

// These tests exercise Site Studio's optional browser checks.
process.env.STUDIO_QA_CHECKS = "on";

test("editor activity retries its durable identity without failing generation or renewing on background reads", async () => {
	const root = await mkdtemp(join(tmpdir(), "studio-workspace-"));
	let failActivity = true;
	let holdActivity = false;
	let entered!: () => void;
	let release!: () => void;
	let gate = Promise.resolve();
	const operations: string[] = [];
	let previewStarts = 0;
	const server = createServer(async (req, res) => {
		assert.equal(req.headers.authorization, "Bearer test-workspace-key");
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(Buffer.from(chunk));
		const input = JSON.parse(Buffer.concat(chunks).toString() || "null");
		const path = new URL(req.url || "/", "http://fixture").pathname;
		res.setHeader("content-type", "application/json");
		if (path.endsWith("/workspace/activity")) {
			assert.equal(req.method, "POST");
			// The app's idleTimeoutMinutes (20) applies to activity renewals.
			assert.deepEqual(input, {});
			const operation = req.headers["idempotency-key"];
			assert.equal(typeof operation, "string");
			operations.push(String(operation));
			const shouldFail = failActivity;
			if (holdActivity) {
				entered();
				await gate;
			}
			if (shouldFail) {
				res.writeHead(503);
				res.end(JSON.stringify({ error: "source_workspace_unavailable" }));
			} else res.end(JSON.stringify({ ok: true }));
			return;
		}
		if (path.endsWith("/workspace/policy")) {
			assert.equal(req.method, "GET");
			res.end(JSON.stringify({ policy: { workspaceStatus: "archived" } }));
			return;
		}
		if (path.endsWith("/preview/start")) previewStarts++;
		if (path.endsWith("/preview") || path.endsWith("/preview/start")) {
			res.end(JSON.stringify({ preview: { status: "stopped" } }));
			return;
		}
		if (path.endsWith("/messages")) {
			res.end(
				JSON.stringify(
					req.method === "POST" ? { runId: "run" } : { messages: [] },
				),
			);
			return;
		}
		if (path.endsWith("/runs/run")) {
			res.end(JSON.stringify({ run: { status: "running" } }));
			return;
		}
		res.writeHead(404);
		res.end(JSON.stringify({ error: `Unexpected fixture path ${path}` }));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	process.env.STUDIO_DATA_DIR = root;
	process.env.HOPLITE_API_URL = `http://127.0.0.1:${address.port}`;
	process.env.HOPLITE_SERVICE_KEY = "test-workspace-key";
	const { database } = await import("../lib/store");
	const {
		sendMessage,
		tick,
		recordWorkspaceActivity,
		workspacePolicy,
		previewGrant,
		settleAdmissions,
	} = await import("../lib/service");
	const db = await database();
	const site: Site = {
		id: "site",
		appId: "app",
		name: "Site",
		createdAt: "2026-09-25",
		updatedAt: "2026-09-25",
		threadId: "thread",
		sourceId: "source",
		phase: "idle",
		messages: [],
		versions: [],
		activeVersionId: "ready",
		publishedVersionId: "published",
		previewRevision: 0,
	};
	db.sites.push(site);
	try {
		await sendMessage(site, "Change the heading");
		const pending = site.workspaceActivity?.id;
		assert.ok(pending);
		assert.equal(site.runId, "run");
		await assert.rejects(tick(), /source_workspace_unavailable/);
		assert.equal(site.phase, "generating");
		assert.equal(site.generations?.[0].status, "running");
		assert.equal(site.generations?.[0].attempts.length, 1);
		assert.equal(site.publishedVersionId, "published");
		assert.equal(site.activeVersionId, "ready");
		assert.ok(site.workspaceError);
		const checkpoint = JSON.parse(
			await readFile(join(root, "metadata.json"), "utf8"),
		);
		assert.equal(checkpoint.sites[0].workspaceActivity.id, pending);
		assert.equal(checkpoint.sites[0].runId, "run");
		failActivity = false;
		assert.ok(site.workspaceActivity);
		site.workspaceActivity.lastAttemptAt = 0;
		await tick();
		assert.deepEqual(operations, [pending, pending]);
		assert.equal(site.workspaceActivity, undefined);
		assert.equal(site.workspaceError, undefined);
		await tick();
		await previewGrant(site);
		assert.equal((await workspacePolicy(site))?.workspaceStatus, "archived");
		assert.equal(
			operations.length,
			2,
			"Polling and preview inspection cannot renew expiry",
		);
		assert.equal(
			previewStarts,
			0,
			"Inspection cannot revive an archived workspace",
		);
		await recordWorkspaceActivity(site);
		assert.notEqual(
			operations[2],
			pending,
			"New editor activity needs a fresh operation identity",
		);
		holdActivity = true;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const first = recordWorkspaceActivity(site);
		await started;
		const second = recordWorkspaceActivity(site);
		holdActivity = false;
		release();
		await Promise.all([first, second]);
		assert.equal(
			operations.length,
			5,
			"Concurrent activity must not drop the newer update",
		);
		assert.notEqual(operations[3], operations[4]);
		assert.equal(site.workspaceActivity, undefined);
		for (const failNewer of [false, true]) {
			const before: number = operations.length;
			failActivity = true;
			holdActivity = true;
			const failedStarted = new Promise<void>((resolve) => {
				entered = resolve;
			});
			gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const older = recordWorkspaceActivity(site);
			await failedStarted;
			failActivity = failNewer;
			const newer = recordWorkspaceActivity(site);
			const results = Promise.allSettled([older, newer]);
			holdActivity = false;
			release();
			assert.deepEqual(
				(await results).map((result) => result.status),
				["rejected", failNewer ? "rejected" : "fulfilled"],
			);
			assert.equal(operations.length, before + 2);
			assert.notEqual(operations[before], operations[before + 1]);
			const saved = JSON.parse(
				await readFile(join(root, "metadata.json"), "utf8"),
			);
			if (failNewer) {
				assert.equal(db.sites[0].workspaceActivity?.id, operations.at(-1));
				assert.ok(site.workspaceError);
				assert.equal(saved.sites[0].workspaceActivity.id, operations.at(-1));
				assert.equal(saved.sites[0].workspaceError, site.workspaceError);
			} else {
				assert.equal(site.workspaceActivity, undefined);
				assert.equal(site.workspaceError, undefined);
				assert.equal(saved.sites[0].workspaceActivity, undefined);
			}
		}
		await settleAdmissions();
		await recordWorkspaceActivity(site);
		await tick();
		assert.equal(operations.length, 9, "Shutdown must stop accepting activity");
	} finally {
		release?.();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(root, { recursive: true, force: true });
	}
});
