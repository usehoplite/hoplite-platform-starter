import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { c as archive } from "tar";
import { capturedLogs } from "../lib/log";
import { sha256 } from "../lib/safety";
import type { JsonValue, Site, Version } from "../lib/types";

// Browser checks are Site Studio's choice and default off; each test sets it.
delete process.env.STUDIO_QA_CHECKS;
const root = await mkdtemp(join(tmpdir(), "studio-checks-mode-"));
process.env.STUDIO_DATA_DIR = root;
after(() => rm(root, { recursive: true, force: true }));

const { database } = await import("../lib/store");
const service = await import("../lib/service");
const {
	hoplite,
	tick,
	sendMessage,
	seedFiles,
	publish,
	retryGeneration,
	browserChecksEnabled,
	buildDeadlineMs,
} = service;
const db = await database();
Object.defineProperty(hoplite, "configured", { value: true });
const seed = await seedFiles();
const fixtureRoot = join(root, "fixture");
await mkdir(fixtureRoot);
const html = Buffer.from("<!doctype html><title>Home</title><h1>Home</h1>");
await writeFile(join(fixtureRoot, "index.html"), html);
await archive(
	{ cwd: fixtureRoot, file: join(root, "fixture.tar.gz"), gzip: true },
	["index.html"],
);
const artifact = await readFile(join(root, "fixture.tar.gz"));

/** Scripted platform: each build's status comes from `buildStatus`. */
const platform = {
	admissions: [] as string[],
	builds: [] as { operationId: string; sourceId: string; id: string }[],
	buildStatus: (_id: string): { status: string; error?: string } => ({
		status: "ready",
	}),
	checks: 0,
	summary:
		"Your home page now leads with your booking button. I haven't been able to view the pages on screen yet, so please have a look through the preview.",
};
hoplite.json = async <T>(
	path: string,
	body?: JsonValue,
	operationId?: string,
): Promise<T> => {
	if (
		(path.endsWith("/threads") || path.endsWith("/messages")) &&
		body !== undefined
	) {
		assert.ok(operationId);
		platform.admissions.push(operationId);
		return {
			thread: { id: "thread-new" },
			run: { id: `run-${operationId}` },
		} as T;
	}
	if (path.includes("/runs/")) {
		const runId = path.split("/").at(-1);
		return {
			run: { status: "completed", resultSourceId: `source-${runId}` },
		} as T;
	}
	if (path.endsWith("/messages"))
		return {
			messages: [
				{
					id: `reply-${current.runId}`,
					role: "assistant",
					runId: current.runId,
					content: platform.summary,
				},
			],
		} as T;
	if (path.endsWith("/files")) return { files: seed } as T;
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
	if (path.endsWith("/builds") && body !== undefined) {
		assert.ok(operationId);
		const id = `build-${platform.builds.length + 1}`;
		platform.builds.push({
			operationId,
			sourceId: (body as { sourceId: string }).sourceId,
			id,
		});
		return { build: { id } } as T;
	}
	if (path.endsWith("/manifest"))
		return {
			files: [{ path: "index.html", sha256: sha256(html), size: html.length }],
		} as T;
	if (path.includes("/builds/")) {
		const id = path.split("/").at(-1) ?? "";
		const status = platform.buildStatus(id);
		return {
			build:
				status.status === "ready"
					? { status: "ready", artifactSha256: sha256(artifact) }
					: status,
		} as T;
	}
	if (path.endsWith("/workspace/activity")) return { ok: true } as T;
	throw new Error(`Unexpected API call: ${path}`);
};
hoplite.response = async (path) => {
	if (path.endsWith("/artifact")) return new Response(artifact);
	assert.ok(path.endsWith("/logs"));
	return new Response("build log");
};
const pass = {
	status: "passed" as const,
	checks: ["Every page loads"],
	errors: [],
	screenshots: [],
};
async function check(_site: string, _version: string | undefined, dir: string) {
	platform.checks++;
	await mkdir(dir, { recursive: true });
	return pass;
}

