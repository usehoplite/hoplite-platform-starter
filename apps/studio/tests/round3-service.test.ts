import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { c as archive } from "tar";
import { HopliteError } from "../lib/hoplite";
import { capturedLogs } from "../lib/log";
import { stalledAfterMs } from "../lib/progress";
import type { QuickCheckResult } from "../lib/qa";
import { sha256 } from "../lib/safety";
import type { JsonValue, Site, Version } from "../lib/types";

// Round 3: safe retry, queued changes, stalled changes, the quick check and
// requests that change nothing. Browser checks stay off unless a test sets them.
delete process.env.STUDIO_QA_CHECKS;
const root = await mkdtemp(join(tmpdir(), "studio-round3-"));
process.env.STUDIO_DATA_DIR = root;
after(() => rm(root, { recursive: true, force: true }));

const { database } = await import("../lib/store");
const service = await import("../lib/service");
const { hoplite, tick, sendMessage, seedFiles, retryGeneration } = service;
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

/** Scripted platform; tests replace the hooks they need. */
const platform = {
	admissions: [] as { operationId: string; body: JsonValue | undefined }[],
	buildPosts: [] as string[],
	builds: new Map<string, string>(),
	/** Throws for a build admission, or returns nothing to accept it. */
	buildAdmission: (_operationId: string): Error | undefined => undefined,
	/** Throws for a change admission, or returns nothing to accept it. */
	admission: (): Error | undefined => undefined,
	buildStatus: (_id: string) => "ready",
	runStatus: () => "completed",
	resultSource: (runId: string) => `source-${runId}`,
	runMessages: (_runId: string) => [] as { id: string; content: string }[],
	startPreview: async (): Promise<void> => undefined,
};
let current: Site;
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
		platform.admissions.push({ operationId, body });
		const refused = platform.admission();
		if (refused) throw refused;
		return {
			thread: { id: `thread-${platform.admissions.length}` },
			run: { id: `run-${operationId}` },
		} as T;
	}
	if (path.includes("/runs/")) {
		const runId = path.split("/").at(-1) ?? "";
		return {
			run: {
				status: platform.runStatus(),
				resultSourceId: platform.resultSource(runId),
			},
		} as T;
	}
	if (path.endsWith("/messages"))
		return {
			messages: [
				...platform.runMessages(current.runId ?? ""),
				{
					id: `reply-${current.runId}`,
					role: "assistant",
					runId: current.runId,
					content: "Your home page has a new headline.",
				},
			].map((message) => ({
				role: "assistant",
				runId: current.runId,
				...message,
			})),
		} as T;
	if (path.endsWith("/files")) return { files: seed } as T;
	if (path.endsWith("/preview/start")) {
		await platform.startPreview();
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
	}
	if (path.endsWith("/builds") && body !== undefined) {
		assert.ok(operationId);
		platform.buildPosts.push(operationId);
		const refused = platform.buildAdmission(operationId);
		if (refused) throw refused;
		// Idempotent: the same operation key always names the same build.
		const id =
			platform.builds.get(operationId) ?? `build-${platform.builds.size + 1}`;
		platform.builds.set(operationId, id);
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
				status === "ready"
					? { status, artifactSha256: sha256(artifact) }
					: { status, error: "build_infrastructure_unavailable" },
		} as T;
	}
	if (path.endsWith("/workspace/activity")) return { ok: true } as T;
	throw new Error(`Unexpected API call: ${path}`);
};
hoplite.response = async (path) => {
	if (path.endsWith("/artifact")) return new Response(artifact);
	return new Response("build log");
};
const pass = {
	status: "passed" as const,
	checks: ["Every page loads"],
	errors: [],
	screenshots: [],
};
async function check(_site: string, _version: string | undefined, dir: string) {
	await mkdir(dir, { recursive: true });
	return pass;
}
function reset() {
	platform.buildAdmission = () => undefined;
	platform.admission = () => undefined;
	platform.buildStatus = () => "ready";
	platform.runStatus = () => "completed";
	platform.resultSource = (runId) => `source-${runId}`;
	platform.runMessages = () => [];
	platform.startPreview = async () => undefined;
}
function fixture(id: string): Site {
	reset();
	const createdAt = new Date().toISOString();
	const ready: Version = {
		id: `ready-${id}`,
		sourceId: `ready-source-${id}`,
		label: "Version 1",
		createdAt,
		artifactDirectory: "existing",
		qa: pass,
		changeSummary: "Your first website.",
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
		versions: [ready],
		activeVersionId: ready.id,
		sourceId: ready.sourceId,
		previewRevision: 0,
	};
	db.sites = [current];
	return current;
}

