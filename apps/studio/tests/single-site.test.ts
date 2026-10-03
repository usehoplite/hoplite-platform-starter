import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { JsonValue, Site } from "../lib/types";

test("onboarding creates one website with one Platform app, and every conversation edits it", async () => {
	const root = await mkdtemp(join(tmpdir(), "studio-single-site-"));
	process.env.STUDIO_DATA_DIR = root;
	delete process.env.STUDIO_STARTER_IMAGE;
	const { database, deleteConversation, organisationSite } = await import(
		"../lib/store"
	);
	const { createSite, hoplite, retryGeneration, sendMessage, WebsiteExists } =
		await import("../lib/service");
	const db = await database();
	assert.equal(organisationSite(db), undefined, "first visit shows onboarding");
	Object.defineProperty(hoplite, "configured", { value: true });
	const calls: { path: string; body?: JsonValue; key?: string }[] = [];
	let threads = 0;
	hoplite.json = async <T>(
		path: string,
		body?: JsonValue,
		key?: string,
	): Promise<T> => {
		calls.push({ path, body, key });
		if (path === "/api/platform/v1/apps")
			return { app: { id: "app-org" } } as T;
		if (path.endsWith("/sources")) return { source: { id: "seed" } } as T;
		if (path.endsWith("/threads")) {
			threads++;
			return {
				thread: { id: `thread-${threads}` },
				run: { id: `run-${threads}` },
			} as T;
		}
		if (path.endsWith("/messages") && body)
			return { run: { id: `run-message-${calls.length}` } } as T;
		throw new Error(`Unexpected request ${path}`);
	};
	function object(value: JsonValue | undefined) {
		assert.ok(value && typeof value === "object" && !Array.isArray(value));
		return value;
	}
	function finish(site: Site, sourceId: string) {
		const generation = site.generations?.at(-1);
		assert.ok(generation);
		generation.status = "ready";
		site.versions.push({
			id: sourceId,
			sourceId,
			label: `Version ${site.versions.length + 1}`,
			createdAt: new Date().toISOString(),
			qa: { status: "passed", checks: [], errors: [], screenshots: [] },
		});
		site.activeVersionId = sourceId;
		site.sourceId = sourceId;
		site.phase = "idle";
	}
	try {
		// A failed first save must not leave an unsaved website blocking onboarding.
		await mkdir(join(root, "metadata.json.tmp"));
		await assert.rejects(createSite("Make a website"), /EISDIR/);
		assert.equal(organisationSite(db), undefined);
		assert.equal(db.sites.length, 0);
		assert.equal(calls.length, 0);
		await rm(join(root, "metadata.json.tmp"), { recursive: true });

		const site = await createSite("Make a website for my business.");
		assert.equal(db.siteId, site.id);
		assert.equal(organisationSite(db), site);
		assert.equal(site.name, db.business.name);
		const apps = calls.filter((call) => call.path === "/api/platform/v1/apps");
		assert.equal(apps.length, 1);
		const app = object(apps[0].body);
		assert.equal(app.externalId, site.id, "the app is found again by site id");
		assert.equal(apps[0].key, `studio-app-${site.id}`);
		assert.equal(app.defaultModel, "claude-opus-5-5");
		assert.equal(app.idleTimeoutMinutes, 20);
		const [first] = site.conversations ?? [];
		assert.ok(first);
		assert.equal(first.title, "Make a website for my business.");
		assert.equal(first.threadId, "thread-1");
		assert.equal(site.conversationId, first.id);
		assert.equal(site.messages[0].conversationId, first.id);

		// A repeated onboarding request cannot create a second website.
		await assert.rejects(createSite("Make another website"), WebsiteExists);
		assert.equal(db.sites.length, 1);

		finish(site, "ready-1");
		await sendMessage(site, "Make the headline friendlier");
		assert.equal(
			calls.at(-1)?.path,
			"/api/platform/v1/apps/app-org/threads/thread-1/messages",
		);
		assert.equal(site.conversations?.length, 1);

		// A new conversation starts a thread in the same app from the ready draft.
		finish(site, "ready-2");
		await sendMessage(site, "Add our opening hours", null);
		const created = calls.at(-1);
		assert.equal(created?.path, "/api/platform/v1/apps/app-org/threads");
		assert.equal(object(created?.body).sourceId, "ready-2");
		assert.match(String(object(created?.body).prompt), /EDIT: Update this/);
		const second = site.conversations?.[1];
		assert.ok(second);
		assert.equal(second.threadId, "thread-2");
		assert.equal(site.conversationId, second.id);
		assert.equal(site.messages.at(-1)?.conversationId, second.id);

		// Returning to an earlier conversation edits the latest draft, not the
		// stale copy in its old workspace.
		finish(site, "ready-3");
		await sendMessage(site, "Change the colours", first.id);
		assert.equal(calls.at(-1)?.path, "/api/platform/v1/apps/app-org/threads");
		assert.equal(object(calls.at(-1)?.body).sourceId, "ready-3");
		assert.equal(first.threadId, "thread-3");
		assert.equal(site.threadId, "thread-3");
		assert.equal(site.conversations?.length, 2);
		assert.equal(
			calls.filter((call) => call.path === "/api/platform/v1/apps").length,
			1,
			"conversations never create another app",
		);

		// Deleting the conversation of a failed change moves its retry to a new one.
		finish(site, "ready-4");
		await sendMessage(site, "Add a gallery", second.id);
		const failed = site.generations?.at(-1);
		assert.ok(failed);
		failed.status = "failed";
		site.phase = "failed";
		assert.equal(await deleteConversation(site, second.id), "deleted");
		await assert.rejects(
			sendMessage(site, "Continue", second.id),
			/no longer available/,
		);
		await retryGeneration(site);
		const retried = site.conversations?.[2];
		assert.ok(retried);
		assert.equal(site.conversationId, retried.id);
		assert.equal(site.generations?.at(-1)?.prompt, "Add a gallery");
		assert.equal(site.activeVersionId, "ready-4");
		const saved = JSON.parse(
			await readFile(join(root, "metadata.json"), "utf8"),
		);
		assert.equal(saved.siteId, site.id);
		assert.equal(saved.sites.length, 1);
		assert.equal(saved.sites[0].conversations.length, 3);
		assert.ok(saved.sites[0].conversations[1].deletedAt);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
