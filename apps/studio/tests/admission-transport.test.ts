import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { business } from "../lib/types";

// These tests exercise Site Studio's optional browser checks.
process.env.STUDIO_QA_CHECKS = "on";

test("lost admission responses recover the same operation and payload after abrupt process exit", {
	timeout: 90_000,
}, async (t) => {
	for (const existingThread of [false, true]) {
		for (const failure of [
			"disconnect",
			"truncated",
			"gateway",
			"incomplete",
		]) {
			await t.test(
				`${existingThread ? "edit" : "create"}: ${failure}`,
				async () => {
					const root = await mkdtemp(
						join(tmpdir(), "studio-admission-transport-"),
					);
					const metadata = join(root, "metadata.json");
					await writeFile(
						metadata,
						JSON.stringify({
							business,
							sites: [
								{
									id: "site",
									appId: "app",
									name: "Saved site",
									phase: "idle",
									createdAt: new Date().toISOString(),
									updatedAt: new Date().toISOString(),
									threadId: existingThread ? "thread" : undefined,
									sourceId: "source",
									activeVersionId: "ready",
									publishedVersionId: "public",
									messages: [],
									versions: [],
									previewRevision: 0,
								},
							],
						}),
					);
					const requests: { path: string; key: string; payload: string }[] = [];
					const accepted = new Set<string>();
					const server = createServer(async (req, res) => {
						const chunks: Buffer[] = [];
						for await (const chunk of req) chunks.push(Buffer.from(chunk));
						const key = String(req.headers["idempotency-key"]);
						requests.push({
							path: req.url ?? "",
							key,
							payload: Buffer.concat(chunks).toString(),
						});
						accepted.add(key);
						if (requests.length === 1) {
							if (failure === "disconnect") {
								res.destroy();
								return;
							}
							if (failure === "truncated") {
								res.writeHead(200, { "content-type": "application/json" });
								res.end('{"thread":');
								return;
							}
							if (failure === "gateway") {
								res.writeHead(502);
								res.end("Bad Gateway");
								return;
							}
							res.writeHead(200, { "content-type": "application/json" });
							res.end(JSON.stringify({ thread: { id: "thread" } }));
							return;
						}
						res.writeHead(200, { "content-type": "application/json" });
						res.end(
							JSON.stringify({ thread: { id: "thread" }, run: { id: "run" } }),
						);
					});
					await new Promise<void>((resolve) =>
						server.listen(0, "127.0.0.1", resolve),
					);
					const address = server.address();
					assert.ok(address && typeof address !== "string");
					const apiUrl = `http://127.0.0.1:${address.port}`;
					async function child(action: "submit" | "retry") {
						const processHandle = spawn(
							process.execPath,
							[
								"--import",
								"tsx",
								"--input-type=module",
								"--eval",
								`
						import assert from 'node:assert/strict';
						process.on('disconnect', () => process.exit(1));
						const { database, deleteConversation } = await import('./lib/store.ts');
						const { sendMessage, retryGeneration, startBuild, tick } = await import('./lib/service.ts');
						const db = await database();
						const site = db.sites[0];
						if (process.env.ADMISSION_ACTION === 'submit') {
							await sendMessage(site, 'Make the headline welcoming');
							assert.equal(site.phase, 'failed');
							assert.equal(site.generations[0].status, 'admitting');
							await assert.rejects(sendMessage(site, 'Another change'), /Try again/);
							await assert.rejects(startBuild(site, 'ready'), /Try again/);
							assert.equal(await deleteConversation(site, site.conversationId), 'busy');
							await tick();
						} else {
							db.business.name = 'Changed after restart';
							await retryGeneration(site);
							assert.equal(site.phase, 'generating');
							assert.equal(site.generations[0].status, 'running');
						}
						process.send('checkpoint');
						setInterval(() => {}, 1000);
					`,
							],
							{
								cwd: process.cwd(),
								stdio: ["ignore", "pipe", "pipe", "ipc"],
								env: {
									...process.env,
									STUDIO_DATA_DIR: root,
									HOPLITE_API_URL: apiUrl,
									HOPLITE_SERVICE_KEY: "test-only",
									ADMISSION_ACTION: action,
								},
							},
						);
						let output = "";
						processHandle.stdout?.on("data", (value) => {
							output += value.toString();
						});
						processHandle.stderr?.on("data", (value) => {
							output += value.toString();
						});
						const exited = new Promise<void>((resolve) =>
							processHandle.once("exit", () => resolve()),
						);
						try {
							await new Promise<void>((resolve, reject) => {
								const timer = setTimeout(
									() => reject(new Error(`Child timeout: ${output}`)),
									10_000,
								);
								processHandle.once("message", () => {
									clearTimeout(timer);
									resolve();
								});
								processHandle.once("exit", () => {
									clearTimeout(timer);
									reject(new Error(`Child exited: ${output}`));
								});
								processHandle.once("error", (error) => {
									clearTimeout(timer);
									reject(error);
								});
							});
						} finally {
							processHandle.kill("SIGKILL");
							await exited;
						}
					}
					try {
						await child("submit");
						assert.equal(
							requests.length,
							1,
							"An uncertain admission waits for explicit Retry",
						);
						const pending = JSON.parse(await readFile(metadata, "utf8"))
							.sites[0];
						assert.equal(pending.generations[0].status, "admitting");
						assert.match(pending.error, /Try again/);
						assert.equal(
							pending.threadId,
							existingThread ? "thread" : undefined,
						);
						await child("retry");
						assert.equal(requests.length, 2);
						assert.deepEqual(
							requests[1],
							requests[0],
							"Retry must preserve the endpoint, key and complete request payload",
						);
						assert.equal(accepted.size, 1);
						const recovered = JSON.parse(await readFile(metadata, "utf8"))
							.sites[0];
						assert.equal(recovered.generations.length, 1);
						assert.equal(recovered.generations[0].attempts.length, 1);
						assert.equal(
							recovered.generations[0].id,
							pending.generations[0].id,
						);
						assert.equal(recovered.runId, "run");
						assert.equal(recovered.threadId, "thread");
						assert.equal(recovered.activeVersionId, "ready");
						assert.equal(recovered.publishedVersionId, "public");
						assert.equal(recovered.messages.length, 1);
					} finally {
						server.closeAllConnections();
						await new Promise<void>((resolve) => server.close(() => resolve()));
						await rm(root, { recursive: true, force: true });
					}
				},
			);
		}
	}
});
