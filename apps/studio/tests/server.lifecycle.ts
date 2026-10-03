import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { business } from "../lib/types";

test("the actual server rejects occupied ports and preserves its checkpoint across signals", {
	timeout: 90_000,
}, async () => {
	// These are the real demo ports. Never displace a developer's running demo.
	for (const port of [4320, 4321, 4322]) {
		const probe = createServer();
		await new Promise<void>((resolve, reject) => {
			probe.once("error", reject);
			probe.listen(port, "127.0.0.1", resolve);
		});
		await new Promise<void>((resolve) => probe.close(() => resolve()));
	}
	const root = await mkdtemp(join(tmpdir(), "studio-lifecycle-"));
	const snapshot = {
		business,
		sites: [
			{
				id: "recovery",
				name: "Recovery",
				phase: "checking",
				activeVersionId: "ready",
				publishedVersionId: "published",
				buildVersionId: "candidate",
				messages: [],
				versions: [
					{ id: "candidate", sourceId: "saved-source", buildId: "saved-build" },
				],
			},
		],
	};
	const metadata = join(root, "metadata.json");
	await writeFile(metadata, JSON.stringify(snapshot));
	const children: ReturnType<typeof launch>[] = [];
	function launch(extraEnv: Record<string, string> = {}) {
		const child = spawn(
			process.execPath,
			[
				"--import",
				"tsx",
				"--input-type=module",
				"--eval",
				`
			await import('./server.ts');
			const { chromium } = await import('playwright');
			await chromium.launch({ channel: 'chrome', headless: true, handleSIGINT: false, handleSIGTERM: false });
   const { hoplite } = await import('./lib/service.ts');
   Object.defineProperty(hoplite, 'configured', { value: true });
   let activityCalls = 0;
   hoplite.json = async (path, body) => {
    if (process.env.STUDIO_TEST_WORKSPACE === '1') process.send({ path, body });
    if (path.endsWith('/workspace/activity')) {
     if (++activityCalls >= 3 && process.env.STUDIO_TEST_WORKSPACE === '1') throw new Error('Activity service unavailable');
     return { ok: true };
    }
    if (path.endsWith('/workspace/policy')) return { policy: { workspaceStatus: 'archived' } };
    if ((path.endsWith('/preview/start') || path.includes('/preview?')) && process.env.STUDIO_TEST_UPSTREAM === '1') return { preview: { status: 'ready', url: 'https://preview.example', gateway: { token: 'grant', header: 'x-preview-token', expiresAt: new Date(Date.now() + 600000).toISOString() } } };
    if (path.endsWith('/preview/start') || path.includes('/preview?')) return { preview: { status: 'stopped' } };
    if (path === '/api/platform/v1/apps') return { app: { id: 'fixture-app' } };
    if (path.endsWith('/sources')) return { source: { id: 'fixture-source' } };
    if (path.endsWith('/threads')) {
     process.send({ admissionStarted: true });
     await new Promise(resolve => process.once('message', resolve));
     return { thread: { id: 'fixture-thread' }, run: { id: 'fixture-run' } };
    }
    if (path.includes('/runs/')) return { run: { status: 'running' } };
    if (path.endsWith('/messages')) return { messages: [] };
    throw new Error('Unexpected lifecycle request: ' + path);
   };
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
					...extraEnv,
				},
			},
		);
		let output = "";
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
			child.once("exit", (code) =>
				reject(new Error(`Server exited ${code}: ${output}`)),
			);
			child.once("error", reject);
		});
		// The port-collision process intentionally exits before becoming ready.
		void ready.catch(() => undefined);
		const result = { child, exited, ready, output: () => output };
		return result;
	}
	async function bounded<T>(promise: Promise<T>, milliseconds: number) {
		const controller = new AbortController();
		try {
			return await Promise.race([
				promise,
				delay(milliseconds, undefined, { signal: controller.signal }).then(
					() => {
						throw new Error(
							`Server lifecycle timed out after ${milliseconds}ms`,
						);
					},
				),
			]);
		} finally {
			controller.abort();
		}
	}
	/** Calls are reported over IPC, so wait (bounded) for them to arrive. */
	async function until(condition: () => boolean, message: string) {
		for (let wait = 0; !condition(); wait++) {
			assert.ok(wait < 40, message);
			await delay(50);
		}
	}
	try {
		const first = launch();
		children.push(first);
		await bounded(first.ready, 25_000);
		const state = await (await fetch("http://127.0.0.1:4320/api/state")).json();
		assert.equal(state.site.buildVersionId, "candidate");
		// Change the durable file after the first process has loaded its copy.
		// A failed second process must leave this file byte-for-byte untouched.
		const durable = JSON.stringify({
			...snapshot,
			marker: "do not overwrite on startup failure",
		});
		await writeFile(metadata, durable);
		// Enabling storage would migrate these legacy releases. Port ownership
		// must be rejected before attempting to read their missing local files.
		const second = launch({
			STUDIO_RELEASE_BUCKET: "collision-must-not-migrate",
		});
		children.push(second);
		assert.equal(await bounded(second.exited, 25_000), 1);
		assert.match(second.output(), /EADDRINUSE/);
		assert.equal(await readFile(metadata, "utf8"), durable);
		first.child.kill("SIGTERM");
		assert.equal(await bounded(first.exited, 5_000), 0);
		assert.deepEqual(JSON.parse(await readFile(metadata, "utf8")), snapshot);
		const restarted = launch();
		children.push(restarted);
		await bounded(restarted.ready, 25_000);
		const recovered = await (
			await fetch("http://127.0.0.1:4320/api/state")
		).json();
		assert.equal(recovered.site.activeVersionId, "ready");
		assert.equal(recovered.site.publishedVersionId, "published");
		assert.equal(recovered.site.versions[0].sourceId, "saved-source");
		restarted.child.kill("SIGINT");
		assert.equal(await bounded(restarted.exited, 5_000), 0);
		assert.deepEqual(JSON.parse(await readFile(metadata, "utf8")), snapshot);
		for (const signal of ["SIGTERM", "SIGINT"] as const) {
			await writeFile(metadata, JSON.stringify({ business, sites: [] }));
			const admitting = launch();
			children.push(admitting);
			await bounded(admitting.ready, 25_000);
			const entered = new Promise<void>((resolve) =>
				admitting.child.once("message", () => resolve()),
			);
			const request = fetch("http://127.0.0.1:4320/api/site", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					origin: "http://127.0.0.1:4320",
					"x-studio-action": "studio",
				},
				body: JSON.stringify({ prompt: "Create a site" }),
			}).catch(() => undefined);
			await bounded(entered, 5_000);
			admitting.child.kill(signal);
			await delay(200);
			assert.equal(
				admitting.child.exitCode,
				null,
				`${signal} abandoned an active admission`,
			);
			assert.equal(admitting.child.signalCode, null);
			admitting.child.send({ finishAdmission: true });
			assert.equal(await bounded(admitting.exited, 5_000), 0);
			await request;
			const saved = JSON.parse(await readFile(metadata, "utf8"));
			assert.equal(saved.sites[0].threadId, "fixture-thread");
			assert.equal(saved.sites[0].runId, "fixture-run");
			assert.equal(saved.sites[0].generations[0].status, "running");
		}
		await writeFile(
			metadata,
			JSON.stringify({
				business,
				sites: [
					{
						id: "idle",
						appId: "fixture-app",
						threadId: "fixture-thread",
						phase: "idle",
						messages: [],
						versions: [],
					},
				],
			}),
		);
		const idle = launch({ STUDIO_TEST_WORKSPACE: "1" });
		children.push(idle);
		const calls: { path: string; body?: { idleTimeoutMinutes?: number } }[] =
			[];
		idle.child.on("message", (message) => {
			if (
				typeof message === "object" &&
				message &&
				"path" in message &&
				typeof message.path === "string"
			)
				calls.push(message as (typeof calls)[number]);
		});
		await bounded(idle.ready, 25_000);
		const starts = () =>
			calls.filter((call) => call.path.endsWith("/preview/start")).length;
		const activities = () =>
			calls.filter((call) => call.path.endsWith("/workspace/activity")).length;
		// The studio mounting its frame starts nothing and renews nothing.
		const mounted = await fetch("http://127.0.0.1:4321/__open?site=idle", {
			redirect: "manual",
		});
		assert.equal(mounted.status, 302);
		assert.ok(mounted.headers.get("set-cookie"));
		assert.equal(starts(), 0, "Mounting the frame must not wake the sandbox");
		assert.equal(activities(), 0);
		// "Wake preview" is explicit: it starts the saved workspace.
		const opened = await fetch(
			"http://127.0.0.1:4321/__open?site=idle&wake=1",
			{ redirect: "manual" },
		);
		assert.equal(opened.status, 302);
		const cookie = opened.headers.get("set-cookie")?.split(";")[0];
		assert.ok(cookie);
		// The owner is redirected at once; the wake renews the idle deadline
		// first, then starts the workspace.
		await until(() => starts() === 1, "the explicit wake starts it");
		const renewed = calls.findIndex((call) =>
			call.path.endsWith("/workspace/activity"),
		);
		assert.deepEqual(calls[renewed]?.body, {});
		assert.ok(
			renewed < calls.findIndex((call) => call.path.endsWith("/preview/start")),
			"renewed before restoring",
		);
		// Wait until the refused start has settled into the paused state.
		for (let i = 0; i < 50; i++) {
			const state = await (
				await fetch("http://127.0.0.1:4321/__preview-state", {
					headers: { cookie },
				})
			).json();
			if (state.state === "paused") break;
			await delay(50);
		}
		// The workspace did not come back: the owner sees the paused page, and
		// its automatic reloads (with or without navigation metadata) and its
		// state poll never restart anything.
		const reloads: Record<string, string>[] = [
			{ cookie },
			{ cookie, "sec-fetch-dest": "iframe" },
			{ cookie, "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" },
		];
		for (const headers of reloads) {
			const paused: Response = await fetch("http://127.0.0.1:4321/", {
				headers,
			});
			assert.equal(paused.status, 503);
			const html = await paused.text();
			assert.match(html, /Your preview is paused/);
			assert.match(html, /__open\?site=idle&amp;wake=1&amp;path=%2F/);
			assert.doesNotMatch(html, /Hoplite/i);
			assert.equal(paused.headers.get("refresh"), null);
			assert.equal(paused.headers.get("x-studio-preview-state"), "starting");
			const poll: Response = await fetch(
				"http://127.0.0.1:4321/__preview-state",
				{
					headers: { cookie },
				},
			);
			assert.deepEqual(await poll.json(), { state: "paused" });
		}
		const pausedState = await (
			await fetch("http://127.0.0.1:4320/api/state")
		).json();
		assert.equal(pausedState.previewState, "paused");
		await delay(200);
		assert.equal(starts(), 1, "Automatic reloads and polls must not wake it");
		assert.equal(activities(), 1, "Nor keep the sandbox alive");
		const active = await fetch("http://127.0.0.1:4320/api/site/activity", {
			method: "POST",
			headers: {
				cookie,
				origin: "http://127.0.0.1:4320",
				"x-studio-action": "studio",
				"content-type": "application/json",
			},
			body: "{}",
		});
		assert.equal(active.status, 200);
		assert.equal(
			active.headers.get("set-cookie"),
			`${cookie}; HttpOnly; SameSite=Strict; Path=/; Max-Age=1200`,
		);
		assert.equal(activities(), 2);
		assert.equal(starts(), 1, "Activity without a wake request starts nothing");
		const reopened = await fetch(
			"http://127.0.0.1:4321/__open?site=idle&wake=1",
			{ redirect: "manual" },
		);
		assert.equal(reopened.status, 302);
		assert.ok(reopened.headers.get("set-cookie"));
		await until(
			() => starts() === 2,
			"An explicit wake starts the saved workspace, unthrottled",
		);
		idle.child.kill("SIGTERM");
		assert.equal(await bounded(idle.exited, 5_000), 0);
		const renewalFailure = JSON.parse(await readFile(metadata, "utf8"))
			.sites[0];
		assert.ok(renewalFailure.workspaceActivity?.id);
		assert.match(renewalFailure.workspaceError, /activity could not be saved/);

		// The live preview never shows upstream errors or the platform's startup
		// page, and never restarts a gone workspace on its own. Owner activity
		// wakes it (throttled); the website itself is relayed without the
		// sandbox's private workspace path.
		let upstreamMode: "missing" | "startup" | "ok" = "missing";
		const upstreamRequests: string[] = [];
		const upstream = createHttpServer((req, res) => {
			upstreamRequests.push(String(req.headers["x-preview-token"]));
			if (upstreamMode === "missing") {
				res.writeHead(404, { "content-type": "text/plain" });
				res.end("Sandbox not found");
			} else if (upstreamMode === "startup") {
				res.writeHead(202, { "content-type": "text/html" });
				res.end(
					'<!doctype html><title>Loading preview · Hoplite</title><h1>Loading preview...</h1><script>fetch("/.hoplite/preview-status")</script>',
				);
			} else {
				res.writeHead(200, { "content-type": "text/html" });
				res.end(
					'<!doctype html><title>Salon</title><style data-vite-dev-id="/tmp/hoplite/workspaces/thr-x/src/styles/tailwind.css"></style><h1>Welcome to the salon</h1>',
				);
			}
		});
		await new Promise<void>((resolve) =>
			upstream.listen(0, "127.0.0.1", () => resolve()),
		);
		const address = upstream.address();
		assert.ok(address && typeof address === "object");
		try {
			const live = launch({
				STUDIO_TEST_WORKSPACE: "1",
				STUDIO_TEST_UPSTREAM: "1",
				HOPLITE_PREVIEW_TRANSPORT_URL: `http://127.0.0.1:${address.port}`,
			});
			children.push(live);
			const liveCalls: string[] = [];
			live.child.on("message", (message) => {
				if (
					typeof message === "object" &&
					message &&
					"path" in message &&
					typeof message.path === "string"
				)
					liveCalls.push(message.path);
			});
			await bounded(live.ready, 25_000);
			const open = await fetch("http://127.0.0.1:4321/__open?site=idle", {
				redirect: "manual",
			});
			const liveCookie = open.headers.get("set-cookie")?.split(";")[0];
			assert.ok(liveCookie);
			const navigate = { cookie: liveCookie, "sec-fetch-dest": "iframe" };
			const liveStarts = () =>
				liveCalls.filter((path) => path.endsWith("/preview/start")).length;
			for (let reload = 0; reload < 3; reload++) {
				const missing = await fetch("http://127.0.0.1:4321/", {
					headers: navigate,
				});
				const missingHtml = await missing.text();
				assert.equal(missing.status, 503);
				assert.match(missingHtml, /Your preview is paused/);
				assert.doesNotMatch(missingHtml, /Sandbox not found|Hoplite/i);
			}
			await delay(200);
			assert.equal(
				liveStarts(),
				0,
				"a gone sandbox is not restarted by reloads",
			);
			const studio = {
				method: "POST",
				headers: {
					origin: "http://127.0.0.1:4320",
					"x-studio-action": "studio",
					"content-type": "application/json",
				},
				body: JSON.stringify({ wake: true }),
			};
			// Background polling of the studio's state never wakes it.
			await fetch("http://127.0.0.1:4320/api/state");
			assert.equal(liveStarts(), 0);
			// Owner activity (typing, studio navigation, returning to the tab) does.
			assert.equal(
				(await fetch("http://127.0.0.1:4320/api/site/activity", studio)).status,
				200,
			);
			await until(() => liveStarts() === 1, "owner activity wakes the preview");
			const woken = await (
				await fetch("http://127.0.0.1:4320/api/state")
			).json();
			assert.equal(woken.previewState, "live");
			upstreamMode = "startup";
			const startup = await fetch("http://127.0.0.1:4321/", {
				headers: navigate,
			});
			const startupHtml = await startup.text();
			assert.equal(startup.status, 503);
			assert.match(startupHtml, /Waking your preview/);
			assert.doesNotMatch(startupHtml, /Hoplite|preview-status/i);
			assert.equal(startup.headers.get("refresh"), "2");
			// More activity within 20 seconds does not restart it again.
			await fetch("http://127.0.0.1:4320/api/site/activity", studio);
			await delay(200);
			assert.equal(liveStarts(), 1, "owner wakes are throttled");
			upstreamMode = "ok";
			const site = await fetch("http://127.0.0.1:4321/", { headers: navigate });
			const siteHtml = await site.text();
			assert.equal(site.status, 200);
			assert.match(siteHtml, /Welcome to the salon/);
			assert.match(siteHtml, /data-vite-dev-id="\/src\/styles\/tailwind\.css"/);
			assert.doesNotMatch(siteHtml, /hoplite/i);
			const settled = await (
				await fetch("http://127.0.0.1:4320/api/state")
			).json();
			assert.equal(settled.previewState, "live");
			assert.ok(upstreamRequests.every((token) => token === "grant"));
			live.child.kill("SIGTERM");
			assert.equal(await bounded(live.exited, 5_000), 0);
		} finally {
			await new Promise<void>((resolve) => upstream.close(() => resolve()));
		}
	} finally {
		for (const { child, exited } of children) {
			if (child.exitCode === null && child.signalCode === null)
				child.kill("SIGKILL");
			await exited;
		}
		await rm(root, { recursive: true, force: true });
	}
});
