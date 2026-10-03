import assert from "node:assert/strict";
import fs, { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import { c as archive } from "tar";
import { sha256 } from "../lib/safety";
import type { JsonValue, Site, Version } from "../lib/types";

// These tests exercise Site Studio's optional browser checks.
process.env.STUDIO_QA_CHECKS = "on";

test("autonomous releases retain evidence, repair twice at most, and promote only verified candidates", async () => {
	const root = await mkdtemp(join(tmpdir(), "studio-generation-"));
	process.env.STUDIO_DATA_DIR = root;
	const { database } = await import("../lib/store");
	const {
		hoplite,
		tick,
		sendMessage,
		seedFiles,
		publish,
		retryGeneration,
		startBuild,
	} = await import("../lib/service");
	const db = await database();
	Object.defineProperty(hoplite, "configured", { value: true });
	const originalJson = hoplite.json;
	const originalResponse = hoplite.response;
	const seed = await seedFiles();
	const artifactRoot = join(root, "fixture");
	await mkdir(artifactRoot);
	const html = Buffer.from("<!doctype html><h1>Verified release</h1>");
	await writeFile(join(artifactRoot, "index.html"), html);
	await archive(
		{ cwd: artifactRoot, file: join(root, "fixture.tar.gz"), gzip: true },
		["index.html"],
	);
	const artifact = await readFile(join(root, "fixture.tar.gz"));
	let mode: "unsafe" | "repair" | "infra" = "unsafe";
	const admissions: { id: string; content: string }[] = [];
	let current: Site;
	let buildSequence = 0;
	const buildOperations: string[] = [];
	const qaCalls: { site: string; version?: string }[] = [];
	const pass = {
		status: "passed" as const,
		checks: ["Essential flows"],
		errors: [],
		screenshots: [],
	};
	const check = async (
		site: string,
		version: string | undefined,
		directory: string,
	) => {
		qaCalls.push({ site, version });
		await mkdir(directory, { recursive: true });
		return current.generations?.at(-1)?.attempts.length === 2
			? {
					status: "failed" as const,
					checks: [],
					errors: ["/contact: booking link returns 404 at 390px"],
					screenshots: [],
				}
			: pass;
	};
	hoplite.json = async <T>(
		path: string,
		body?: JsonValue,
		operationId?: string,
	): Promise<T> => {
		if (path.endsWith("/threads") && body) {
			assert.ok(operationId);
			assert.equal((body as { sourceId: string }).sourceId, "ready-source");
			admissions.push({ id: operationId, content: JSON.stringify(body) });
			return {
				thread: { id: "restored-from-ready" },
				run: { id: `run-${operationId}` },
			} as T;
		}
		if (path.endsWith("/messages") && body) {
			assert.ok(operationId);
			admissions.push({ id: operationId, content: JSON.stringify(body) });
			return { run: { id: `run-${operationId}` } } as T;
		}
		if (path.includes("/runs/")) {
			const runId = path.split("/").at(-1);
			return {
				run: { status: "completed", resultSourceId: `source-${runId}` },
			} as T;
		}
		if (path.endsWith("/messages"))
			return {
				messages:
					mode === "repair"
						? [
								{
									id: "progress",
									role: "assistant",
									runId: current.runId,
									content:
										"[studio-status]Checking your booking links[/studio-status]",
								},
								{
									id: "summary",
									role: "assistant",
									runId: current.runId,
									content: `[studio-status]Finishing your website[/studio-status]\nCompleted ${current.runId}.`,
								},
								{
									id: "late-old-run",
									role: "assistant",
									runId: "older-run",
									content: "An unrelated older edit.",
								},
							]
						: [],
			} as T;
		if (path.endsWith("/files"))
			return {
				files:
					mode === "unsafe"
						? seed.filter((f) => f.path !== "public/site-kit.js")
						: seed,
			} as T;
		if (path.endsWith("/preview/start"))
			return {
				preview: {
					url: "https://preview.example",
					gateway: {
						token: "test",
						header: "x-preview",
						expiresAt: new Date(Date.now() + 60000).toISOString(),
					},
				},
			} as T;
		if (path.endsWith("/builds") && body) {
			assert.ok(operationId);
			buildOperations.push(operationId);
			return { build: { id: `build-${++buildSequence}` } } as T;
		}
		if (path.endsWith("/manifest"))
			return {
				files: [
					{ path: "index.html", sha256: sha256(html), byteSize: html.length },
				],
			} as T;
		if (path.includes("/builds/"))
			return {
				build:
					mode === "infra"
						? { status: "failed", error: "build_runner_failed" }
						: current.generations?.at(-1)?.attempts.length === 1
							? { status: "failed", error: "build_command_failed" }
							: { status: "ready", artifactSha256: sha256(artifact) },
			} as T;
		if (path.endsWith("/workspace/activity")) return { ok: true } as T;
		throw new Error(`Unexpected API call: ${path}`);
	};
	hoplite.response = async (path) => {
		if (path.endsWith("/artifact")) return new Response(artifact);
		assert.ok(path.endsWith("/logs"));
		return new Response("src/pages/contact.astro:12: Unexpected closing tag");
	};
	function fixture(id: string) {
		const old: Version = {
			id: `ready-${id}`,
			sourceId: "ready-source",
			label: "Ready",
			createdAt: new Date().toISOString(),
			artifactDirectory: "existing",
			qa: pass,
		};
		current = {
			id,
			appId: "app",
			name: "Test",
			createdAt: old.createdAt,
			updatedAt: old.createdAt,
			threadId: `thread-${id}`,
			phase: "idle",
			messages: [],
			versions: [old],
			activeVersionId: old.id,
			publishedVersionId: old.id,
			sourceId: old.sourceId,
			previewRevision: 0,
		};
		db.sites = [current];
		return current;
	}
	try {
		{
			// preserves the ready/published release after three unsafe source candidates.
			mode = "unsafe";
			const site = fixture("unsafe");
			await sendMessage(site, "Make the website orange");
			for (let i = 0; i < 3; i++) await tick(check);
			const generation = site.generations?.at(-1);
			assert.ok(generation);
			assert.equal(generation.attempts.length, 3);
			assert.equal(admissions.length, 3);
			assert.equal(
				site.messages.length,
				1,
				"repair instructions are not fabricated customer messages",
			);
			assert.equal(generation.status, "failed");
			assert.equal(site.phase, "failed");
			assert.equal(site.activeVersionId, "ready-unsafe");
			assert.equal(site.publishedVersionId, "ready-unsafe");
			assert.equal(site.sourceId, "ready-source");
			assert.equal(site.versions.length, 4);
			for (const version of site.versions.slice(1)) {
				assert.equal(version.failure?.stage, "source");
				assert.ok(
					(await readFile(join(root, "versions", version.id, "source.json")))
						.length,
				);
				await assert.rejects(
					publish(site, version.id),
					/passing browser checks/,
				);
			}
			assert.match(admissions[1].content, /public\/site-kit.js/);
			assert.match(admissions[2].content, /repair 2 of 2/);
			await tick(check);
			assert.equal(
				admissions.length,
				3,
				"polling cannot exceed the repair budget",
			);
			await retryGeneration(site);
			assert.equal(site.threadId, "restored-from-ready");
			assert.equal(site.generations?.length, 2);
			assert.equal(site.generations?.[0].attempts.length, 3);
			assert.equal(site.generations?.[1].attempts.length, 1);
			assert.equal(site.activeVersionId, "ready-unsafe");
		}
		{
			// repairs build then browser failures, tests both outputs, and waits for explicit publish.
			mode = "repair";
			const site = fixture("repaired");
			const before = admissions.length;
			await sendMessage(site, "Add a contact page");
			for (let i = 0; i < 5; i++) {
				await tick(check);
				assert.equal(
					site.activeVersionId,
					"ready-repaired",
					"a saved but unchecked candidate cannot replace the ready draft",
				);
			}
			// Promotion exposes idle in memory before the final write settles. A new
			// request must remain blocked until that in-flight tick has committed.
			const originalWrite = fs.writeFile;
			let entered!: () => void;
			const checkpointEntered = new Promise<void>((resolve) => {
				entered = resolve;
			});
			let release!: () => void;
			const checkpointGate = new Promise<void>((resolve) => {
				release = resolve;
			});
			let held = false;
			const blockedWrite = mock.method(
				fs,
				"writeFile",
				async (...args: Parameters<typeof originalWrite>) => {
					if (
						!held &&
						args[0] === join(root, "metadata.json.tmp") &&
						typeof args[1] === "string"
					) {
						const snapshot: { sites: Site[] } = JSON.parse(args[1]);
						if (snapshot.sites[0].activeVersionId !== "ready-repaired") {
							held = true;
							entered();
							await checkpointGate;
						}
					}
					return originalWrite(...args);
				},
			);
			syncBuiltinESMExports();
			const completing = tick(check);
			let overlapping: Promise<string | undefined> = Promise.resolve(undefined);
			try {
				await Promise.race([
					checkpointEntered,
					completing.then(() => {
						throw new Error("Promotion checkpoint was not reached");
					}),
				]);
				assert.equal(site.phase, "idle");
				// An overlapping request waits its turn rather than being admitted;
				// its save queues behind the held checkpoint.
				overlapping = sendMessage(site, "An overlapping change");
				assert.equal(site.queuedChange?.prompt, "An overlapping change");
				site.queuedChange = undefined;
				await assert.rejects(
					startBuild(site, "ready-repaired"),
					/current operation/,
				);
				assert.equal(admissions.length - before, 3);
			} finally {
				release();
				try {
					await completing;
					await overlapping;
				} finally {
					blockedWrite.mock.restore();
					syncBuiltinESMExports();
				}
			}
			assert.equal(site.phase, "idle");
			assert.equal(admissions.length - before, 3);
			assert.equal(site.generations?.at(-1)?.status, "ready");
			const latest = site.versions.at(-1);
			assert.ok(latest);
			assert.equal(site.activeVersionId, latest.id);
			assert.equal(site.publishedVersionId, "ready-repaired");
			assert.equal(site.sourceId, latest.sourceId);
			assert.equal(latest.qa?.status, "passed");
			assert.equal(latest.changeSummary, `Completed ${latest.runId}.`);
			assert.equal(
				latest.repairSummary,
				`Completed ${latest.runId}.`,
				"a repair's own reply is kept as a repair note",
			);
			assert.deepEqual(qaCalls.slice(-2), [
				{ site: site.id, version: undefined },
				{ site: site.id, version: latest.id },
			]);
			assert.match(admissions[before + 1].content, /Unexpected closing tag/);
			assert.match(admissions[before + 2].content, /booking link returns 404/);
			assert.equal(site.versions[1].failure?.stage, "build");
			assert.equal(site.versions[2].failure?.stage, "browser");
			await publish(site, latest.id);
			assert.equal(site.publishedVersionId, latest.id);
			await publish(site, "ready-repaired");
			assert.equal(
				site.publishedVersionId,
				"ready-repaired",
				"rollback is explicit and preserves newer releases",
			);
			const persisted = JSON.parse(
				await readFile(join(root, "metadata.json"), "utf8"),
			);
			assert.equal(persisted.sites[0].activeVersionId, latest.id);
			assert.equal(
				persisted.sites[0].versions.at(-1).changeSummary,
				latest.changeSummary,
			);
		}
		{
			// does not spend agent repairs on provider failures.
			mode = "infra";
			const site = fixture("infra");
			const before = admissions.length;
			await sendMessage(site, "Change the headline");
			await tick(check);
			await tick(check);
			assert.equal(site.phase, "failed");
			assert.equal(admissions.length - before, 1);
			assert.equal(
				site.generations?.at(-1)?.attempts[0].failure?.category,
				"infrastructure",
			);
			assert.equal(site.activeVersionId, "ready-infra");
			assert.equal(site.publishedVersionId, "ready-infra");
		}
		{
			// resumes an interrupted build admission using the persisted operation identity.
			mode = "repair";
			const site = fixture("resume");
			const version: Version = {
				id: "pending",
				sourceId: "pinned",
				label: "Pending",
				createdAt: site.createdAt,
				buildOperationId: "durable-build-operation",
			};
			site.versions.push(version);
			site.buildVersionId = version.id;
			site.phase = "building";
			await tick(check);
			assert.equal(buildOperations.at(-1), "durable-build-operation");
			assert.ok(version.buildId);
			assert.equal(site.activeVersionId, "ready-resume");
		}
		// Recover old metadata saved before source rejection, including an already-admitted build.
		mode = "unsafe";
		for (const buildId of [undefined, "already-admitted"]) {
			const site = fixture(`unsafe-recovery-${buildId ?? "new"}`);
			const version: Version = {
				id: "recovered",
				sourceId: "unsafe-source",
				label: "Recovered",
				createdAt: site.createdAt,
				buildId,
			};
			site.versions.push(version);
			site.buildVersionId = version.id;
			site.phase = "building";
			const beforeBuilds = buildOperations.length;
			const beforeChecks = qaCalls.length;
			await tick(check);
			assert.equal(version.failure?.stage, "source");
			assert.equal(site.phase, "failed");
			assert.equal(buildOperations.length, beforeBuilds);
			assert.equal(qaCalls.length, beforeChecks);
			assert.equal(site.activeVersionId, site.versions[0].id);
			await assert.rejects(publish(site, version.id), /passing browser checks/);
		}
		{
			const site = fixture("concurrent-admission");
			const before = admissions.length;
			const results = await Promise.allSettled([
				sendMessage(site, "Change the headline"),
				sendMessage(site, "Change the colours"),
			]);
			// The second request waits its turn instead of racing the first.
			assert.deepEqual(
				results.map((result) => result.status),
				["fulfilled", "fulfilled"],
			);
			assert.equal(site.generations?.length, 1);
			assert.equal(admissions.length - before, 1);
			assert.equal(site.generations?.[0].status, "running");
			assert.equal(site.queuedChange?.prompt, "Change the colours");
		}
	} finally {
		hoplite.json = originalJson;
		hoplite.response = originalResponse;
		await rm(root, { recursive: true, force: true });
	}
});