test("M2: Try again after an unconfirmed build admission is single-flight and never fails on a busy workspace", async () => {
	const site = fixture("retry-race");
	// The first admission reached the platform, but its answer was lost.
	let lost = true;
	platform.buildAdmission = () =>
		lost ? new HopliteError(0, "connection_interrupted") : undefined;
	await sendMessage(site, "Change the headline");
	await tick(check, null);
	assert.equal(site.phase, "failed");
	const draft = site.versions.at(-1);
	assert.ok(draft && !draft.buildId);
	assert.match(site.error ?? "", /finish the same version/);
	const firstKey = platform.buildPosts.at(-1);
	lost = false;
	// Hold the preview restart so the background processor runs mid-retry.
	let release!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	platform.startPreview = () => held;
	const posts = platform.buildPosts.length;
	const retry = retryGeneration(site);
	const background = tick(check, null);
	// A second "Try again" while the first is still admitting attaches to it.
	await assert.rejects(retryGeneration(site), /no failed update/);
	await background;
	release();
	await retry;
	assert.equal(
		platform.buildPosts.length - posts,
		1,
		"exactly one admission during the retry",
	);
	assert.equal(
		platform.buildPosts.at(-1),
		firstKey,
		"the unconfirmed operation is replayed, finding any build it created",
	);
	assert.equal(site.phase, "building");
	assert.ok(draft.buildId);
	await tick(check, null);
	assert.equal(site.phase, "idle");
	assert.equal(site.activeVersionId, draft.id, "the same draft is ready");
	assert.equal(site.versions.at(-1), draft, "no new version was written");
});

test("M2: a busy workspace (build_busy) keeps the version building and attaches to the earlier build", async () => {
	const site = fixture("busy");
	let status = "building";
	platform.buildStatus = () => status;
	await sendMessage(site, "Add a gallery");
	await tick(check, null);
	const draft = site.versions.at(-1);
	assert.ok(draft?.buildId);
	const stuck = draft.buildId;
	// The studio gave up on the build at its deadline; the platform still runs it.
	draft.buildStartedAt = new Date(
		Date.now() - service.buildDeadlineMs - 1000,
	).toISOString();
	await tick(check, null);
	assert.equal(site.phase, "failed");
	platform.buildAdmission = () => new HopliteError(409, "build_busy");
	await retryGeneration(site);
	assert.equal(site.phase, "building", "build_busy never fails the version");
	assert.equal(site.error, undefined);
	assert.equal(
		draft.buildId,
		stuck,
		"attached to the build holding the workspace",
	);
	assert.equal(draft.failure, undefined);
	status = "ready";
	await tick(check, null);
	assert.equal(site.phase, "idle");
	assert.equal(site.activeVersionId, draft.id);
});

test("M2: without a known build, build_busy waits and replays the same operation within the deadline", async () => {
	const site = fixture("busy-unknown");
	let busy = true;
	platform.buildAdmission = () =>
		busy ? new HopliteError(409, "build_busy") : undefined;
	await sendMessage(site, "Add opening times");
	await tick(check, null);
	const draft = site.versions.at(-1);
	assert.ok(draft);
	assert.equal(site.phase, "building");
	assert.equal(draft.buildId, undefined);
	const key = platform.buildPosts.at(-1);
	busy = false;
	await tick(check, null);
	assert.equal(platform.buildPosts.at(-1), key, "the same idempotent key");
	assert.ok(draft.buildId);
	await tick(check, null);
	assert.equal(site.phase, "idle");
	// A workspace that never frees up ends at the deadline, rebuildable.
	const later = fixture("busy-forever");
	platform.buildAdmission = () => new HopliteError(409, "build_busy");
	await sendMessage(later, "Add prices");
	await tick(check, null);
	const waiting = later.versions.at(-1);
	assert.ok(waiting?.buildRequestedAt);
	waiting.buildRequestedAt = new Date(
		Date.now() - service.buildDeadlineMs - 1000,
	).toISOString();
	await tick(check, null);
	assert.equal(later.phase, "failed");
	assert.match(later.error ?? "", /took too long/);
});

