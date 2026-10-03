import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Site } from "../lib/types";

test("conversation deletion persists and leaves the website, its drafts and releases in place", async () => {
	const root = await mkdtemp(join(tmpdir(), "studio-deletion-"));
	process.env.STUDIO_DATA_DIR = root;
	const { database, deleteConversation, findSite, save } = await import(
		"../lib/store"
	);
	try {
		const db = await database();
		const site: Site = {
			id: "website",
			name: "Harbour Studio",
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			phase: "idle",
			threadId: "thread-earlier",
			messages: [
				{
					id: "earlier",
					role: "user",
					content: "Make the headline warmer",
					time: new Date().toISOString(),
				},
			],
			previewRevision: 0,
			publishedVersionId: "published",
			versions: [
				{
					id: "published",
					sourceId: "source",
					label: "Live",
					createdAt: new Date().toISOString(),
					artifactDirectory: "retained-artifact",
				},
			],
		};
		db.sites.push(site);
		await save();
		await mkdir(join(root, "metadata.json.tmp"));
		await assert.rejects(save(), /EISDIR/);
		await rm(join(root, "metadata.json.tmp"), { recursive: true });
		site.name = "Saved after storage recovered";
		await save();
		assert.equal(
			JSON.parse(await readFile(join(root, "metadata.json"), "utf8")).sites[0]
				.name,
			site.name,
		);
		// Metadata from before conversations has one implicit conversation.
		const legacy = "legacy-website";
		for (const phase of ["generating", "building", "checking"] as const) {
			site.phase = phase;
			assert.equal(await deleteConversation(site, legacy), "busy");
			assert.equal(site.conversations, undefined);
		}
		site.phase = "idle";
		assert.equal(await deleteConversation(site, "missing"), "not-found");
		assert.equal(await deleteConversation(site, legacy), "deleted");
		const deletedAt = site.conversations?.[0].deletedAt;
		assert.ok(deletedAt);
		assert.equal(site.messages[0].conversationId, legacy);
		assert.equal(await deleteConversation(site, legacy), "deleted");
		assert.equal(
			site.conversations?.[0].deletedAt,
			deletedAt,
			"repeated deletion is idempotent",
		);
		assert.equal(await findSite(site.id), site, "the website remains");
		const persisted = JSON.parse(
			await readFile(join(root, "metadata.json"), "utf8"),
		);
		assert.equal(persisted.sites[0].conversations[0].deletedAt, deletedAt);
		assert.equal(persisted.sites[0].deletedAt, undefined);
		assert.equal(persisted.sites[0].threadId, "thread-earlier");
		assert.equal(persisted.sites[0].publishedVersionId, "published");
		assert.equal(
			persisted.sites[0].versions[0].artifactDirectory,
			"retained-artifact",
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
