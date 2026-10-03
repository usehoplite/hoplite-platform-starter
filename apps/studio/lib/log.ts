/**
 * Server-side structured log lines for operators. Customers never see these;
 * they see plain messages from lib/customer-copy.ts. Never log prompts,
 * request bodies or other customer content here.
 */
type Detail = Record<string, string | number | boolean | undefined>;

function serialize(error: Error): Detail {
	const cause = error.cause instanceof Error ? error.cause : undefined;
	return {
		error: error.message,
		errorName: error.name,
		status:
			"status" in error && typeof error.status === "number"
				? error.status
				: undefined,
		code:
			"code" in error && typeof error.code === "string"
				? error.code
				: undefined,
		stack: error.stack,
		cause: cause
			? `${cause.name}: ${cause.message}${"code" in cause && typeof cause.code === "string" ? ` (${cause.code})` : ""}`
			: undefined,
	};
}

/**
 * Lines logged under the Node test runner, which treats unexpected stderr as
 * a failure. Tests assert on these instead.
 */
export const capturedLogs: Detail[] = [];

/** `event` follows `domain.action.outcome`, e.g. `generation.admission.failed`. */
export function logStudioError(
	event: string,
	error: Error,
	detail: Detail = {},
) {
	const line: Detail = {
		time: new Date().toISOString(),
		level: "error",
		event,
		...detail,
		...serialize(error),
	};
	if (process.env.NODE_TEST_CONTEXT) capturedLogs.push(line);
	else process.stderr.write(`${JSON.stringify(line)}\n`);
}