test("M4: a message sent while a change runs is queued, combined, cancellable and then started", async () => {
	const site = fixture("queue");
	platform.runStatus = () => "running";
	await sendMessage(site, "Change the headline");
	assert.equal(site.phase, "generating");
	const conversation = site.conversationId;
	const returned = await sendMessage(site, "Also make the logo bigger");
	assert.equal(returned, conversation, "queued in the same conversation");
	assert.equal(site.queuedChange?.prompt, "Also make the logo bigger");
	await sendMessage(site, "And use green");
	assert.equal(
		site.queuedChange?.prompt,
		"Also make the logo bigger\n\nAnd use green",
		"requests in the same conversation are combined",
	);
	assert.equal(
		site.generations?.length,
		1,
		"nothing was silently dropped or admitted",
	);
	// Another conversation cannot jump the queue.
	await assert.rejects(
		sendMessage(site, "Something else", null),
		/already waiting/,
	);
	await service.cancelQueuedChange(site);
	assert.equal(site.queuedChange, undefined);
	await sendMessage(site, "Also make the logo bigger");
	platform.runStatus = () => "completed";
	await tick(check, null); // completes the first change and admits its build
	await tick(check, null); // ready
	assert.equal(site.generations?.length, 1);
	assert.equal(site.phase, "idle");
	platform.runStatus = () => "running";
	await tick(check, null); // idle: the queued change starts
	assert.equal(site.queuedChange, undefined);
	assert.equal(site.generations?.length, 2);
	assert.equal(site.generations?.at(-1)?.prompt, "Also make the logo bigger");
	assert.equal(site.generations?.at(-1)?.conversationId, conversation);
	assert.equal(site.phase, "generating");
});

test("M4: deleting a conversation withdraws its queued change", async () => {
	const site = fixture("queue-delete");
	platform.runStatus = () => "running";
	await sendMessage(site, "Change the headline");
	const other = await sendMessage(site, "Start a new page", null);
	assert.ok(other && other !== site.conversationId);
	assert.equal(site.queuedChange?.conversationId, other);
	const { deleteConversation } = await import("../lib/store");
	assert.equal(await deleteConversation(site, other), "busy");
	// A failed change keeps its queued follow-up waiting, visible to the owner.
	platform.runStatus = () => "failed";
	await tick(check, null);
	assert.equal(site.phase, "failed");
	assert.equal(site.queuedChange?.conversationId, other);
	await tick(check, null);
	assert.equal(site.generations?.length, 1, "it does not start over a failure");
	assert.equal(await deleteConversation(site, other), "deleted");
	assert.equal(site.queuedChange, undefined);
});

test("M4: a queued request that cannot start stays visible with its retry", async () => {
	const site = fixture("queue-refused");
	platform.runStatus = () => "running";
	await sendMessage(site, "Change the headline");
	await sendMessage(site, "Also add our prices");
	platform.runStatus = () => "completed";
	await tick(check, null);
	await tick(check, null);
	assert.equal(site.phase, "idle");
	// The website service refuses the queued request outright.
	platform.admission = () => new HopliteError(503, "service_unavailable");
	platform.runStatus = () => "running";
	await tick(check, null);
	assert.equal(site.queuedChange, undefined);
	assert.equal(site.phase, "failed");
	assert.equal(site.generations?.at(-1)?.prompt, "Also add our prices");
	assert.ok(
		site.messages.some(
			(message) =>
				message.role === "user" && message.content === "Also add our prices",
		),
		"the owner's queued words remain in the conversation",
	);
	platform.admission = () => undefined;
	await retryGeneration(site);
	assert.equal(site.phase, "generating");
	assert.equal(site.generations?.at(-1)?.prompt, "Also add our prices");
});

