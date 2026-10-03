import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { c as archive } from "tar";
import { sha256 } from "../lib/safety";
import type { Site, Version } from "../lib/types";

// These tests exercise Site Studio's optional browser checks.
process.env.STUDIO_QA_CHECKS = "on";

test("a slow website check does not block another website or duplicate its own work", async () => {
	const root = await mkdtemp(join(tmpdir(), "studio-concurrent-checks-"));
	process.env.STUDIO_DATA_DIR = root;
	const { database } = await import("../lib/store");
	const { hoplite, tick, startBuild } = await import("../lib/service");
	const db = await database();
	const pass = {
		status: "passed" as const,
		checks: ["Passed"],
		errors: [],
		screenshots: [],
	};
	const sites: Site[] = ["slow", "fast", "queued"].map((id) => {
		const old: Version = {
			id: `${id}-old`,
			sourceId: "old-source",
			label: "Old",
			createdAt: new Date().toISOString(),
			qa: pass,
			artifactDirectory: "old",
		};
		return {
			id,
			appId: "app",
			name: id,
			createdAt: old.createdAt,
			updatedAt: old.createdAt,
			phase: "building",
			threadId: id,
			runId: `run-${id}`,
			buildVersionId: id,
			activeVersionId: old.id,
			publishedVersionId: old.id,
			previewRevision: 0,
			messages: [],
			versions: [
				old,
				{
					id,
					sourceId: `source-${id}`,
					sourceChecked: true,
					label: "Candidate",
					createdAt: old.createdAt,
					buildId: `build-${id}`,
				},
			],
		};
	});
	db.sites = sites;
	const originalJson = hoplite.json;
	const originalResponse = hoplite.response;
	const html = Buffer.from("<!doctype html><h1>Release fixture</h1>");
	const fixture = join(root, "fixture");
	await mkdir(fixture);
	await writeFile(join(fixture, "index.html"), html);
	await archive(
		{ cwd: fixture, file: join(root, "artifact.tar.gz"), gzip: true },
		["index.html"],
	);
	const artifact = await readFile(join(root, "artifact.tar.gz"));
	for (const site of sites)
		await mkdir(join(root, "versions", site.id), { recursive: true });
	hoplite.json = async <T>(path: string): Promise<T> => {
		if (path.includes("/preview"))
			return {
				preview: {
					status: "ready",
					url: "https://preview.example",
					gateway: {
						token: "fixture",
						header: "x-preview",
						expiresAt: new Date(Date.now() + 60_000).toISOString(),
					},
				},
			} as T;
		if (path.includes("/runs/"))
			return {
				run: {
					status: "completed",
					resultSourceId: `source-${path.split("/runs/run-")[1]}`,
				},
			} as T;
		if (path.endsWith("/manifest"))
			return { files: [{ path: "index.html", sha256: sha256(html) }] } as T;
		assert.ok(path.includes("/builds/"), path);
		return {
			build: { status: "ready", artifactSha256: sha256(artifact) },
		} as T;
	};
	hoplite.response = async (path) => {
		assert.ok(path.endsWith("/artifact"));
		return new Response(artifact);
	};
	let enter!: () => void;
	const entered = new Promise<void>((resolve) => {
		enter = resolve;
	});
	let release!: () => void;
	const blocked = new Promise<void>((resolve) => {
		release = resolve;
	});
	let releaseFast!: () => void;
	const fastGate = new Promise<void>((resolve) => {
		releaseFast = resolve;
	});
	let fastStarted!: () => void;
	const fastEntered = new Promise<void>((resolve) => {
		fastStarted = resolve;
	});
	const checkedSites = new Set<string>();
	let activeChecks = 0;
	let peakChecks = 0;
	let slowCalls = 0;
	let stall = true;
	const check = async (
		siteId: string,
		_versionId: string | undefined,
		directory: string,
	) => {
		await mkdir(directory, { recursive: true });
		checkedSites.add(siteId);
		activeChecks++;
		peakChecks = Math.max(peakChecks, activeChecks);
		try {
			if (siteId === "fast") {
				fastStarted();
				await fastGate;
			}
			if (siteId === "slow") {
				slowCalls++;
				if (stall) {
					enter();
					await blocked;
					throw new Error("Preview provider unavailable");
				}
			}
			return pass;
		} finally {
			activeChecks--;
		}
	};
	const pending = tick(check);
	try {
		await Promise.race([
			entered,
			new Promise((_, reject) =>
				setTimeout(
					() => reject(new Error("Slow check never started")),
					10_000,
				).unref(),
			),
		]);
		await fastEntered;
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(
			checkedSites.has("queued"),
			false,
			"A third browser suite must wait for a slot",
		);
		releaseFast();
		const deadline = Date.now() + 2000;
		while (true) {
			const saved = JSON.parse(
				await readFile(join(root, "metadata.json"), "utf8"),
			);
			if (
				saved.sites.find((site: Site) => site.id === "fast")
					?.activeVersionId === "fast"
			)
				break;
			assert.ok(
				Date.now() < deadline,
				"The fast website was blocked behind the slow check",
			);
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assert.equal(sites[0].phase, "checking");
		assert.equal(sites[1].phase, "idle");
		assert.equal(sites[1].publishedVersionId, "fast-old");
		const queuedDeadline = Date.now() + 2000;
		while (sites[2].activeVersionId !== "queued") {
			await Promise.all([tick(check), tick(check)]);
			assert.ok(
				Date.now() < queuedDeadline,
				"The queued website did not progress after the fast check finished",
			);
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assert.equal(
			sites[2].activeVersionId,
			"queued",
			"The queued website progresses once a browser slot is free",
		);
		assert.equal(peakChecks, 2);
		assert.equal(
			slowCalls,
			1,
			"Overlapping polls cannot run a second QA for this website",
		);
		release();
		await pending;
		assert.equal(sites[0].phase, "failed");
		assert.equal(sites[0].activeVersionId, "slow-old");
		assert.equal(sites[1].activeVersionId, "fast");
		stall = false;
		await startBuild(sites[0], "slow");
		await tick(check);
		assert.equal(
			sites[0].activeVersionId,
			"slow",
			"A failed check releases its site so a later retry can finish",
		);
		assert.equal(slowCalls, 3);
		sites[0].phase = "building";
		await rm(join(root, "metadata.json"));
		await mkdir(join(root, "metadata.json"));
		await assert.rejects(
			tick(check),
			/Website processing failed:.*metadata\.json/,
			"Polling must retain the underlying persistence failure",
		);
	} finally {
		releaseFast();
		release();
		await pending;
		hoplite.json = originalJson;
		hoplite.response = originalResponse;
		await rm(root, { recursive: true, force: true });
	}
});
