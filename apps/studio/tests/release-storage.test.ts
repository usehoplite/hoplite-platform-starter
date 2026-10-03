import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import { c as archive, x as extract } from "tar";
import type { Site, Version } from "../lib/types";

// These tests exercise Site Studio's optional browser checks.
process.env.STUDIO_QA_CHECKS = "on";

test("S3 releases are immutable, survive loss of local files, and gate readiness on durable evidence", async () => {
	const root = await mkdtemp(join(tmpdir(), "studio-release-storage-"));
	const objects = new Map<string, Buffer>();
	let rejectUploads = false;
	let failEvidence = false;
	let conditionalWrites = 0;
	let stallPath = "";
	let stalledReads = 0;
	const objectReads = new Map<string, number>();
	const manifestReads = new Map<string, number>();
	const server = createServer(async (req, res) => {
		if (req.url === "/interrupted-build-log") {
			res.destroy();
			return;
		}
		const key = decodeURIComponent(
			new URL(req.url || "/", "http://storage").pathname,
		);
		if (req.method === "PUT") {
			const chunks: Buffer[] = [];
			for await (const chunk of req) chunks.push(Buffer.from(chunk));
			if (rejectUploads || (failEvidence && key.includes("/qa/"))) {
				res.writeHead(403, { "content-type": "application/xml" });
				res.end(
					"<Error><Code>AccessDenied</Code><Message>Fixture storage denied</Message></Error>",
				);
				return;
			}
			assert.equal(req.headers["if-none-match"], "*");
			conditionalWrites++;
			if (objects.has(key)) {
				res.writeHead(412, { "content-type": "application/xml" });
				res.end(
					"<Error><Code>PreconditionFailed</Code><Message>Already exists</Message></Error>",
				);
			} else {
				objects.set(key, Buffer.concat(chunks));
				res.writeHead(200, { ETag: '"fixture"' });
				res.end();
			}
			return;
		}
		if (key.includes("/manifests/"))
			manifestReads.set(key, (manifestReads.get(key) || 0) + 1);
		const body = objects.get(key);
		if (body) {
			objectReads.set(key, (objectReads.get(key) || 0) + 1);
			res.writeHead(200, { "content-length": body.length });
			if (stallPath && key.endsWith(stallPath) && stalledReads > 0) {
				stalledReads--;
				res.write(body.subarray(0, 1));
				return;
			}
			res.end(body);
		} else {
			res.writeHead(404, { "content-type": "application/xml" });
			res.end("<Error><Code>NoSuchKey</Code></Error>");
		}
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	process.env.STUDIO_DATA_DIR = root;
	process.env.STUDIO_RELEASE_BUCKET = "customer-releases";
	process.env.STUDIO_RELEASE_PREFIX = "fixture";
	process.env.STUDIO_RELEASE_ENDPOINT = `http://127.0.0.1:${address.port}`;
	process.env.AWS_ACCESS_KEY_ID = "fixture-access";
	process.env.AWS_SECRET_ACCESS_KEY = "fixture-secret";
	const { releaseStorage, ReleaseStorage, immutableFile } = await import(
		"../lib/release-storage"
	);
	const { database, save } = await import("../lib/store");
	const { migrateBrandStorage } = await import("../lib/brand");
	const {
		tick,
		hoplite,
		seedFiles,
		publish,
		startBuild,
		migrateReleaseStorage,
	} = await import("../lib/service");
	const { sha256 } = await import("../lib/safety");
	try {
		assert.throws(
			() =>
				new ReleaseStorage({
					bucket: "fixture",
					prefix: "fixture",
					region: "us-east-1",
					endpoint: "http://remote.example",
				}),
			/HTTPS outside loopback/,
		);
		assert.throws(
			() =>
				new ReleaseStorage({
					bucket: "fixture",
					prefix: "fixture",
					region: "us-east-1",
					endpoint: "https://user:password@remote.example",
				}),
			/must not embed credentials/,
		);
		const db = await database();
		const brandId = "saved-brand";
		const brandRoot = join(root, "brand-imports", brandId);
		const image = Buffer.from("previously approved image");
		const assetPath = `assets/${sha256(image)}.png`;
		const brief = Buffer.from(JSON.stringify({ id: brandId }));
		await mkdir(join(brandRoot, "assets"), { recursive: true });
		await writeFile(join(brandRoot, "visual-brief.json"), brief);
		await writeFile(join(brandRoot, "reference.png"), image);
		await writeFile(join(brandRoot, assetPath), image);
		db.brandImports = [
			{ id: brandId, sourceUrl: "https://brand.example", createdAt: "now" },
		];
		rejectUploads = true;
		await assert.rejects(migrateBrandStorage(), /Fixture storage denied/);
		assert.equal(db.brandImports[0].storage, undefined);
		rejectUploads = false;
		await migrateBrandStorage();
		const imported = db.brandImports[0];
		assert.ok(imported.storage);
		await rm(brandRoot, { recursive: true });
		assert.deepEqual(
			await releaseStorage.readBrand(imported, assetPath),
			image,
		);
		assert.deepEqual(
			await releaseStorage.readBrand(imported, "visual-brief.json"),
			brief,
		);
		await migrateBrandStorage();
		await assert.rejects(
			releaseStorage.readBrand({ ...imported, id: "another-brand" }, assetPath),
			/Invalid release manifest pointer/,
		);
		await assert.rejects(
			releaseStorage.saveBrand("duplicate", [
				{ path: "reference.png", body: image },
				{ path: "reference.png", body: image },
			]),
			/Duplicate brand import path/,
		);
		const version: Version = {
			id: "candidate",
			sourceId: "source",
			sourceChecked: true,
			label: "Candidate",
			createdAt: new Date().toISOString(),
			buildId: "build",
		};
		const old: Version = {
			...version,
			id: "old",
			sourceId: "old-source",
			qa: { status: "passed", checks: [], errors: [], screenshots: [] },
			artifactDirectory: "old",
		};
		const site: Site = {
			id: "customer",
			appId: "app",
			name: "Customer",
			createdAt: version.createdAt,
			updatedAt: version.createdAt,
			phase: "building",
			messages: [],
			versions: [old, version],
			threadId: "thread",
			runId: "run",
			buildVersionId: version.id,
			activeVersionId: old.id,
			publishedVersionId: old.id,
			previewRevision: 0,
		};
		db.sites.push(site);
		const directory = join(root, "versions", version.id);
		await mkdir(directory, { recursive: true });
		const files = await seedFiles();
		await immutableFile(
			join(directory, "source.json"),
			JSON.stringify({ files }),
		);
		await releaseStorage.sync(site.id, version);
		const firstPointer = structuredClone(version.storage);
		await releaseStorage.sync(site.id, version);
		assert.deepEqual(
			version.storage,
			firstPointer,
			"Identical sync is idempotent",
		);
		const restored = join(root, "restored");
		await mkdir(restored);
		await extract({
			cwd: restored,
			file: join(directory, "source.tar.gz"),
			strict: true,
		});
		const packageFile = files.find((file) => file.path === "package.json");
		assert.ok(packageFile);
		assert.equal(
			await readFile(join(restored, "package.json"), "utf8"),
			Buffer.from(packageFile.content, "base64").toString(),
		);
		// A retry without the saved manifest exercises actual S3 conditional writes.
		version.storage = undefined;
		await releaseStorage.sync(site.id, version);
		assert.deepEqual(version.storage, firstPointer);
		assert.ok(conditionalWrites >= 6);
		await writeFile(
			join(directory, "source.json"),
			JSON.stringify({ files: [{ path: "changed.txt", content: "conflict" }] }),
		);
		await assert.rejects(
			releaseStorage.sync(site.id, version),
			/Immutable release changed/,
		);
		version.storage = undefined;
		await assert.rejects(
			releaseStorage.sync(site.id, { ...version, sourceChecked: false }),
			/differs from the immutable candidate/,
		);
		version.storage = firstPointer;
		await writeFile(join(directory, "source.json"), JSON.stringify({ files }));
		await assert.rejects(
			releaseStorage.require("different-customer", version, "source.json"),
			/manifest pointer/,
		);
		assert.ok(releaseStorage.config);
		await assert.rejects(
			new ReleaseStorage({
				...releaseStorage.config,
				bucket: "different",
			}).require(site.id, version, "source.json"),
			/configuration does not match/,
		);
		await assert.rejects(
			releaseStorage.read(site.id, version, "../source.json"),
			/Invalid release path/,
		);
		const artifactRoot = join(root, "artifact");
		await mkdir(artifactRoot);
		const html = Buffer.from("<!doctype html><h1>Stored release</h1>");
		await writeFile(join(artifactRoot, "index.html"), html);
		await archive(
			{ cwd: artifactRoot, file: join(root, "artifact.tar.gz"), gzip: true },
			["index.html"],
		);
		const artifact = await readFile(join(root, "artifact.tar.gz"));
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
				return { run: { status: "completed", resultSourceId: "source" } } as T;
			if (path.endsWith("/manifest"))
				return { files: [{ path: "index.html", sha256: sha256(html) }] } as T;
			return {
				build: { status: "ready", artifactSha256: sha256(artifact) },
			} as T;
		};
		let logAttempts = 0;
		const { Hoplite, HopliteError } = await import("../lib/hoplite");
		const interrupted = new Hoplite(
			`http://127.0.0.1:${address.port}`,
			"fixture-only",
		);
		hoplite.response = async (path) => {
			if (path.endsWith("/logs") && ++logAttempts === 1)
				return interrupted.response("/interrupted-build-log");
			if (path.endsWith("/logs") && logAttempts === 2)
				throw new HopliteError(503, "temporarily_unavailable");
			return new Response(path.endsWith("/logs") ? "Build passed" : artifact);
		};
		const qa = async (
			_siteId: string,
			_versionId: string | undefined,
			path: string,
		) => {
			await mkdir(path, { recursive: true });
			await writeFile(join(path, "desktop.png"), "screenshot evidence");
			return {
				status: "passed" as const,
				checks: ["Fixture passed"],
				errors: [],
				screenshots: ["desktop.png"],
				evidence: [
					{
						route: "/",
						url: "https://preview.example/",
						viewport: { width: 1440, height: 900 },
						action: "Open",
						expected: "Content",
						actual: "Content",
						status: "passed" as const,
						screenshot: "desktop.png",
						console: [],
						network: ["GET / 200"],
					},
				],
			};
		};
		await tick(qa);
		assert.equal(site.phase, "building");
		assert.equal(Boolean(version.failure), false);
		await tick(qa);
		assert.equal(site.phase, "building");
		assert.equal(site.activeVersionId, old.id);
		failEvidence = true;
		await tick(qa);
		assert.equal(site.phase, "failed");
		assert.equal(site.activeVersionId, old.id);
		assert.equal(site.publishedVersionId, old.id);
		assert.equal(version.failure?.category, "infrastructure");
		await assert.rejects(
			publish(site, version.id),
			/requires a saved artifact/,
		);
		failEvidence = false;
		await startBuild(site, version.id);
		await tick(qa);
		assert.equal(site.phase, "idle");
		assert.equal(site.activeVersionId, version.id);
		assert.equal(site.publishedVersionId, old.id);
		assert.equal(
			version.qa?.evidence,
			undefined,
			"Detailed evidence stays outside metadata",
		);
		assert.ok(version.qaReport);
		const report = JSON.parse(
			(
				await releaseStorage.require(site.id, version, version.qaReport)
			).toString(),
		);
		assert.equal(report.evidence.length, 2);
		assert.equal(report.evidence[0].network[0], "GET / 200");
		await rm(directory, { recursive: true });
		assert.ok(
			(
				await releaseStorage.require(site.id, version, "dist/index.html")
			).equals(html),
		);
		assert.ok(
			(
				await releaseStorage.require(site.id, version, "artifact.tar.gz")
			).equals(artifact),
		);
		assert.ok(version.qa);
		assert.equal(
			(
				await releaseStorage.require(
					site.id,
					version,
					`qa/${version.qa.screenshots[0]}`,
				)
			).toString(),
			"screenshot evidence",
		);
		assert.equal(
			await releaseStorage.read(site.id, version, "dist/missing.html"),
			undefined,
		);
		rejectUploads = true;
		await assert.rejects(publish(site, version.id), /Fixture storage denied/);
		assert.equal(site.publishedVersionId, old.id);
		rejectUploads = false;
		await publish(site, version.id);
		assert.equal(site.publishedVersionId, version.id);
		const downloaded = await releaseStorage.materialize(
			site.id,
			version,
			"artifact.tar.gz",
		);
		assert.ok((await readFile(downloaded.file)).equals(artifact));
		await downloaded.dispose();
		await assert.rejects(readFile(downloaded.file), { code: "ENOENT" });
		const timeout = AbortSignal.timeout.bind(AbortSignal);
		const shortDeadline = mock.method(
			AbortSignal,
			"timeout",
			(milliseconds: number) =>
				timeout(milliseconds === 30_000 ? 100 : milliseconds),
		);
		try {
			const prefix =
				"/customer-releases/fixture/microsites/customer/releases/candidate";
			stallPath = "/dist/index.html";
			stalledReads = 1;
			const before = objectReads.get(`${prefix}${stallPath}`) || 0;
			assert.ok(
				(
					await releaseStorage.require(site.id, version, "dist/index.html")
				).equals(html),
			);
			assert.equal(
				objectReads.get(`${prefix}${stallPath}`),
				before + 2,
				"A body stalled after headers must be aborted and read once more",
			);
			stallPath = "/artifact.tar.gz";
			stalledReads = 1;
			const recovered = await releaseStorage.materialize(
				site.id,
				version,
				"artifact.tar.gz",
			);
			assert.ok(
				(await readFile(recovered.file)).equals(artifact),
				"Retry must replace the partial file and restart size/hash verification",
			);
			await recovered.dispose();
			site.publishedVersionId = old.id;
			await save();
			stalledReads = 2;
			const attempts = objectReads.get(`${prefix}${stallPath}`) || 0;
			await assert.rejects(publish(site, version.id), { name: "AbortError" });
			assert.equal(
				objectReads.get(`${prefix}${stallPath}`),
				attempts + 2,
				"Persistent read failure must stop after one retry",
			);
			assert.equal(site.publishedVersionId, old.id);
			assert.equal(
				JSON.parse(await readFile(join(root, "metadata.json"), "utf8")).sites[0]
					.publishedVersionId,
				old.id,
			);
		} finally {
			stallPath = "";
			stalledReads = 0;
			shortDeadline.mock.restore();
		}
		const beforeReads = [...manifestReads.entries()];
		await releaseStorage.require(site.id, version, "dist/index.html");
		await releaseStorage.require(site.id, version, "artifact.tar.gz");
		await releaseStorage
			.materialize(site.id, version, "artifact.tar.gz")
			.then((download) => download.dispose());
		assert.deepEqual(
			[...manifestReads.entries()],
			beforeReads,
			"Asset delivery must reuse the validated immutable manifest",
		);
		const quarantined: Version = {
			...version,
			id: "quarantine",
			storage: undefined,
			sourceChecked: false,
		};
		await mkdir(join(root, "versions", quarantined.id));
		const credential = `sk-${"a".repeat(40)}`;
		await immutableFile(
			join(root, "versions", quarantined.id, "source.json"),
			JSON.stringify({ files: [{ path: "README.md", content: credential }] }),
		);
		await releaseStorage.sync(site.id, quarantined);
		assert.equal(
			await releaseStorage.read(site.id, quarantined, "source.json"),
			undefined,
		);
		assert.ok(
			await releaseStorage.require(
				site.id,
				quarantined,
				"source-quarantine.json",
			),
		);
		assert.ok(
			![...objects.entries()]
				.filter(([key]) => key.includes("/quarantine/"))
				.some(([, body]) => body.includes(credential)),
		);
		const legacy: Version = {
			...version,
			id: "legacy",
			storage: undefined,
			sourceChecked: undefined,
			qaReport: undefined,
			qa: {
				status: "passed",
				checks: ["Legacy check"],
				errors: [],
				screenshots: [],
				evidence: [],
			},
		};
		const legacyRoot = join(root, "versions", legacy.id);
		await mkdir(join(legacyRoot, "dist"), { recursive: true });
		await immutableFile(
			join(legacyRoot, "source.json"),
			JSON.stringify({ files }),
		);
		await immutableFile(join(legacyRoot, "artifact.tar.gz"), artifact);
		await immutableFile(join(legacyRoot, "dist", "index.html"), html);
		const legacySite: Site = {
			...site,
			id: "legacy-site",
			versions: [legacy],
			activeVersionId: legacy.id,
			publishedVersionId: legacy.id,
		};
		db.sites = [legacySite];
		rejectUploads = true;
		await assert.rejects(migrateReleaseStorage(), /Fixture storage denied/);
		assert.equal(legacy.storage, undefined);
		assert.equal(legacy.qaReport, undefined);
		rejectUploads = false;
		await migrateReleaseStorage();
		assert.ok(legacy.storage);
		assert.ok(legacy.qaReport);
		assert.equal(legacySite.publishedVersionId, legacy.id);
		await rm(legacyRoot, { recursive: true });
		await publish(legacySite, legacy.id);
		assert.ok(
			(
				await releaseStorage.require(legacySite.id, legacy, "dist/index.html")
			).equals(html),
		);
		const key =
			"/customer-releases/fixture/microsites/customer/releases/candidate/dist/index.html";
		objects.set(key, Buffer.from("tampered"));
		await assert.rejects(
			releaseStorage.read(site.id, version, "dist/index.html"),
			/hash mismatch/,
		);
		objects.delete(key);
		await assert.rejects(
			releaseStorage.read(site.id, version, "dist/index.html"),
			{ name: "NoSuchKey" },
		);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
		await rm(root, { recursive: true, force: true });
	}
});
