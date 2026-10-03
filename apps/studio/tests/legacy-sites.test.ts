import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { business, type Site } from "../lib/types";

function legacySite(
	id: string,
	createdAt: string,
	extra: Partial<Site> = {},
): Site {
	return {
		id,
		name: `${id} website`,
		appId: `app-${id}`,
		threadId: `thread-${id}`,
		createdAt,
		updatedAt: createdAt,
		phase: "idle",
		messages: [
			{
				id: `${id}-request`,
				role: "user",
				content: `Make the ${id} website`,
				time: createdAt,
			},
			{
				id: `${id}-reply`,
				role: "assistant",
				content: "Your website is ready.",
				time: createdAt,
			},
		],
		versions: [],
		previewRevision: 0,
		...extra,
	};
}

test("metadata from the multi-website demo opens the most recent website and keeps the others", async () => {
	const root = await mkdtemp(join(tmpdir(), "studio-legacy-sites-"));
	process.env.STUDIO_DATA_DIR = root;
	await writeFile(
		join(root, "metadata.json"),
		JSON.stringify({
			business,
			sites: [
				// Edited most recently, but created first.
				legacySite("older", "2026-09-20T00:00:00Z", {
					updatedAt: "2026-09-26T00:00:00Z",
				}),
				legacySite("newest", "2026-09-24T00:00:00Z"),
				legacySite("removed", "2026-09-25T00:00:00Z", {
					deletedAt: "2026-09-25T01:00:00Z",
				}),
			],
		}),
	);
	const { database, organisationSite, siteConversations } = await import(
		"../lib/store"
	);
	const { createSite, hoplite, sendMessage } = await import("../lib/service");
	try {
		const db = await database();
		const site = organisationSite(db);
		assert.equal(site?.id, "newest");
		process.env.STUDIO_SITE_ID = "older";
		assert.equal(organisationSite(db)?.id, "older", "development override");
		delete process.env.STUDIO_SITE_ID;
		assert.ok(site);

		// Reading presents the saved chat as one conversation without rewriting it.
		const [conversation] = siteConversations(site);
		assert.equal(conversation.id, "legacy-newest");
		assert.equal(conversation.title, "Make the newest website");
		assert.equal(conversation.threadId, "thread-newest");
		assert.equal(site.conversations, undefined);

		Object.defineProperty(hoplite, "configured", { value: true });
		await assert.rejects(createSite("Another website"), /already exists/);
		assert.equal(db.sites.length, 3);

		const paths: string[] = [];
		hoplite.json = async <T>(path: string): Promise<T> => {
			paths.push(path);
			return { run: { id: "run-edit" } } as T;
		};
		await sendMessage(site, "Make the headline friendlier");
		assert.deepEqual(paths, [
			"/api/platform/v1/apps/app-newest/threads/thread-newest/messages",
		]);
		assert.equal(site.conversationId, "legacy-newest");
		assert.deepEqual(
			site.messages.map((message) => message.conversationId),
			["legacy-newest", "legacy-newest", "legacy-newest"],
		);
		const saved = JSON.parse(
			await readFile(join(root, "metadata.json"), "utf8"),
		);
		assert.equal(saved.sites.length, 3, "other websites stay saved");
		assert.equal(saved.sites[0].conversations, undefined);
		assert.equal(saved.sites[1].conversations[0].id, "legacy-newest");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
