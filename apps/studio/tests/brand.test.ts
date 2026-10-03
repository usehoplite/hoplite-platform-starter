import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { VisualBrief } from "../lib/brand-scan";
import type { SourceFile } from "../lib/hoplite";
import { bytes, sha256, sourceGates } from "../lib/safety";

test("approved references persist and only selected immutable assets enter each website's source and prompt", async () => {
	const root = await mkdtemp(join(tmpdir(), "studio-brand-"));
	process.env.STUDIO_DATA_DIR = root;
	process.env.STUDIO_STARTER_IMAGE = "im-starter-fixture";
	const { database, save } = await import("../lib/store");
	const { releaseStorage } = await import("../lib/release-storage");
	const { approveBrand, brandState } = await import("../lib/brand");
	const { createSite, seedFiles, hoplite, sendMessage } = await import(
		"../lib/service"
	);
	try {
		const images = [
			Buffer.from("approved image A"),
			Buffer.from("approved image B"),
		];
		const brief: VisualBrief = {
			id: "fixture-reference",
			sourceUrl: "https://brand.example/",
			capturedAt: new Date().toISOString(),
			title: "Brand",
			palette: [{ color: "rgb(200, 100, 20)", samples: 10 }],
			typography: [],
			layout: {
				sections: 3,
				contentWidth: 1100,
				viewport: { width: 1440, height: 900 },
				headingExamples: ["A warm welcome"],
			},
			warnings: [],
			assets: images.map((body, index) => ({
				id: sha256(body),
				path: `assets/${sha256(body)}.png`,
				sha256: sha256(body),
				sourceUrl: `https://brand.example/image-${index}.png`,
				label: `Image ${index}`,
				width: 100,
				height: 100,
			})),
		};
		await releaseStorage.saveBrand(brief.id, [
			{ path: "visual-brief.json", body: Buffer.from(JSON.stringify(brief)) },
			...brief.assets.map((asset, index) => ({
				path: asset.path,
				body: images[index],
			})),
		]);
		const db = await database();
		db.brandImports = [
			{ id: brief.id, sourceUrl: brief.sourceUrl, createdAt: brief.capturedAt },
		];
		assert.equal((await brandState()).selected, null);
		const first = await approveBrand(brief.id, [brief.assets[0].id]);
		await assert.rejects(
			approveBrand(brief.id, ["not-from-this-import"]),
			/Choose assets/,
		);
		assert.equal(db.brandReferenceId, first.id);
		Object.defineProperty(hoplite, "configured", { value: true });
		const sources: SourceFile[][] = [];
		const prompts: string[] = [];
		hoplite.json = async <T>(
			path: string,
			body?: { files?: SourceFile[]; prompt?: string; externalId?: string },
		): Promise<T> => {
			if (path === "/api/platform/v1/apps")
				return { app: { id: `app-${body?.externalId}` } } as T;
			if (path.endsWith("/sources")) {
				assert.ok(body?.files);
				sources.push(body.files);
				return { source: { id: `source-${sources.length}` } } as T;
			}
			assert.ok(path.endsWith("/threads"), path);
			assert.ok(body?.prompt);
			prompts.push(body.prompt);
			return {
				thread: { id: `thread-${sources.length}` },
				run: { id: `run-${sources.length}` },
			} as T;
		};
		const siteA = await createSite(
			"Create a site with our saved visual reference",
		);
		assert.equal(siteA.brandReferenceId, first.id);
		assert.equal(
			sources[0].filter((file) => file.path.startsWith("public/brand-assets/"))
				.length,
			1,
		);
		assert.ok(
			sources[0].some(
				(file) => file.path === `public/brand-assets/${brief.assets[0].id}.png`,
			),
		);
		assert.ok(prompts[0].includes(brief.assets[0].id));
		assert.ok(!prompts[0].includes(brief.assets[1].id));
		assert.ok(prompts[0].includes("rgb(200, 100, 20)"));
		assert.ok(
			!prompts[0].includes("https://brand.example/image-"),
			"Generation must receive local asset references, not hotlinks",
		);
		// Prompt preparation reads immutable brand data asynchronously. Another
		// request may save metadata during that read, before admission reaches Hoplite.
		siteA.phase = "failed";
		assert.ok(siteA.generations?.[0]);
		siteA.generations[0].status = "failed";
		const readBrand = releaseStorage.readBrand.bind(releaseStorage);
		let releasePrompt!: () => void;
		let promptEntered!: () => void;
		const entered = new Promise<void>((resolve) => {
			promptEntered = resolve;
		});
		const blocked = new Promise<void>((resolve) => {
			releasePrompt = resolve;
		});
		releaseStorage.readBrand = async (...args) => {
			promptEntered();
			await blocked;
			return readBrand(...args);
		};
		const retry = sendMessage(siteA, "Try my website again");
		try {
			await entered;
			await save();
			const checkpoint = JSON.parse(
				await readFile(join(root, "metadata.json"), "utf8"),
			);
			const pending = checkpoint.sites.find(
				(site: { id: string }) => site.id === siteA.id,
			);
			assert.equal(pending.runId, undefined);
			assert.equal(pending.generations.at(-1).status, "admitting");
		} finally {
			releasePrompt();
			await retry;
			releaseStorage.readBrand = readBrand;
		}
		const second = await approveBrand(brief.id, [brief.assets[1].id]);
		// One website per organisation: a later approval cannot create another
		// website or change the reference the existing one was created with.
		await assert.rejects(createSite("Create a second site"), /already exists/);
		assert.equal(db.sites.length, 1);
		assert.equal(siteA.brandReferenceId, first.id);
		assert.equal(sources.length, 1);
		assert.ok(
			(await seedFiles(second.id, siteA.starterVersion, siteA.designSeed)).some(
				(file) => file.path === `public/brand-assets/${brief.assets[1].id}.png`,
			),
		);
		const prior = await seedFiles(
			siteA.brandReferenceId,
			siteA.starterVersion,
			siteA.designSeed,
			siteA.foundationRevision,
		);
		assert.ok(
			prior.some(
				(file) => file.path === `public/brand-assets/${brief.assets[0].id}.png`,
			),
		);
		assert.ok(
			!prior.some(
				(file) => file.path === `public/brand-assets/${brief.assets[1].id}.png`,
			),
		);
		assert.deepEqual(sourceGates(sources[0], prior), [
			"Replace the unfinished website placeholder in src/pages/index.astro",
		]);
		const tampered = sources[0].map((file) =>
			file.path.startsWith("public/brand-assets/")
				? { ...file, content: "different", encoding: "utf8" as const }
				: file,
		);
		assert.ok(
			sourceGates(tampered, prior).some((error) =>
				error.includes("approved brand asset"),
			),
		);
		const hotlinked = sources[0].map((file) =>
			file.path === "public/site.css"
				? {
						...file,
						content:
							'body{background:url("https://old-site.example/image.png")}',
						encoding: "utf8" as const,
					}
				: file,
		);
		assert.ok(
			sourceGates(hotlinked, prior).some((error) =>
				error.includes("copied local assets"),
			),
		);

		for (const resource of [
			'<img src={"https://tracker.example/pixel"} />',
			'<img srcset="/local.png 1x, https://tracker.example/pixel 2x" />',
			'<img src="https&colon;//tracker.example/pixel" />',
			'<img src="&#47;&#47;tracker.example/pixel" />',
			'<link rel="stylesheet" href="https://tracker.example/style.css" />',
			'<svg><image href="https://tracker.example/pixel" /></svg>',
			"<img {...attributes} />",
			"<Fragment set:html={html} />",
			String.raw`<style>body{background:url(https\3a //tracker.example/pixel)}</style>`,
			'<style>@import "https://tracker.example/style.css";</style>',
			'<style>body{background:image-set("/local.png" 1x,"https://tracker.example/pixel" 2x)}</style>',
			'<div style="background:url(https://tracker.example/pixel)"></div>',
		]) {
			const candidate = prior.map((file) =>
				file.path === "src/pages/index.astro"
					? {
							...file,
							content: bytes(file).toString() + resource,
							encoding: "utf8" as const,
						}
					: file,
			);
			assert.ok(
				sourceGates(candidate, prior).some((error) =>
					error.includes("copied local assets"),
				),
				resource,
			);
		}
		const local = prior.map((file) =>
			file.path === "src/pages/index.astro"
				? {
						...file,
						content:
							bytes(file)
								.toString()
								.replace("data-studio-blank", "data-generated") +
							'<img src="/brand-assets/local.png" srcset="/one.png 1x, /two.png 2x" /><style>body::after{content:""}body{background:url(/local.png)}</style>',
						encoding: "utf8" as const,
					}
				: file,
		);
		assert.deepEqual(sourceGates(local, prior), []);
		const saved = JSON.parse(
			await readFile(join(root, "metadata.json"), "utf8"),
		);
		assert.equal(saved.brandReferenceId, second.id);
		assert.equal(saved.brandReferences.length, 2);
		assert.equal(
			saved.sites.find((site: { id: string }) => site.id === siteA.id)
				.brandReferenceId,
			first.id,
		);
		const importedLater = {
			...brief,
			id: "later-import",
			title: "Not applied yet",
		};
		await releaseStorage.saveBrand(importedLater.id, [
			{
				path: "visual-brief.json",
				body: Buffer.from(JSON.stringify(importedLater)),
			},
		]);
		db.brandImports.push({
			id: importedLater.id,
			sourceUrl: importedLater.sourceUrl,
			createdAt: importedLater.capturedAt,
		});
		const visible = await brandState();
		assert.equal(visible.brief?.id, importedLater.id);
		assert.equal(
			visible.activeBrief?.id,
			brief.id,
			"A new import cannot hide the current approved reference",
		);
		assert.equal(visible.selected?.id, second.id);
		const temporaryFile = join(root, "metadata.json.tmp");
		const beforeFailure = structuredClone(db.brandReferences);
		await mkdir(temporaryFile);
		const failed = await Promise.allSettled([
			approveBrand(brief.id, [brief.assets[0].id]),
			approveBrand(brief.id, [brief.assets[1].id]),
		]);
		assert.deepEqual(
			failed.map((result) => result.status),
			["rejected", "rejected"],
		);
		assert.deepEqual(db.brandReferences, beforeFailure);
		assert.equal(db.brandReferenceId, second.id);
		await rm(temporaryFile, { recursive: true });
		const approvals = await Promise.all([
			approveBrand(brief.id, [brief.assets[0].id]),
			approveBrand(brief.id, [brief.assets[1].id]),
		]);
		const committed = JSON.parse(
			await readFile(join(root, "metadata.json"), "utf8"),
		);
		assert.ok(
			approvals.some((approval) => approval.id === db.brandReferenceId),
		);
		assert.equal(committed.brandReferenceId, db.brandReferenceId);
		assert.deepEqual(committed.brandReferences, db.brandReferences);
		assert.equal(
			committed.brandReferences.length,
			4,
			"Failed approvals leave no orphans and neither successful approval is discarded",
		);
		for (const approval of approvals)
			assert.ok(
				db.brandReferences?.some((reference) => reference.id === approval.id),
			);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
