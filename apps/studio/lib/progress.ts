import type { Site } from "./types";

/** No new progress for this long: say honestly that it is taking a while. */
export const slowAfterMs = 4 * 60_000;
/** No new progress for this long: offer to start the change again or stop it. */
export const stalledAfterMs = 15 * 60_000;

/**
 * Whether the agent has gone quiet on the current change: "slow" after a few
 * minutes without any new progress, "stalled" after a generous deadline.
 */
export function stallLevel(
	site: Pick<Site, "phase" | "progressAt" | "generations" | "generationId">,
	now = Date.now(),
): "slow" | "stalled" | undefined {
	if (site.phase !== "generating") return;
	const since =
		site.progressAt ??
		site.generations?.find((item) => item.id === site.generationId)?.createdAt;
	if (!since) return;
	const quiet = now - new Date(since).getTime();
	if (quiet >= stalledAfterMs) return "stalled";
	if (quiet >= slowAfterMs) return "slow";
}

/**
 * The status line beside the spinner, driven by the actual pipeline stage.
 * While the agent writes, its own request-specific updates are shown; build,
 * browser checks and automatic repairs have application-owned stage labels.
 */
export function progressLabel(
	site: Pick<
		Site,
		| "phase"
		| "runId"
		| "activity"
		| "qaProgress"
		| "generations"
		| "generationId"
		| "stall"
	>,
): string | null {
	if (site.phase === "building") return "Building your website…";
	if (site.phase === "checking") {
		const progress = site.qaProgress;
		if (!progress?.total) return "Checking every page on phones and computers…";
		if (progress.checked >= progress.total) return "Almost ready…";
		return `Checking every page on phones and computers (${progress.checked} of ${progress.total})…`;
	}
	if (site.phase !== "generating") return null;
	// An update that stopped arriving is never shown as if work were moving.
	if (site.stall) return "Still working — this is taking longer than usual…";
	const generation = site.generations?.find(
		(item) => item.id === site.generationId,
	);
	if ((generation?.attempts.length ?? 0) > 1)
		return "Fixing a couple of small things…";
	return site.activity && site.activity.runId === site.runId
		? site.activity.text
		: null;
}