let current: Site;
function fixture(id: string, withReady = true) {
	const createdAt = new Date().toISOString();
	const ready: Version = {
		id: `ready-${id}`,
		sourceId: "ready-source",
		label: "Version 1",
		createdAt,
		artifactDirectory: "existing",
		qa: pass,
	};
	current = {
		id,
		appId: "app",
		name: "Test",
		createdAt,
		updatedAt: createdAt,
		threadId: `thread-${id}`,
		phase: "idle",
		messages: [],
		versions: withReady ? [ready] : [],
		activeVersionId: withReady ? ready.id : undefined,
		sourceId: withReady ? ready.sourceId : "seed-source",
		previewRevision: 0,
	};
	db.sites = [current];
	return current;
}

test("browser checks are off unless Site Studio turns them on", () => {
	assert.equal(browserChecksEnabled(), false);
	for (const value of ["on", "ON", "true", "1"]) {
		process.env.STUDIO_QA_CHECKS = value;
		assert.equal(browserChecksEnabled(), true, value);
	}
	for (const value of ["off", "", "no"]) {
		process.env.STUDIO_QA_CHECKS = value;
		assert.equal(browserChecksEnabled(), false, value);
	}
	delete process.env.STUDIO_QA_CHECKS;
});

test("checks off: a successful build is ready and publishable without browser checks", async () => {
	platform.buildStatus = () => ({ status: "ready" });
	const checksBefore = platform.checks;
	const site = fixture("off");
	await sendMessage(site, "Make the booking button stand out");
	await tick(check);
	assert.equal(site.phase, "building");
	const phases: string[] = [];
	await tick(async (id: string, version: string | undefined, dir: string) => {
		phases.push(site.phase);
		return check(id, version, dir);
	});
	assert.equal(platform.checks, checksBefore, "no browser checks ran");
	assert.deepEqual(phases, []);
	assert.equal(site.phase, "idle");
	const version = site.versions.at(-1);
	assert.ok(version);
	assert.equal(site.activeVersionId, version.id, "the draft is ready");
	assert.equal(version.qa?.status, "passed");
	assert.equal(version.qa?.browserChecks, false);
	assert.deepEqual(version.routes, ["/"]);
	assert.ok(version.qaReport);
	const report = JSON.parse(
		await readFile(
			join(root, "versions", version.id, version.qaReport),
			"utf8",
		),
	);
	assert.equal(report.status, "passed");
	// The change summary is short and has no notes about the agent's tooling.
	assert.equal(
		version.changeSummary,
		"Your home page now leads with your booking button.",
	);
	await publish(site, version.id);
	assert.equal(site.publishedVersionId, version.id);
});

test("checks on: the draft is ready only after browser checks pass", async () => {
	process.env.STUDIO_QA_CHECKS = "on";
	try {
		platform.buildStatus = () => ({ status: "ready" });
		const checksBefore = platform.checks;
		const site = fixture("on");
		await sendMessage(site, "Add our team");
		await tick(check);
		assert.equal(site.phase, "building");
		const phases: string[] = [];
		await tick(async (id: string, version: string | undefined, dir: string) => {
			phases.push(site.phase);
			return check(id, version, dir);
		});
		assert.equal(platform.checks - checksBefore, 2, "preview and artifact");
		assert.deepEqual(phases, ["checking", "checking"]);
		const version = site.versions.at(-1);
		assert.ok(version);
		assert.equal(site.activeVersionId, version.id);
		assert.notEqual(version.qa?.browserChecks, false);
	} finally {
		delete process.env.STUDIO_QA_CHECKS;
	}
});

test("checks on: waiting for a checking slot counts towards the checks deadline", async () => {
	process.env.STUDIO_QA_CHECKS = "on";
	try {
		platform.buildStatus = () => ({ status: "ready" });
		const site = fixture("checks-deadline");
		await sendMessage(site, "Add a price list");
		await tick(check);
		const draft = site.versions.at(-1);
		assert.ok(draft);
		// The build became ready long ago but checks never got going.
		draft.checksStartedAt = new Date(
			Date.now() - service.checksDeadlineMs - 1000,
		).toISOString();
		const checksBefore = platform.checks;
		await tick(check);
		assert.equal(platform.checks, checksBefore, "no checks after the deadline");
		assert.equal(site.phase, "failed");
		assert.match(site.error ?? "", /took too long/);
		assert.ok(draft.failure && draft.failure.category !== "repairable");
	} finally {
		delete process.env.STUDIO_QA_CHECKS;
	}
});

