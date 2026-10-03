import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Site } from "../lib/types";

// These tests exercise Site Studio's optional browser checks.
process.env.STUDIO_QA_CHECKS = "on";

test("agent-authored live status follows the current run and never leaks protocol into chat", async () => {
	const root = await mkdtemp(join(tmpdir(), "studio-progress-"));
	process.env.STUDIO_DATA_DIR = root;
	const { database } = await import("../lib/store");
	const { hoplite, tick } = await import("../lib/service");
	const original = hoplite.json;
	const db = await database();
	const site: Site = {
		id: "site",
		appId: "app",
		name: "Test",
		createdAt: "2026-09-23",
		updatedAt: "2026-09-23",
		threadId: "thread",
		runId: "current",
		phase: "generating",
		messages: [],
		versions: [],
		previewRevision: 0,
	};
	db.sites.push(site);
	let content = "[studio-sta";
	let oldContent = "[studio-status]Old request[/studio-status]";
	let runStatus = "running";
	let history = false;
	hoplite.json = async <T>(path: string): Promise<T> => {
		if (path.endsWith("/runs/current"))
			return { run: { status: runStatus } } as T;
		if (history) {
			const older = path.includes("?cursor=");
			if (older) {
				const cursor = JSON.parse(
					Buffer.from(
						new URL(path, "http://test").searchParams.get("cursor") ?? "",
						"base64url",
					).toString(),
				);
				assert.equal(cursor.id, "page-0");
			}
			return {
				hasMore: !older,
				messages: older
					? [
							{
								id: "oldest",
								role: "assistant",
								content: "Before the first 500",
								createdAt: "2026-01-01T00:00:00Z",
							},
						]
					: Array.from({ length: 500 }, (_, i) => ({
							id: `page-${i}`,
							role: "assistant",
							content: `Message ${i}`,
							createdAt: new Date(Date.UTC(2026, 1, 1, 0, 0, i)).toISOString(),
						})),
			} as T;
		}
		assert.equal(path, "/api/platform/v1/apps/app/threads/thread/messages");
		return {
			messages: [
				{ id: "old", role: "assistant", runId: "old", content: oldContent },
				{ id: "live", role: "assistant", runId: "current", content },
			],
		} as T;
	};
	try {
		await tick();
		assert.equal(Object.hasOwn(site, "activity"), false);
		assert.equal(site.messages.length, 0);
		content = "[studio-status]Matching your seaside colours[/studio-status]";
		await tick();
		assert.deepEqual(site.activity, {
			runId: "current",
			text: "Matching your seaside colours",
		});
		assert.equal(site.messages.length, 0);
		content +=
			"\n[studio-status]Making sure your booking link opens[/studio-status]\nYour colours are now";
		await tick();
		assert.equal(site.activity?.text, "Making sure your booking link opens");
		assert.equal(site.messages[0].content, "Your colours are now");
		content += " ready.";
		await tick();
		assert.equal(site.messages.length, 1);
		assert.equal(site.messages[0].content, "Your colours are now ready.");
		assert.equal(site.messages[0].runId, "current");
		// Removing a status marker never joins the sentences around it.
		content = `Checking the colours.[studio-status]${"y".repeat(101)}[/studio-status]Your colours are ready.`;
		await tick();
		assert.equal(
			site.messages[0].content,
			"Checking the colours.\n\nYour colours are ready.",
		);
		content = `[studio-status]${"x".repeat(101)}[/studio-status]`;
		await tick();
		assert.equal(site.activity?.text, "Making sure your booking link opens");
		oldContent =
			"[studio-status]A late update from the old run[/studio-status]";
		content = "";
		await tick();
		assert.equal(site.activity?.text, "Making sure your booking link opens");
		const persisted = JSON.parse(
			await readFile(join(root, "metadata.json"), "utf8"),
		);
		assert.equal(persisted.sites[0].activity.runId, "current");
		history = true;
		await tick();
		assert.equal(
			site.messages.some((m) => m.id === "oldest"),
			true,
		);
		assert.equal(
			site.messages.some((m) => m.id === "page-499"),
			true,
		);
		assert.equal(site.messages[0].id, "oldest");
		history = false;
		runStatus = "failed";
		await tick();
		assert.equal(
			site.phase,
			"failed",
			"terminal runs stop rendering the busy status",
		);
	} finally {
		hoplite.json = original;
		await rm(root, { recursive: true, force: true });
	}
});
