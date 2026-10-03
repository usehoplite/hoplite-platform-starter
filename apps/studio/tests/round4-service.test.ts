import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { c as archive } from "tar";
import { HopliteError } from "../lib/hoplite";
import { capturedLogs } from "../lib/log";
import type { QuickCheckResult } from "../lib/qa";
import { sha256 } from "../lib/safety";
import {
	business,
	type JsonValue,
	type Site,
	type Version,
} from "../lib/types";

// Round 4 service behaviour: honest replies, versions numbered as the owner
// sees them, reliable wake, archived previews shown as paused, and business
// facts confirmed from chat. Browser checks stay off.
delete process.env.STUDIO_QA_CHECKS;
const root = await mkdtemp(join(tmpdir(), "studio-round4-"));
process.env.STUDIO_DATA_DIR = root;
after(() => rm(root, { recursive: true, force: true }));

const { database } = await import("../lib/store");
const service = await import("../lib/service");
const { hoplite, tick, sendMessage, seedFiles } = service;
service.previewWakeTiming.retryDelayMs = 1;
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

const platform = {
	calls: [] as string[],
	reply: (_runId: string) => "Your home page has a new headline.",
	resultSource: (runId: string) => `source-${runId}`,
	buildStatus: () => "ready",
	activity: (): Error | undefined => undefined,
	start: (): Error | "stopped" | undefined => undefined,
	workspaceStatus: "ready",
};
let current: Site;
hoplite.json = async <T>(
	path: string,
	body?: JsonValue,
	operationId?: string,
): Promise<T> => {
	platform.calls.push(path);
	if (
		(path.endsWith("/threads") || path.endsWith("/messages")) &&
		body !== undefined
	)
		return {
			thread: { id: `thread-${current.id}` },
			run: { id: `run-${operationId}` },
		} as T;
	if (path.includes("/runs/")) {
		const runId = path.split("/").at(-1) ?? "";
		return {
			run: {
				status: "completed",
				resultSourceId: platform.resultSource(runId),
			},
		} as T;
	}
	if (path.endsWith("/messages"))
		return {
			messages: [
				{
					id: `reply-${current.runId}`,
					role: "assistant",
					runId: current.runId,
					content: platform.reply(current.runId ?? ""),
				},
			],
		} as T;
	if (path.endsWith("/files")) return { files: seed } as T;
	if (path.endsWith("/workspace/activity")) {
		const refused = platform.activity();
		if (refused) throw refused;
		return { ok: true } as T;
	}
	if (path.endsWith("/workspace/policy"))
		return { policy: { workspaceStatus: platform.workspaceStatus } } as T;
	if (path.endsWith("/preview/start")) {
		const refused = platform.start();
		if (refused instanceof Error) throw refused;
		return {
			preview:
				refused === "stopped"
					? { status: "stopped" }
					: {
							status: "ready",
							url: "https://preview.example",
							gateway: {
								token: "test",
								header: "x-preview",
								expiresAt: new Date(Date.now() + 60000).toISOString(),
							},
						},
		} as T;
	}
	if (path.endsWith("/builds") && body !== undefined)
		return { build: { id: `build-${operationId}` } } as T;
	if (path.endsWith("/manifest"))
		return {
			files: [{ path: "index.html", sha256: sha256(html), size: html.length }],
		} as T;
	if (path.includes("/builds/")) {
		const status = platform.buildStatus();
		return {
			build:
				status === "ready"
					? { status, artifactSha256: sha256(artifact) }
					: { status, error: "build_infrastructure_unavailable" },
		} as T;
	}
	throw new Error(`Unexpected API call: ${path}`);
};
hoplite.response = async (path) =>
	path.endsWith("/artifact") ? new Response(artifact) : new Response("log");
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
function fixture(id: string, versions = true): Site {
	platform.calls = [];
	platform.reply = () => "Your home page has a new headline.";
	platform.resultSource = (runId) => `source-${runId}`;
	platform.buildStatus = () => "ready";
	platform.activity = () => undefined;
	platform.start = () => undefined;
	platform.workspaceStatus = "ready";
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
		versions: versions ? [ready] : [],
		activeVersionId: versions ? ready.id : undefined,
		sourceId: versions ? ready.sourceId : undefined,
		previewRevision: 0,
	};
	db.sites = [current];
	db.business = structuredClone(business);
	return current;
}

