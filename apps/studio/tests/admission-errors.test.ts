import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { customerErrorMessage } from "../lib/customer-copy";
import { definitelyFailed, Hoplite, HopliteError } from "../lib/hoplite";
import { capturedLogs } from "../lib/log";
import type { JsonValue, Site } from "../lib/types";

const root = await mkdtemp(join(tmpdir(), "studio-admission-errors-"));
process.env.STUDIO_DATA_DIR = root;
after(() => rm(root, { recursive: true, force: true }));

test("definite failures are told apart from uncertain outcomes", () => {
	const cases: [HopliteError, boolean][] = [
		[new HopliteError(503, "source_storage_unavailable"), true],
		[new HopliteError(501, "not_implemented"), true],
		[new HopliteError(400, "invalid_request"), true],
		[new HopliteError(403, "platform_api_not_enabled"), true],
		[new HopliteError(0, "connection_refused", { delivered: false }), true],
		// The platform may have committed before these answers.
		[new HopliteError(503, "HTTP 503"), false],
		[new HopliteError(500, "internal_error"), false],
		[new HopliteError(502, "HTTP 502"), false],
		[new HopliteError(504, "HTTP 504"), false],
		[new HopliteError(408, "HTTP 408"), false],
		[new HopliteError(409, "operation_outcome_pending"), false],
		[new HopliteError(0, "connection_interrupted"), false],
	];
	for (const [error, definite] of cases)
		assert.equal(
			definitelyFailed(error),
			definite,
			`${error.status} ${error.code}`,
		);
	assert.equal(definitelyFailed(new Error("local")), false);
});

test("a refused connection keeps its cause and is known not to have been sent", async () => {
	const original = globalThis.fetch;
	globalThis.fetch = async () => {
		throw new TypeError("fetch failed", {
			cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9"), {
				code: "ECONNREFUSED",
			}),
		});
	};
	try {
		const client = new Hoplite("http://127.0.0.1:9", "key");
		const failed = (caught: HopliteError) => caught;
		const error = await client.json<null>("/x", {}).catch(failed);
		assert.ok(error instanceof HopliteError);
		assert.equal(error.code, "connection_refused");
		assert.equal(error.delivered, false);
		assert.ok(error.cause instanceof TypeError, "the fetch error is kept");
		assert.equal(definitelyFailed(error), true);
		assert.doesNotMatch(error.message, /Hoplite/);
		globalThis.fetch = async () => {
			throw new DOMException("The operation timed out.", "TimeoutError");
		};
		const timeout = await client.json<null>("/x", {}).catch(failed);
		assert.ok(timeout instanceof HopliteError);
		assert.equal(timeout.code, "connection_interrupted");
		assert.equal(definitelyFailed(timeout), false);
	} finally {
		globalThis.fetch = original;
	}
});

test("customers see plain messages, never platform names or codes", () => {
	const messages = [
		customerErrorMessage(new HopliteError(403, "platform_api_not_enabled")),
		customerErrorMessage(new HopliteError(401, "unauthorized")),
		customerErrorMessage(new HopliteError(429, "rate_limited")),
		customerErrorMessage(new HopliteError(503, "source_storage_unavailable")),
		customerErrorMessage(new HopliteError(0, "connection_interrupted")),
		customerErrorMessage(new HopliteError(422, "invalid_source")),
		customerErrorMessage(new SyntaxError("Unexpected token < in JSON")),
	];
	for (const message of messages) {
		assert.doesNotMatch(
			message,
			/Hoplite|platform|_|HTTP|\d{3}|JSON|token/i,
			message,
		);
		assert.ok(message.length > 20);
	}
	assert.match(messages[0], /contact Site Studio support/);
});

test("a definite failure fails the change plainly and retry makes a fresh request; an uncertain one replays", async () => {
	const { database } = await import("../lib/store");
	const { hoplite, sendMessage, retryGeneration } = await import(
		"../lib/service"
	);
	const db = await database();
	Object.defineProperty(hoplite, "configured", { value: true });
	const original = hoplite.json;
	const operations: string[] = [];
	let failure: HopliteError | undefined = new HopliteError(
		503,
		"source_storage_unavailable",
	);
	hoplite.json = async <T>(
		path: string,
		body?: JsonValue,
		operationId?: string,
	): Promise<T> => {
		if (path.endsWith("/threads") && body !== undefined) {
			operations.push(operationId ?? "");
			if (failure) throw failure;
			return { thread: { id: "thread" }, run: { id: "run" } } as T;
		}
		if (path.endsWith("/workspace/activity")) return { ok: true } as T;
		throw new Error(`Unexpected API call: ${path}`);
	};
	const createdAt = new Date().toISOString();
	const site: Site = {
		id: "site",
		appId: "app",
		name: "Test",
		createdAt,
		updatedAt: createdAt,
		sourceId: "seed",
		phase: "idle",
		messages: [],
		versions: [],
		previewRevision: 0,
	};
	db.sites = [site];
	try {
		await sendMessage(site, "Make the website");
		const first = site.generations?.at(-1);
		assert.equal(first?.status, "failed");
		assert.equal(site.phase, "failed");
		assert.match(site.error ?? "", /couldn't start this change/);
		assert.match(site.error ?? "", /Nothing was changed/);
		assert.doesNotMatch(site.error ?? "", /confirm|Hoplite|source_storage/);
		const logged = capturedLogs.findLast(
			(line) => line.event === "generation.admission.failed",
		);
		assert.equal(logged?.outcome, "definite");
		assert.equal(logged?.code, "source_storage_unavailable");
		assert.equal(
			JSON.stringify(logged).includes("Make the website"),
			false,
			"prompts are never logged",
		);

		// Retry is a fresh request, not a replay of the refused one.
		failure = new HopliteError(0, "connection_interrupted");
		await retryGeneration(site);
		assert.equal(operations.length, 2);
		assert.notEqual(operations[1], operations[0]);
		const second = site.generations?.at(-1);
		assert.notEqual(second?.id, first?.id);
		assert.equal(second?.status, "admitting");
		assert.match(site.error ?? "", /lost the connection/);
		assert.match(site.error ?? "", /nothing is done twice/);

		// An uncertain outcome replays the same operation.
		failure = undefined;
		await retryGeneration(site);
		assert.equal(operations[2], operations[1]);
		assert.equal(site.generations?.at(-1)?.status, "running");
		assert.equal(site.phase, "generating");
	} finally {
		hoplite.json = original;
	}
});
