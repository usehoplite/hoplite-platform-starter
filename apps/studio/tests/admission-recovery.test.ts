import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Hoplite, HopliteError } from "../lib/hoplite";
import type { Site } from "../lib/types";

// These tests exercise Site Studio's optional browser checks.
process.env.STUDIO_QA_CHECKS = "on";

test("admissions create one app per site, retain pending identities and drain before shutdown", async () => {
	const root = await mkdtemp(join(tmpdir(), "studio-admission-recovery-"));
	process.env.STUDIO_DATA_DIR = root;
	const { database } = await import("../lib/store");
	const { cancelQueuedChange, hoplite, sendMessage, tick, settleAdmissions } =
		await import("../lib/service");
	const db = await database();
	const sites: Site[] = ["first", "second"].map((id) => ({
		id,
		name: id,
		phase: "idle",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		messages: [],
		versions: [],
		sourceId: "saved-source",
		previewRevision: 0,
	}));
	db.sites = sites;
	Object.defineProperty(hoplite, "configured", { value: true });
	const original = hoplite.json;
	let releaseProject!: () => void;
	const projectGate = new Promise<void>((resolve) => {
		releaseProject = resolve;
	});
	let projectStarted!: () => void;
	const projectEntered = new Promise<void>((resolve) => {
		projectStarted = resolve;
	});
	let projects = 0;
	let pending = true;
	let queuedRunAssigned = false;
	let queuedSubmissions = 0;
	let queuedReads = 0;
	let interruptedRead: "run" | "messages" | undefined;
	let interruption = "disconnect";
	let transport: Hoplite;
	let drainStarted!: () => void;
	const drainEntered = new Promise<void>((resolve) => {
		drainStarted = resolve;
	});
	let releaseAdmission!: () => void;
	const admissionGate = new Promise<void>((resolve) => {
		releaseAdmission = resolve;
	});
	const operations: string[] = [];
	const prompts: string[] = [];
	hoplite.json = async <T>(
		path: string,
		body?: Parameters<Hoplite["json"]>[1],
		operationId?: string,
	): Promise<T> => {
		if (path === "/api/platform/v1/apps") {
			assert.ok(body && typeof body === "object" && !Array.isArray(body));
			assert.equal(operationId, `studio-app-${body.externalId}`);
			projects++;
			projectStarted();
			await projectGate;
			return { app: { id: `app-${body.externalId}` } } as T;
		}
		if (path.endsWith("/threads")) {
			assert.ok(body && typeof body === "object" && !Array.isArray(body));
			if (body.title === "first") {
				assert.ok(operationId);
				operations.push(operationId);
				assert.equal(typeof body.prompt, "string");
				prompts.push(String(body.prompt));
				if (pending) throw new HopliteError(409, "operation_outcome_pending");
			}
			return {
				thread: { id: `thread-${body.title}` },
				run: { id: `run-${body.title}` },
			} as T;
		}
		if (path.endsWith("/threads/queued-thread/messages") && body) {
			queuedSubmissions++;
			return {
				queued: true,
				run: null,
				message: { id: "pub-queued-message", runId: null },
			} as T;
		}
		if (
			path ===
			"/api/platform/v1/apps/app-queued/threads/queued-thread/messages/pub-queued-message"
		) {
			queuedReads++;
			return {
				message: {
					id: "pub-queued-message",
					runId: queuedRunAssigned ? "queued-run" : null,
				},
			} as T;
		}
		if (path.endsWith("/messages") && body) {
			drainStarted();
			await admissionGate;
			return { run: { id: "run-before-shutdown" } } as T;
		}
		if (
			(interruptedRead === "run" && path.endsWith("/runs/queued-run")) ||
			(interruptedRead === "messages" &&
				path ===
					"/api/platform/v1/apps/app-queued/threads/queued-thread/messages")
		)
			return transport.json<T>(`/read/${interruption}`);
		if (path.includes("/runs/")) return { run: { status: "running" } } as T;
		if (path.endsWith("/workspace/activity")) return { ok: true } as T;
		if (path.endsWith("/messages")) return { messages: [] } as T;
		throw new Error(`Unexpected request ${path}`);
	};
	const server = createServer((req, res) => {
		if (req.url?.startsWith("/read/")) {
			if (req.url.endsWith("disconnect")) return res.destroy();
			if (req.url.endsWith("truncated")) {
				res.writeHead(200, { "content-type": "application/json" });
				res.end('{"run":');
				return;
			}
			res.writeHead(Number(req.url.split("/").at(-1)), {
				"content-type": "application/json",
			});
			res.end(JSON.stringify({ error: "temporarily_unavailable" }));
			return;
		}
		res.writeHead(409, { "content-type": "application/json" });
		res.end(
			JSON.stringify({
				error: "operation_outcome_pending",
				operationId: "remote-receipt",
			}),
		);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const address = server.address();
		assert.ok(address && typeof address !== "string");
		const adapter = new Hoplite(
			`http://127.0.0.1:${address.port}`,
			"test-only",
		);
		transport = adapter;
		await assert.rejects(adapter.json("/pending", {}, "existing-operation"), {
			status: 409,
			code: "operation_outcome_pending",
		});
		const first = sendMessage(sites[0], "Build the first site");
		await projectEntered;
		const second = sendMessage(sites[1], "Build the second site");
		await new Promise((resolve) => setTimeout(resolve, 20));
		// Each website creates its own app exactly once.
		assert.equal(projects, 2);
		releaseProject();
		await Promise.all([first, second]);
		assert.equal(sites[0].generations?.[0].status, "admitting");
		assert.equal(sites[0].phase, "generating");
		assert.equal(sites[0].generations?.[0].attempts.length, 1);
		assert.equal(sites[0].generations?.[0].attempts[0].failure, undefined);
		const checkpoint = JSON.parse(
			await readFile(join(root, "metadata.json"), "utf8"),
		);
		assert.equal(checkpoint.sites[0].generations[0].status, "admitting");
		pending = false;
		db.business.name = "A changed business while admission was pending";
		await tick();
		assert.equal(projects, 2);
		assert.equal(sites[0].appId, "app-first");
		assert.deepEqual(operations, [operations[0], operations[0]]);
		assert.deepEqual(
			prompts,
			[prompts[0], prompts[0]],
			"A pending replay must retain its original request payload",
		);
		assert.equal(sites[0].runId, "run-first");
		assert.equal(sites[0].messages.length, 1);
		let queued: Site = {
			id: "queued",
			name: "Queued edit",
			phase: "idle",
			threadId: "queued-thread",
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			messages: [],
			versions: [],
			previewRevision: 0,
			activeVersionId: "ready",
			publishedVersionId: "published",
		};
		db.sites.push(queued);
		await sendMessage(queued, "Make a queued change");
		assert.equal(queued.phase, "generating");
		assert.equal(queued.generations?.[0].status, "admitting");
		assert.equal(
			queued.generations?.[0].attempts[0].queuedMessageId,
			"pub-queued-message",
		);
		assert.equal(queued.runId, undefined);
		await tick();
		assert.equal(queued.phase, "generating");
		assert.equal(queuedReads, 1);
		assert.equal(queuedSubmissions, 1);
		assert.equal(
			queued.workspaceActivity,
			undefined,
			"Background queue reads must not renew editor activity",
		);
		const reloaded: { sites: Site[] } = JSON.parse(
			await readFile(join(root, "metadata.json"), "utf8"),
		);
		queued = reloaded.sites[2];
		db.sites[2] = queued;
		queuedRunAssigned = true;
		await tick();
		assert.equal(
			queuedSubmissions,
			1,
			"A frozen queued receipt must not be replayed to discover a run",
		);
		assert.equal(queuedReads, 2);
		assert.equal(queued.runId, "queued-run");
		assert.equal(queued.generations?.[0].status, "running");
		assert.equal(queued.generations?.[0].attempts.length, 1);
		assert.equal(queued.messages.length, 1);
		assert.equal(queued.activeVersionId, "ready");
		assert.equal(queued.publishedVersionId, "published");
		for (const stage of ["run", "messages"] as const) {
			for (const failure of ["disconnect", "truncated", "408", "429", "503"]) {
				interruptedRead = stage;
				interruption = failure;
				await tick();
				assert.equal(
					queued.phase,
					"generating",
					`${stage} ${failure} must retain the admitted run`,
				);
				assert.equal(queued.generations?.[0].status, "running");
				assert.match(queued.error ?? "", /reconnect/i);
				// An overlapping edit waits its turn; it is never admitted alongside.
				await sendMessage(queued, "An overlapping edit");
				assert.equal(queued.queuedChange?.prompt, "An overlapping edit");
				assert.equal(queued.generations?.length, 1);
				await cancelQueuedChange(queued);
				const checkpoint: { sites: Site[] } = JSON.parse(
					await readFile(join(root, "metadata.json"), "utf8"),
				);
				queued = checkpoint.sites[2];
				db.sites[2] = queued;
				interruptedRead = undefined;
				await tick();
				assert.equal(queued.error, undefined);
				assert.equal(queued.runId, "queued-run");
				assert.equal(queued.generations?.length, 1);
				assert.equal(queued.generations?.[0].attempts.length, 1);
				assert.equal(queued.generations?.[0].attempts[0].failure, undefined);
				assert.equal(queuedSubmissions, 1);
				assert.equal(queued.activeVersionId, "ready");
				assert.equal(queued.publishedVersionId, "published");
			}
		}
		sites[1].phase = "idle";
		const finishing = sendMessage(sites[1], "A final edit");
		await drainEntered;
		let drained = false;
		const shutdown = settleAdmissions().then(() => {
			drained = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(
			drained,
			false,
			"Shutdown must wait for the remote admission response",
		);
		releaseAdmission();
		await Promise.all([finishing, shutdown]);
		const saved = JSON.parse(
			await readFile(join(root, "metadata.json"), "utf8"),
		);
		assert.equal(saved.sites[1].runId, "run-before-shutdown");
		assert.equal(saved.sites[1].generations.at(-1).status, "running");
	} finally {
		releaseProject();
		releaseAdmission();
		hoplite.json = original;
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(root, { recursive: true, force: true });
	}
});