test("M5: a change without progress is shown honestly and can be retried or stopped", async () => {
	const { progressLabel, stallLevel } = await import("../lib/progress");
	const site = fixture("stall");
	platform.runStatus = () => "running";
	let messages = [
		{ id: "m1", content: "[studio-status]Writing the page[/studio-status]" },
	];
	platform.runMessages = () => messages;
	await sendMessage(site, "Add a team page");
	await tick(check, null);
	assert.equal(stallLevel(site), undefined);
	await assert.rejects(service.stopChange(site), /still making progress/);
	// Nothing new for five minutes: honest wording, no invented progress.
	site.progressAt = new Date(Date.now() - 5 * 60_000).toISOString();
	await tick(check, null);
	assert.equal(stallLevel(site), "slow");
	assert.equal(
		progressLabel({ ...site, stall: stallLevel(site) }),
		"Still working — this is taking longer than usual…",
	);
	// A new update counts as progress again.
	messages = [...messages, { id: "m2", content: "More work" }];
	await tick(check, null);
	assert.equal(stallLevel(site), undefined);
	// After the generous deadline the owner may start again from the last
	// ready version, in a fresh thread.
	site.progressAt = new Date(Date.now() - stalledAfterMs - 1000).toISOString();
	assert.equal(stallLevel(site), "stalled");
	const stalledRun = site.runId;
	const admissions = platform.admissions.length;
	await retryGeneration(site);
	assert.equal(platform.admissions.length, admissions + 1);
	assert.ok(
		platform.admissions.at(-1)?.body &&
			"sourceId" in (platform.admissions.at(-1)?.body as object),
		"a fresh thread from the ready version",
	);
	assert.notEqual(site.runId, stalledRun);
	assert.equal(site.generations?.at(-2)?.status, "failed");
	assert.equal(
		site.activeVersionId,
		"ready-stall",
		"the ready version is kept",
	);
	// Or stop it outright.
	site.progressAt = new Date(Date.now() - stalledAfterMs - 1000).toISOString();
	await service.stopChange(site);
	assert.equal(site.phase, "idle");
	assert.equal(site.error, undefined);
	assert.ok(
		capturedLogs.some((line) => line.event === "generation.run.stalled"),
	);
});

test("B1: a paused preview restarts only on owner activity, throttled; an explicit wake always starts it", async () => {
	const site = fixture("wake");
	let starts = 0;
	let ready = true;
	platform.startPreview = async () => {
		starts++;
		if (!ready) throw new HopliteError(503, "preview_unavailable");
	};
	const { previewWakeIntervalMs, wakePreview, wakingPreview, previewState } =
		service;
	assert.equal(wakingPreview(site.id), false);
	// Owner activity wakes it once; more activity within 20 seconds does not.
	await wakePreview(site);
	assert.equal(starts, 1);
	assert.equal(previewState(site.id), "waking");
	assert.equal(wakingPreview(site.id), true);
	await wakePreview(site);
	await wakePreview(site);
	assert.equal(starts, 1, "owner wakes are throttled to one per 20 seconds");
	// The "Wake preview" button is explicit and always starts it.
	await wakePreview(site, true);
	assert.equal(starts, 2);
	// A wake that fails leaves the preview paused, not "waking" forever.
	ready = false;
	await wakePreview(site, true);
	assert.equal(starts, 3);
	assert.equal(previewState(site.id), "paused");
	assert.equal(wakingPreview(site.id), false);
	assert.ok(capturedLogs.some((line) => line.event === "preview.wake.failed"));
	assert.equal(previewWakeIntervalMs, 20_000);
	// Background processing and state reads never wake it.
	await tick(check, null);
	assert.equal(starts, 3);
});

test("9: a request that changes nothing gets a reply but no new version", async () => {
	const site = fixture("no-change");
	platform.resultSource = () => "ready-source-no-change";
	await sendMessage(site, "Add a Google Analytics tracker");
	await tick(check, null);
	assert.equal(site.phase, "idle");
	assert.equal(site.versions.length, 1, "no new version");
	assert.equal(site.generations?.at(-1)?.status, "ready");
	assert.ok(site.messages.some((message) => message.role === "assistant"));
	// Identical files under a new source identity are also no change.
	const again = fixture("no-change-files");
	await mkdir(join(root, "versions", "ready-no-change-files"), {
		recursive: true,
	});
	await writeFile(
		join(root, "versions", "ready-no-change-files", "source.json"),
		JSON.stringify({ files: seed }),
	);
	await sendMessage(again, "Change Tuesday's hours");
	await tick(check, null);
	assert.equal(again.versions.length, 1);
	assert.equal(again.phase, "idle");
	// The agent is told to do only what was asked and to leave files alone
	// when declining or pointing to Business details.
	const prompt = again.generations?.at(-1)?.attempts[0]?.requestPrompt ?? "";
	assert.match(prompt, /Only make the changes the customer asked for/);
	assert.match(prompt, /set for each day of the week/);
	assert.match(prompt, /choose a service, a day and a time/);
	assert.match(prompt, /sticky booking bar must never cover the hero/);
	assert.match(prompt, /must not look like interface icons/);
	assert.match(prompt, /\[data-team\] as a responsive grid/);
});

