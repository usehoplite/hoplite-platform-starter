import type { JsonValue } from "./types";
/** Customer-side adapter. Hoplite credentials and preview grants never reach React. */
export type SourceFile = {
	path: string;
	content: string;
	encoding?: "utf8" | "base64";
};
/**
 * A platform request failed. The message is for server logs only; customers
 * see `customerErrorMessage` (lib/customer-copy.ts).
 *
 * `delivered`: false when the request definitely never reached the platform
 * (connection refused, DNS failure), so it cannot have committed.
 */
export class HopliteError extends Error {
	override name = "HopliteError";
	readonly delivered: boolean;
	constructor(
		readonly status: number,
		readonly code: string,
		options?: { cause?: Error; delivered?: boolean },
	) {
		super(`Platform request failed: ${code}`, { cause: options?.cause });
		this.delivered = options?.delivered ?? true;
	}
}

const undeliveredCodes = new Set([
	"ECONNREFUSED",
	"ENOTFOUND",
	"EAI_AGAIN",
	"EHOSTUNREACH",
	"ENETUNREACH",
]);
/** A fetch rejection whose cause proves the request was never sent. */
function undelivered(error: Error) {
	let current: Error | undefined = error;
	for (let depth = 0; current && depth < 5; depth++) {
		if (
			"code" in current &&
			typeof current.code === "string" &&
			undeliveredCodes.has(current.code)
		)
			return true;
		current = current.cause instanceof Error ? current.cause : undefined;
	}
	return false;
}

/**
 * Whether a failed write definitely did not happen. A client error, a 501/503
 * carrying the platform's own error code, or a connection that was never made
 * is a definite answer. Timeouts, dropped connections, 500s and gateway
 * errors leave the outcome unknown, so the same operation must be replayed.
 */
export function definitelyFailed(error: Error) {
	if (!(error instanceof HopliteError)) return false;
	if (error.status === 0) return !error.delivered;
	if (error.status >= 400 && error.status < 500)
		return ![408, 409, 429].includes(error.status);
	return (
		(error.status === 503 || error.status === 501) &&
		!/^HTTP \d+$/.test(error.code)
	);
}
export class Hoplite {
	constructor(
		readonly baseUrl = process.env.HOPLITE_API_URL || "",
		private readonly key = process.env.HOPLITE_SERVICE_KEY || "",
	) {
		if (
			baseUrl &&
			new URL(baseUrl).protocol !== "https:" &&
			!["127.0.0.1", "localhost"].includes(new URL(baseUrl).hostname)
		)
			throw new Error("Hoplite requires HTTPS outside localhost");
	}
	/**
	 * The platform rate-limits each key. After a 429 every request waits out
	 * its Retry-After instead of retrying into the same window, which would
	 * keep the key limited for as long as the studio keeps polling.
	 */
	private resumeAt = 0;
	get configured() {
		return Boolean(this.baseUrl) && Boolean(this.key);
	}
	async response(
		path: string,
		body?: JsonValue,
		operationId?: string,
		timeoutMs = 120000,
	): Promise<Response> {
		if (!this.configured)
			throw new Error(
				"The local Hoplite connection is not configured. Set HOPLITE_API_URL and HOPLITE_SERVICE_KEY in .env or the server's environment.",
			);
		for (let attempt = 1; ; attempt++) {
			let wait = this.resumeAt - Date.now();
			while (wait > 0) {
				await new Promise((resolve) => setTimeout(resolve, wait));
				// An in-flight request can extend the cooldown while we wait.
				wait = this.resumeAt - Date.now();
			}
			try {
				return await this.send(path, body, operationId, timeoutMs);
			} catch (error) {
				if (!(error instanceof HopliteError) || error.status !== 429)
					throw error;
				// Reads are safe to repeat once the window reopens; writes report
				// the 429 so their callers replay them under the same operation.
				if (body !== undefined || attempt > 1) throw error;
			}
		}
	}
	private async send(
		path: string,
		body: JsonValue | undefined,
		operationId: string | undefined,
		timeoutMs: number,
	): Promise<Response> {
		const requestUrl = new URL(path, this.baseUrl);
		const response = await fetch(requestUrl, {
			method: body === undefined ? "GET" : "POST",
			headers: {
				Authorization: `Bearer ${this.key}`,
				...(body === undefined
					? {}
					: {
							"Content-Type": "application/json",
							"Idempotency-Key": operationId || crypto.randomUUID(),
						}),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(timeoutMs),
			redirect: "error",
		}).catch((error: Error) => {
			// A disconnected response does not establish whether a write committed,
			// unless the connection was never made at all.
			const delivered = !undelivered(error);
			throw new HopliteError(
				0,
				delivered ? "connection_interrupted" : "connection_refused",
				{ cause: error, delivered },
			);
		});
		if (response.status === 429) {
			const seconds = Number(response.headers.get("retry-after"));
			const waitMs =
				Number.isFinite(seconds) && seconds > 0
					? Math.min(seconds, 60) * 1000
					: 10_000;
			this.resumeAt = Math.max(this.resumeAt, Date.now() + waitMs);
		}
		if (!response.ok) {
			let code = `HTTP ${response.status}`;
			try {
				const error = await response.json();
				code = error.error?.code || error.error || error.code || code;
				if (typeof code !== "string") code = `HTTP ${response.status}`;
			} catch {
				// Non-JSON error responses keep the HTTP status as the error code.
			}
			throw new HopliteError(response.status, code);
		}
		return response;
	}
	async json<T>(
		path: string,
		body?: JsonValue,
		operationId?: string,
		timeoutMs = 120000,
	): Promise<T> {
		const response = await this.response(path, body, operationId, timeoutMs);
		return response.json().catch((error: Error) => {
			throw new HopliteError(0, "response_interrupted", { cause: error });
		}) as Promise<T>;
	}
	app(id: string) {
		return `/api/platform/v1/apps/${encodeURIComponent(id)}`;
	}
}
