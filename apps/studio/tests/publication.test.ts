import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { PublishIntent, Site, Version } from "../lib/types";

test("publication commits its audit atomically, rejects stale tabs and preserves idempotency across rollback and restart", async () => {
	const root = await mkdtemp(join(tmpdir(), "studio-publication-"));
	process.env.STUDIO_DATA_DIR = root;
	const { database, save, PublicationConflict } = await import("../lib/store");
	const { publish } = await import("../lib/service");
	const db = await database();
	const versions: Version[] = ["old", "first", "second"].map((id) => ({
		id,
		sourceId: `source-${id}`,
		label: id,
		createdAt: "2026-09-25",
		artifactDirectory: join(root, id),
		sourceChecked: true,
		qaReport: `qa/${id}.json`,
		qa: {
			status: "passed",
			checks: ["Booking works"],
			errors: [],
			screenshots: [],
		},
	}));
	const site: Site = {
		id: "site",
		name: "Original",
		createdAt: "2026-09-25",
		updatedAt: "2026-09-25",
		phase: "idle",
		messages: [],
		versions,
		activeVersionId: "second",
		publishedVersionId: "old",
		previewRevision: 0,
	};
	db.sites.push(site);
	await save();
	const metadata = join(root, "metadata.json");
	const first: PublishIntent = {
		id: "first-tab",
		action: "publish",
		expectedVersionId: "old",
	};
	const second: PublishIntent = {
		id: "second-tab",
		action: "publish",
		expectedVersionId: "old",
	};
	try {
		const publishing = publish(site, "first", first);
		assert.equal(
			site.publishedVersionId,
			"old",
			"Readers must retain the committed pointer while persistence is pending",
		);
		site.name = "Edited concurrently";
		const saving = save();
		const competing = publish(site, "second", second);
		const results = await Promise.allSettled([publishing, competing, saving]);
		assert.equal(results[0].status, "fulfilled");
		assert.equal(results[1].status, "rejected");
		if (results[1].status === "rejected")
			assert.ok(results[1].reason instanceof PublicationConflict);
		assert.equal(results[2].status, "fulfilled");
		assert.equal(site.publishedVersionId, "first");
		assert.equal(site.publications?.length, 1);
		let durable = JSON.parse(await readFile(metadata, "utf8")).sites[0];
		assert.equal(durable.publishedVersionId, "first");
		assert.equal(durable.name, "Edited concurrently");
		assert.deepEqual(durable.publications, site.publications);
		assert.equal(durable.publications[0].previousVersionId, "old");
		assert.equal(durable.publications[0].qaReport, "qa/first.json");
		assert.equal(durable.publications[0].actor, "Local demo member");
		await publish(site, "first", first);
		assert.equal(
			site.publications?.length,
			1,
			"A lost-response retry cannot create a second audit event",
		);
		await assert.rejects(publish(site, "second", first), /already used/);
		await publish(site, "old", {
			id: "restore-old",
			action: "rollback",
			expectedVersionId: "first",
		});
		assert.equal(site.publishedVersionId, "old");
		assert.equal(
			site.activeVersionId,
			"second",
			"Rollback must retain the working draft",
		);
		assert.equal(site.publications?.at(-1)?.action, "rollback");
		await publish(site, "first", first);
		assert.equal(
			site.publishedVersionId,
			"old",
			"Replaying an earlier publish cannot undo a later rollback",
		);
		assert.equal(site.publications?.length, 2);
		const before = await readFile(metadata, "utf8");
		await rename(metadata, `${metadata}.saved`);
		await mkdir(metadata);
		try {
			await assert.rejects(
				publish(site, "second", {
					id: "disk-failure",
					action: "publish",
					expectedVersionId: "old",
				}),
				/EISDIR|ENOTEMPTY/,
			);
			assert.equal(site.publishedVersionId, "old");
			assert.equal(
				site.publications?.length,
				2,
				"Failed persistence cannot leave a phantom publication",
			);
		} finally {
			await rm(metadata, { recursive: true });
			await rename(`${metadata}.saved`, metadata);
		}
		assert.equal(await readFile(metadata, "utf8"), before);
		site.name = "Still editable after a failed publication";
		await save();
		durable = JSON.parse(await readFile(metadata, "utf8")).sites[0];
		assert.equal(durable.publishedVersionId, "old");
		assert.equal(durable.publications.length, 2);
		assert.equal(durable.name, site.name);
		const restarted = spawnSync(
			process.execPath,
			[
				"--import",
				"tsx",
				"--input-type=module",
				"--eval",
				"const {database}=await import('./lib/store.ts');process.stdout.write(JSON.stringify((await database()).sites[0]));",
			],
			{
				cwd: process.cwd(),
				encoding: "utf8",
				env: process.env,
				timeout: 10_000,
			},
		);
		assert.equal(restarted.status, 0, restarted.stderr);
		assert.deepEqual(JSON.parse(restarted.stdout), durable);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