test("retry after a build infrastructure failure rebuilds the same draft", async () => {
	for (const error of [
		"build_infrastructure_unavailable",
		"build_execution_failed",
		"build_timeout",
		"a_code_this_studio_has_never_seen",
	]) {
		const site = fixture(`infra-${error}`);
		let failing = true;
		// A build that failed on the platform stays failed.
		const failed = new Set<string>();
		platform.buildStatus = (id) => {
			if (failing) failed.add(id);
			return failed.has(id) ? { status: "failed", error } : { status: "ready" };
		};
		await sendMessage(site, "Change the headline");
		await tick(check);
		await tick(check);
		assert.equal(site.phase, "failed", error);
		const draft = site.versions.at(-1);
		assert.ok(draft);
		assert.equal(draft.failure?.category, "infrastructure");
		assert.match(site.error ?? "", /finish the same version/);
		assert.match(site.error ?? "", /previous version is still safe/);
		assert.doesNotMatch(site.error ?? "", /build_|Hoplite|HTTP/);
		assert.ok(
			capturedLogs.some(
				(line) => line.event === "build.run.failed" && line.error === error,
			),
			"the platform's code is logged for operators",
		);
		const admissions = platform.admissions.length;
		const builds = platform.builds.length;
		failing = false;
		await retryGeneration(site);
		assert.equal(platform.admissions.length, admissions, "no new agent run");
		assert.equal(platform.builds.length, builds + 1);
		const rebuild = platform.builds.at(-1);
		assert.equal(rebuild?.sourceId, draft.sourceId, "same source");
		assert.notEqual(rebuild?.operationId, platform.builds.at(-2)?.operationId);
		assert.equal(draft.failure, undefined);
		await tick(check);
		assert.equal(site.phase, "idle");
		assert.equal(site.activeVersionId, draft.id);
		assert.equal(site.versions.at(-1), draft, "no new version was written");
		assert.equal(site.generations?.at(-1)?.status, "ready");
	}
});

test("a failing build command is the agent's work and gets a repair, not a rebuild", async () => {
	const site = fixture("command");
	platform.buildStatus = () => ({
		status: "failed",
		error: "build_command_failed",
	});
	const admissions = platform.admissions.length;
	await sendMessage(site, "Add a gallery");
	await tick(check);
	await tick(check);
	assert.equal(platform.admissions.length, admissions + 2, "a repair run");
	assert.equal(site.generations?.at(-1)?.attempts.length, 2);
});

test("a build that never finishes fails at the studio deadline and retry rebuilds it", async () => {
	const site = fixture("stuck", false);
	let status = "building";
	platform.buildStatus = () => ({ status });
	await sendMessage(site, "");
	assert.deepEqual(
		site.messages.map(({ role, content }) => ({ role, content })),
		[{ role: "system", content: "Creating your website" }],
		"an empty request never puts words in the owner's mouth",
	);
	await tick(check);
	const draft = site.versions.at(-1);
	assert.ok(draft?.buildStartedAt);
	await tick(check);
	assert.equal(site.phase, "building", "still within the deadline");
	draft.buildStartedAt = new Date(
		Date.now() - buildDeadlineMs - 1000,
	).toISOString();
	await tick(check);
	assert.equal(site.phase, "failed");
	assert.match(site.error ?? "", /took too long/);
	assert.doesNotMatch(
		site.error ?? "",
		/previous version/,
		"a first version has no previous version to fall back on",
	);
	const builds = platform.builds.length;
	await retryGeneration(site);
	assert.equal(
		platform.builds.length,
		builds + 1,
		"a build the studio gave up on is started again, not awaited",
	);
	assert.equal(site.phase, "building");
	status = "ready";
	await tick(check);
	assert.equal(site.phase, "idle");
	assert.equal(site.activeVersionId, draft.id);
});