test("8: a quick-check repair keeps the owner's version number", async () => {
	const site = fixture("numbering");
	let findings = ["Home page at 390px: color-contrast on .cta"];
	const quick = async (): Promise<QuickCheckResult> => ({ issues: findings });
	await sendMessage(site, "Make it feel premium");
	await tick(check, quick);
	await tick(check, quick);
	assert.equal(site.versions.at(-1)?.label, "Version 2");
	assert.equal(site.phase, "generating", "one repair was scheduled");
	findings = [];
	await tick(check, quick);
	await tick(check, quick);
	assert.equal(site.phase, "idle");
	assert.deepEqual(
		site.versions.map((version) => version.label),
		["Version 1", "Version 2", "Version 2"],
		"the repair replaces the candidate under the same number",
	);
	assert.equal(service.nextVersionLabel(site, "another-change"), "Version 3");
});

test("quick check scans every generated page and the booking page", async () => {
	const site = fixture("every-page");
	const scanned: string[][] = [];
	await sendMessage(site, "Add a team page");
	const quick = async (
		_site: string,
		_version: string,
		routes: string[],
	): Promise<QuickCheckResult> => {
		scanned.push(routes);
		return { issues: [] };
	};
	await tick(check, quick);
	await tick(check, quick);
	assert.equal(site.phase, "idle");
	assert.deepEqual(scanned, [["/", "/book"]]);
});