test("quick check: findings on a first candidate get one repair with the evidence, never a gate", async () => {
	const site = fixture("quick");
	const calls: string[] = [];
	const finding =
		"Home page at 390px: color-contrast (Elements must meet minimum color contrast ratio thresholds) on .hero a. Element has insufficient color contrast of 2.9";
	const quick = async (
		_siteId: string,
		versionId: string,
	): Promise<QuickCheckResult> => {
		calls.push(versionId);
		return {
			issues: [finding],
			bookingStyle: {
				background: "rgb(20, 60, 40)",
				color: "rgb(255, 255, 255)",
			},
		};
	};
	await sendMessage(site, "Make it feel premium");
	await tick(check, quick);
	await tick(check, quick);
	const first = site.versions.at(-1);
	assert.ok(first);
	assert.equal(calls.length, 1, "the quick check ran after the build");
	assert.equal(first.failure?.advisory, true);
	assert.equal(site.phase, "generating", "one repair was scheduled");
	const repair = platform.admissions.at(-1)?.body as { content?: string };
	assert.match(repair.content ?? "", /insufficient color contrast of 2\.9/);
	assert.match(repair.content ?? "", /repair 1 of 2/);
	assert.deepEqual(first.bookingStyle, {
		background: "rgb(20 60 40)",
		color: "rgb(255 255 255)",
	});
	// The repaired candidate still has findings: it is ready anyway.
	await tick(check, quick);
	await tick(check, quick);
	const repaired = site.versions.at(-1);
	assert.ok(repaired && repaired !== first);
	assert.equal(site.phase, "idle");
	assert.equal(site.activeVersionId, repaired.id);
	assert.deepEqual(repaired.qa?.warnings, [finding]);
	assert.equal(
		site.generations?.at(-1)?.attempts.length,
		2,
		"the last repair is kept",
	);
});

test("quick check: a failed repair falls back to the checked candidate; a failing check is skipped", async () => {
	const site = fixture("quick-fallback");
	const quick = async (): Promise<QuickCheckResult> => ({
		issues: ["Home page at 1440px: color-contrast on .cta"],
	});
	await sendMessage(site, "Add a banner");
	await tick(check, quick);
	await tick(check, quick);
	const first = site.versions.at(-1);
	assert.equal(first?.failure?.advisory, true);
	// The repair run itself fails on the platform.
	platform.runStatus = () => "failed";
	await tick(check, quick);
	assert.equal(site.phase, "idle", "the change still succeeds");
	assert.equal(site.activeVersionId, first?.id);
	assert.equal(first?.failure, undefined);
	assert.equal(site.restartFromReady, true);
	assert.equal(site.generations?.at(-1)?.status, "ready");
	// The next change starts a fresh thread from that ready version.
	platform.runStatus = () => "running";
	await sendMessage(site, "Change the headline");
	assert.equal(site.restartFromReady, undefined);
	assert.ok(
		"sourceId" in (platform.admissions.at(-1)?.body as object),
		"a fresh thread",
	);

	const broken = fixture("quick-error");
	await sendMessage(broken, "Add a gallery");
	await tick(check, async () => {
		throw new Error("Chrome is not installed");
	});
	await tick(check, async () => {
		throw new Error("Chrome is not installed");
	});
	assert.equal(broken.phase, "idle", "a quick check that errors never blocks");
	assert.equal(broken.activeVersionId, broken.versions.at(-1)?.id);
	assert.ok(
		capturedLogs.some(
			(line) =>
				line.event === "quick_check.run.failed" &&
				line.error === "Chrome is not installed",
		),
	);
});
