import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Database } from "../lib/store";
import type { Site } from "../lib/types";

test("the production server serves a real generated release from customer S3 after local release files are removed", {
	timeout: 180_000,
}, async (t) => {
	const fetch: typeof globalThis.fetch = (input, init) =>
		globalThis.fetch(input, {
			...init,
			signal: AbortSignal.any([t.signal, AbortSignal.timeout(60_000)]),
		});
	const sourceRoot = process.env.STUDIO_STORAGE_ACCEPTANCE_DATA_DIR;
	assert.ok(
		sourceRoot,
		"Set STUDIO_STORAGE_ACCEPTANCE_DATA_DIR to existing demo data; it is read only.",
	);
	assert.ok(
		process.env.STUDIO_RELEASE_BUCKET,
		"Configure a disposable release-storage bucket/prefix and AWS credentials.",
	);
	for (const port of [4320, 4321, 4322]) {
		const probe = createServer();
		await new Promise<void>((resolve, reject) => {
			probe.once("error", reject);
			probe.listen(port, "127.0.0.1", resolve);
		});
		await new Promise<void>((resolve) => probe.close(() => resolve()));
	}
	const original: Database = JSON.parse(
		await readFile(join(sourceRoot, "metadata.json"), "utf8"),
	);
	const sourceSite = original.sites.find(
		(site) => site.id === process.env.STUDIO_STORAGE_ACCEPTANCE_SITE_ID,
	);
	assert.ok(
		sourceSite,
		"Select a real generated website with STUDIO_STORAGE_ACCEPTANCE_SITE_ID",
	);
	const sourceVersion = sourceSite.versions.find(
		(version) => version.id === sourceSite.activeVersionId,
	);
	assert.ok(
		sourceVersion?.qa?.status === "passed" &&
			!sourceVersion.failure &&
			sourceVersion.sourceChecked,
		"The selected website must have a verified ready release",
	);
	const root = await mkdtemp(join(tmpdir(), "studio-live-storage-"));
	process.env.STUDIO_DATA_DIR = root;
	const { releaseStorage } = await import("../lib/release-storage");
	const { sha256 } = await import("../lib/safety");
	const version = structuredClone(sourceVersion);
	version.id = randomUUID();
	version.storage = undefined;
	const directory = join(root, "versions", version.id);
	const site: Site = {
		id: randomUUID(),
		name: "Disposable storage acceptance",
		createdAt: version.createdAt,
		updatedAt: version.createdAt,
		phase: "idle",
		messages: [],
		versions: [version],
		activeVersionId: version.id,
		previewRevision: 0,
	};
	const children: ReturnType<typeof launch>[] = [];
	function launch() {
		const child = spawn(
			process.execPath,
			[
				"--import",
				"tsx",
				"--input-type=module",
				"--eval",
				`
          await import('./server.ts');
          const { releaseStorage } = await import('./lib/release-storage.ts');
          for (const name of ['sync', 'materialize', 'require']) {
            const operation = releaseStorage[name].bind(releaseStorage);
            releaseStorage[name] = async (...args) => {
              const start = Date.now();
              const label = name + (typeof args[2] === 'string' ? ':' + args[2] : '');
              process.stdout.write('Storage started ' + label + '\\n');
              try {
                const result = await operation(...args);
                process.stdout.write('Storage finished ' + label + ' in ' + (Date.now() - start) + 'ms\\n');
                return result;
              } catch (error) {
                process.stdout.write('Storage failed ' + label + ': ' + error.message + '\\n');
                throw error;
              }
            };
          }
          process.send({ ready: true });
        `,
			],
			{
				cwd: process.cwd(),
				stdio: ["ignore", "pipe", "pipe", "ipc"],
				env: {
					...process.env,
					NODE_ENV: "production",
					STUDIO_DATA_DIR: root,
					HOPLITE_API_URL: "",
					HOPLITE_SERVICE_KEY: "",
				},
			},
		);
		let output = "";
		const cancel = () => child.kill("SIGTERM");
		t.signal.addEventListener("abort", cancel, { once: true });
		child.once("exit", () => t.signal.removeEventListener("abort", cancel));
		child.stdout?.on("data", (data) => {
			output += data.toString();
		});
		child.stderr?.on("data", (data) => {
			output += data.toString();
		});
		const exited = new Promise<number | null>((resolve, reject) => {
			child.once("error", reject);
			child.once("exit", resolve);
		});
		const ready = new Promise<void>((resolve, reject) => {
			child.once("message", () => resolve());
			child.once("error", reject);
			child.once("exit", (code) =>
				reject(new Error(`Server exited ${code}: ${output}`)),
			);
		});
		return { child, ready, exited, output: () => output };
	}
	try {
		await cp(join(sourceRoot, "versions", sourceVersion.id), directory, {
			recursive: true,
		});
		version.artifactDirectory = join(directory, "dist");
		version.qaReport = undefined;
		version.sourceChecked = undefined;
		assert.ok(version.qa);
		const artifactHash = sha256(
			await readFile(join(directory, "artifact.tar.gz")),
		);
		const screenshot = version.qa.screenshots[0];
		assert.ok(screenshot, "The real QA run must contain screenshot evidence");
		const screenshotHash = sha256(
			await readFile(join(directory, "qa", screenshot)),
		);
		const manifest: { files: { path: string; sha256: string }[] } = JSON.parse(
			await readFile(join(directory, "dist-manifest.json"), "utf8"),
		);
		await writeFile(
			join(root, "metadata.json"),
			JSON.stringify({ business: original.business, sites: [site] }),
		);
		const migrating = launch();
		children.push(migrating);
		await migrating.ready;
		t.diagnostic("Legacy release migrated before the server started.");
		const migrated: Database = JSON.parse(
			await readFile(join(root, "metadata.json"), "utf8"),
		);
		Object.assign(version, migrated.sites[0].versions[0]);
		assert.ok(version.storage, "Startup must migrate a legacy local release");
		assert.ok(
			version.qaReport,
			"Startup must backfill a legacy QA report pointer",
		);
		assert.equal(version.qa?.evidence, undefined);
		migrating.child.kill("SIGTERM");
		assert.equal(await migrating.exited, 0);
		const pointer = structuredClone(version.storage);
		await releaseStorage.sync(site.id, version);
		t.diagnostic("Repeated object sync verified.");
		assert.deepEqual(
			version.storage,
			pointer,
			"Repeated S3 sync is immutable and idempotent",
		);
		await rm(directory, { recursive: true });
		assert.ok(
			(await releaseStorage.require(site.id, version, "source.tar.gz")).length >
				0,
		);
		let routes = 0;
		for (let restart = 0; restart < 2; restart++) {
			const running = launch();
			children.push(running);
			await running.ready;
			t.diagnostic(`Publishing after restart ${restart + 1}.`);
			const base = `http://127.0.0.1:4320/api/site/versions/${version.id}`;
			const publish = await fetch("http://127.0.0.1:4320/api/site/publish", {
				method: "POST",
				headers: {
					origin: "http://127.0.0.1:4320",
					"x-studio-action": "studio",
					"content-type": "application/json",
				},
				body: JSON.stringify({
					versionId: version.id,
					operationId: randomUUID(),
					expectedPublishedVersionId: restart ? version.id : null,
					action: "publish",
				}),
			});
			assert.equal(publish.status, 200, await publish.text());
			t.diagnostic(`Published after restart ${restart + 1}.`);
			const downloaded = await fetch(`${base}/artifact`);
			assert.equal(downloaded.status, 200);
			assert.equal(
				sha256(Buffer.from(await downloaded.arrayBuffer())),
				artifactHash,
			);
			const image = await fetch(
				`${base}/evidence?file=${encodeURIComponent(screenshot)}`,
			);
			assert.equal(image.status, 200);
			assert.equal(
				sha256(Buffer.from(await image.arrayBuffer())),
				screenshotHash,
			);
			const report = await fetch(`${base}/evidence`);
			assert.equal(report.status, 200);
			assert.equal((await report.json()).status, "passed");
			const opened = await fetch(
				`http://127.0.0.1:4321/__open?site=${site.id}&version=${version.id}`,
				{ redirect: "manual" },
			);
			assert.equal(opened.status, 302);
			const cookie = opened.headers.get("set-cookie")?.split(";")[0];
			assert.ok(cookie);
			for (const file of manifest.files.filter((file) =>
				file.path.endsWith(".html"),
			)) {
				const path = file.path.replace(/index\.html$/, "");
				for (const port of [4321, 4322]) {
					const page: Response = await fetch(
						`http://127.0.0.1:${port}/${path}`,
						{
							headers: { cookie },
						},
					);
					assert.equal(page.status, 200, `${port}/${path}`);
					assert.equal(
						sha256(Buffer.from(await page.arrayBuffer())),
						file.sha256,
					);
					routes++;
				}
			}
			const nested = manifest.files.find((file) => file.path.includes("/"));
			assert.ok(nested);
			for (const port of [4321, 4322]) {
				const normalized: Response = await fetch(
					`http://127.0.0.1:${port}/${nested.path.replaceAll("/", "//")}`,
					{ headers: { cookie } },
				);
				assert.equal(normalized.status, 200);
				assert.equal(
					sha256(Buffer.from(await normalized.arrayBuffer())),
					nested.sha256,
				);
				assert.equal(
					(
						await fetch(`http://127.0.0.1:${port}/%E0%A4%A`, {
							headers: { cookie },
						})
					).status,
					400,
				);
				assert.equal(
					(await fetch(`http://127.0.0.1:${port}/%00`, { headers: { cookie } }))
						.status,
					400,
				);
			}
			assert.equal(
				(await fetch("http://127.0.0.1:4322/missing-page")).status,
				404,
			);
			running.child.kill("SIGTERM");
			assert.equal(await running.exited, 0);
		}
		t.diagnostic(
			JSON.stringify({
				storage: version.storage,
				sourceVersionId: sourceVersion.id,
				siteId: site.id,
				versionId: version.id,
				routeResponsesVerified: routes,
				restarts: 2,
				automaticLegacyMigration: true,
				localReleaseDirectoryRemoved: true,
				artifactSha256: artifactHash,
				screenshotSha256: screenshotHash,
			}),
		);
	} catch (error) {
		for (const running of children) t.diagnostic(running.output());
		throw error;
	} finally {
		for (const running of children)
			if (running.child.exitCode === null) {
				running.child.kill("SIGTERM");
				await running.exited;
			}
		await rm(root, { recursive: true, force: true });
	}
});