test("decision b: a stated business fact becomes a confirmation, never raw text, and confirming saves it", async () => {
	const site = fixture("facts");
	platform.resultSource = () => "ready-source-facts";
	platform.reply = () =>
		'I’ve prepared your new hours for you to confirm.\n\n```studio-business\n{"weeklyHours":{"mon":null}}\n```';
	await sendMessage(site, "we're closed on Mondays");
	await tick(check, null);
	assert.equal(site.phase, "idle");
	assert.equal(site.versions.length, 1, "data-only changes make no version");
	const proposal = site.businessProposal;
	assert.ok(proposal);
	assert.equal(proposal.title, "Update your opening hours");
	assert.deepEqual(proposal.changes, ["Monday → Closed"]);
	assert.equal(proposal.conversationId, site.conversationId);
	const reply = site.messages.find((message) => message.role === "assistant");
	assert.equal(
		reply?.content,
		"I’ve prepared your new hours for you to confirm.",
	);
	assert.doesNotMatch(
		JSON.stringify(site.messages),
		/studio-business|weeklyHours/,
	);
	const before = db.business.hours;
	// The owner edits Business details while the card is showing: nothing is
	// saved from the stale card; it is refreshed and confirmed again.
	db.business = { ...db.business, phone: "+353 91 555 0000" };
	await assert.rejects(
		service.resolveBusinessProposal(site, proposal.id, "apply"),
		/changed since this was suggested/,
	);
	assert.equal(db.business.hours, before);
	assert.equal(db.business.phone, "+353 91 555 0000");
	assert.deepEqual(site.businessProposal?.changes, ["Monday → Closed"]);
	await service.resolveBusinessProposal(site, proposal.id, "apply");
	assert.equal(db.business.phone, "+353 91 555 0000", "the newer edit stays");
	assert.equal(site.businessProposal, undefined);
	assert.notEqual(db.business.hours, before);
	assert.equal(db.business.weeklyHours?.mon, undefined);
	assert.equal(db.business.hours, "Tue–Fri 07:00–20:00 · Sat 09:00–14:00");
	const saved = JSON.parse(await readFile(join(root, "metadata.json"), "utf8"));
	assert.equal(saved.business.hours, db.business.hours);
	// Answering an old or unknown suggestion changes nothing.
	await assert.rejects(
		service.resolveBusinessProposal(site, proposal.id, "apply"),
		/no longer available/,
	);

	// An invalid proposal is dropped and logged; the reply still shows.
	const invalid = fixture("facts-invalid");
	platform.resultSource = () => "ready-source-facts-invalid";
	platform.reply = () =>
		'Here you go.\n```studio-business\n{"weeklyHours":{"mon":{"open":"18:00","close":"09:00"}}}\n```';
	await sendMessage(invalid, "we open at 6pm and close at 9am on Mondays");
	await tick(check, null);
	assert.equal(invalid.businessProposal, undefined);
	assert.ok(
		capturedLogs.some((line) => line.event === "business.proposal.rejected"),
	);

	// "Not now" discards it.
	const dismissed = fixture("facts-dismiss");
	platform.resultSource = () => "ready-source-facts-dismiss";
	platform.reply = () =>
		'Ready to confirm.\n```studio-business\n{"phone":"+353 91 555 0199"}\n```';
	await sendMessage(dismissed, "our new number is 091 555 0199");
	await tick(check, null);
	const pending = dismissed.businessProposal;
	assert.ok(pending);
	await service.resolveBusinessProposal(dismissed, pending.id, "dismiss");
	assert.equal(dismissed.businessProposal, undefined);
	assert.equal(db.business.phone, business.phone);
	// The agent is told how to propose, and that the sandbox has no network.
	const prompt =
		dismissed.generations?.at(-1)?.attempts[0]?.requestPrompt ?? "";
	assert.match(prompt, /```studio-business/);
	assert.match(prompt, /never guess a price, time or other detail/);
});

test("M4: the controlled starter tells the agent there is no network and never to install", async () => {
	const site = fixture("offline");
	site.starterVersion = "2";
	site.foundationRevision = 4;
	platform.resultSource = () => "ready-source-offline";
	await sendMessage(site, "Add a gallery");
	const prompt = site.generations?.at(-1)?.attempts[0]?.requestPrompt ?? "";
	assert.match(prompt, /no internet access/);
	assert.match(prompt, /Never run npm, npx, pnpm, yarn/);
	assert.match(prompt, /data-count/);
	assert.match(prompt, /auto-fit, never auto-fill/);
});

test("polish: a conversation is named after its latest change", async () => {
	const site = fixture("titles");
	platform.resultSource = () => "ready-source-titles";
	await sendMessage(site, "Add a team page");
	await tick(check, null);
	const conversation = site.conversations?.find(
		(item) => item.id === site.conversationId,
	);
	assert.equal(conversation?.title, "Add a team page");
	await sendMessage(site, "Make the text bigger", conversation?.id);
	assert.equal(conversation?.title, "Make the text bigger");
});

test("M3 iii: a wake renews the idle deadline first and retries once when the archive is still finishing", async () => {
	const site = fixture("wake");
	const { wakePreview, previewState } = service;
	let refusals = 1;
	platform.start = () =>
		refusals-- > 0
			? new HopliteError(503, "source_workspace_unavailable")
			: undefined;
	await wakePreview(site, true);
	const order = platform.calls.filter(
		(path) =>
			path.endsWith("/workspace/activity") || path.endsWith("/preview/start"),
	);
	assert.deepEqual(
		order.map((path) => path.split("/").at(-1)),
		["activity", "start", "activity", "start"],
		"renewed before each restore, retried once",
	);
	assert.equal(previewState(site.id), "live");
	// Renewal refused while archiving finishes: it is retried before starting.
	const archiving = fixture("wake-archiving");
	let busy = 2;
	platform.activity = () =>
		busy-- > 0
			? new HopliteError(503, "source_workspace_unavailable")
			: undefined;
	await wakePreview(archiving, true);
	assert.deepEqual(
		platform.calls
			.filter(
				(path) =>
					path.endsWith("/workspace/activity") ||
					path.endsWith("/preview/start"),
			)
			.map((path) => path.split("/").at(-1)),
		["activity", "activity", "activity", "start"],
	);
	assert.equal(previewState(archiving.id), "live");
	// A lost renewal answer is retried under a fresh identity.
	const lost = fixture("wake-lost");
	platform.activity = () => new HopliteError(409, "operation_outcome_unknown");
	await service.recordWorkspaceActivity(lost).catch(() => undefined);
	const first = lost.workspaceActivity?.id;
	assert.ok(first);
	await service.recordWorkspaceActivity(lost).catch(() => undefined);
	assert.notEqual(lost.workspaceActivity?.id, first);
});

test("polish: no wake (and no failure logged) before the first website exists", async () => {
	const site = fixture("first", false);
	site.phase = "generating";
	const logged = capturedLogs.length;
	await service.wakePreview(site, true);
	assert.equal(
		platform.calls.filter((path) => path.endsWith("/preview/start")).length,
		0,
	);
	assert.equal(
		capturedLogs
			.slice(logged)
			.filter((line) => line.event === "preview.wake.failed").length,
		0,
	);
});

test("M3 i: an archived workspace shows as paused while the tab sits open", async () => {
	const site = fixture("archived");
	service.notePreviewState(site.id, "live");
	service.grants.set(site.id, {
		url: "https://preview.example",
		token: "t",
		header: "x",
		expiresAt: Date.now() + 60_000,
	});
	platform.workspaceStatus = "archived";
	// Background ticks read the state only every so often, never at once.
	await tick(check, null);
	assert.equal(service.previewState(site.id), "live");
	await service.checkWorkspaceState(site, true);
	assert.equal(service.previewState(site.id), "paused");
	assert.equal(service.grants.has(site.id), false);
	assert.ok(
		!platform.calls.some(
			(path) =>
				path.endsWith("/preview/start") || path.endsWith("/workspace/activity"),
		),
		"reading the state never wakes or renews it",
	);
	// A ready workspace is left as it is.
	const ready = fixture("not-archived");
	service.notePreviewState(ready.id, "live");
	await service.checkWorkspaceState(ready, true);
	assert.equal(service.previewState(ready.id), "live");
});

test("M3 ii and polish: Try again clears the old failure at once, and a ready version refreshes a paused preview", async () => {
	const site = fixture("retry");
	platform.buildStatus = () => "failed";
	await sendMessage(site, "Add a banner");
	await tick(check, null);
	await tick(check, null);
	assert.equal(site.phase, "failed");
	assert.ok(site.error);
	// The workspace was archived while the owner was away.
	service.notePreviewState(site.id, "paused");
	platform.buildStatus = () => "ready";
	const revision = site.previewRevision;
	let seenError: string | undefined = "unset";
	// Records the error the owner sees while the retry restarts the preview.
	platform.start = () => {
		seenError = site.error;
		return seenError ? new Error("the old failure was still shown") : undefined;
	};
	platform.calls = [];
	await service.retryGeneration(site);
	const restart = platform.calls.filter(
		(path) =>
			path.endsWith("/workspace/activity") || path.endsWith("/preview/start"),
	);
	assert.deepEqual(
		restart.slice(0, 2).map((path) => path.split("/").at(-1)),
		["activity", "start"],
		"the retry renews the idle deadline before restoring the preview",
	);
	assert.equal(
		seenError,
		undefined,
		"the old message is gone while it rebuilds",
	);
	// The retry itself counts as the owner waking the preview.
	assert.equal(service.wakingPreview(site.id), true);
	service.notePreviewState(site.id, "paused");
	await tick(check, null);
	assert.equal(site.phase, "idle");
	assert.ok(site.previewRevision > revision, "the frame refreshes");
	for (let i = 0; i < 100 && service.previewState(site.id) !== "live"; i++)
		await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(service.previewState(site.id), "live", "and the preview wakes");
});
