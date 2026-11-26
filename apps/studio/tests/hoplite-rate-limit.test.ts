import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { Hoplite, HopliteError } from "../lib/hoplite";

test("queued requests honor an extended rate-limit window", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
	const laterLimit = Promise.withResolvers<Response>();
	const requests: { path: string; time: number }[] = [];
	t.mock.method(globalThis, "fetch", async (url: URL) => {
		requests.push({ path: url.pathname, time: Date.now() });
		if (requests.length === 1) {
			return new Response(null, {
				status: 429,
				headers: { "Retry-After": "1" },
			});
		}
		if (requests.length === 2) return laterLimit.promise;
		return new Response(null, { status: 200 });
	});
	const client = new Hoplite("https://hoplite.example", "test-key");
	const first = client.response("/first");
	const second = client.response("/second");
	await setImmediate();
	const queued = client.response("/queued", {}, "queued-operation");

	t.mock.timers.tick(500);
	laterLimit.resolve(
		new Response(null, { status: 429, headers: { "Retry-After": "3" } }),
	);
	await setImmediate();

	t.mock.timers.tick(500);
	await setImmediate();
	assert.deepEqual(
		requests,
		[
			{ path: "/first", time: 0 },
			{ path: "/second", time: 0 },
		],
		"requests are still held after the original deadline",
	);

	t.mock.timers.tick(2500);
	await Promise.all([first, second, queued]);
	assert.deepEqual(
		requests.slice(2).map(({ path }) => path).sort(),
		["/first", "/queued", "/second"],
	);
	assert.ok(requests.slice(2).every(({ time }) => time === 3500));
});

test("a rate-limited write is replayed only by its caller with the same key", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
	const requests: { key: string | null; time: number }[] = [];
	t.mock.method(globalThis, "fetch", async (_url: URL, init: RequestInit) => {
		requests.push({
			key: new Headers(init.headers).get("Idempotency-Key"),
			time: Date.now(),
		});
		return requests.length === 1
			? new Response(null, { status: 429, headers: { "Retry-After": "1" } })
			: new Response(null, { status: 200 });
	});
	const client = new Hoplite("https://hoplite.example", "test-key");
	await assert.rejects(
		client.response("/write", {}, "operation"),
		(error) => error instanceof HopliteError && error.status === 429,
	);
	const retry = client.response("/write", {}, "operation");
	t.mock.timers.tick(999);
	await setImmediate();
	assert.deepEqual(requests, [{ key: "operation", time: 0 }]);

	t.mock.timers.tick(1);
	await retry;
	assert.deepEqual(requests, [
		{ key: "operation", time: 0 },
		{ key: "operation", time: 1000 },
	]);
});

test("a read stops after its one rate-limit retry", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
	const requests: number[] = [];
	t.mock.method(globalThis, "fetch", async () => {
		requests.push(Date.now());
		return new Response(null, { status: 429, headers: { "Retry-After": "1" } });
	});
	const client = new Hoplite("https://hoplite.example", "test-key");
	const failedRead = assert.rejects(
		client.response("/read"),
		(error) => error instanceof HopliteError && error.status === 429,
	);
	await setImmediate();

	t.mock.timers.tick(1000);
	await setImmediate();
	t.mock.timers.tick(1000);
	await setImmediate();
	assert.deepEqual(requests, [0, 1000]);
	await failedRead;
});
