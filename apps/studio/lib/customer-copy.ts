import type { Generation, GenerationFailure, Message, Site } from "./types";

/**
 * Customer-facing wording. Business owners never see platform names, error
 * codes or technical detail; those stay in server logs and stored evidence.
 */

/**
 * The agent's own work failed only when a repairable check (source, build
 * command, browser) still fails. Anything else after a draft was saved —
 * build infrastructure, unknown platform errors, timeouts, storage — is
 * retried by rebuilding the same draft rather than writing it again.
 */
export function rebuildable(failure: GenerationFailure | undefined) {
	return Boolean(
		failure &&
			failure.category !== "repairable" &&
			(failure.stage === "build" || failure.stage === "browser"),
	);
}

export type FailureKind =
	/** A saved draft could not be finished (build/check infrastructure). */
	| "rebuild"
	/** A saved draft ran out of time while being prepared. */
	| "deadline"
	/** The change itself could not be made (no draft to rebuild). */
	| "regenerate"
	/** Automatic repairs could not make the change pass its checks. */
	| "repair_exhausted"
	/** The request was definitely refused before anything started. */
	| "not_started"
	/** The request may or may not have started; retry resumes the same one. */
	| "uncertain";

/** `hasReady`: whether an earlier ready version exists to fall back on. */
export function failureMessage(kind: FailureKind, hasReady: boolean) {
	const safe = hasReady ? " Your previous version is still safe." : "";
	switch (kind) {
		case "rebuild":
			return `We couldn't finish getting this version ready because of a temporary problem on our side. Choose “Try again” to finish the same version.${safe}`;
		case "deadline":
			return `This version took too long to get ready. Choose “Try again” to finish the same version.${safe}`;
		case "regenerate":
			return `We couldn't finish this change because of a temporary problem on our side. Choose “Try again” to make it again.${safe}`;
		case "repair_exhausted":
			return `We couldn't get this change right automatically. Choose “Try again”, or describe the change a little differently.${safe}`;
		case "not_started":
			return `We couldn't start this change because our website service is unavailable right now. Nothing was changed. Please try again in a few minutes.`;
		case "uncertain":
			return `We lost the connection while starting this change. Choose “Try again” and we'll pick up the same request, so nothing is done twice.${safe}`;
	}
}

type PlatformError = Error & { status: number; code: string };
function platformError(error: Error): error is PlatformError {
	return (
		error.name === "HopliteError" &&
		"status" in error &&
		typeof error.status === "number" &&
		"code" in error &&
		typeof error.code === "string"
	);
}

/** Maps any error to text a business owner can act on. */
export function customerErrorMessage(error: Error) {
	if (platformError(error)) {
		if (error.code === "platform_api_not_enabled")
			return "Website creation isn't switched on for your account yet. Please contact Site Studio support.";
		if (error.status === 401 || error.status === 403)
			return "We couldn't connect to our website service. Please contact Site Studio support.";
		if (error.status === 429)
			return "Our website service is busy. Please try again in a minute.";
		if (error.status === 0 || error.status >= 500)
			return "Our website service is unavailable right now. Please try again in a few minutes.";
		return "We couldn't make that change. Please try again.";
	}
	if (error instanceof SyntaxError)
		return "We couldn't read that request. Refresh the page and try again.";
	return error.message || "Something went wrong. Please try again.";
}

/** Notes about the agent's own tooling, never facts about the website. */
const internalNote =
	/\bI (?:haven't|have not|couldn't|could not|wasn't|was not|can't|cannot|am unable to|was unable to|didn't|did not)\b[^.!?\n]*\b(?:view|see|preview|open|load|screenshot|browse|check|test|verify|run|access|look)\b|\b(?:npm|pnpm|astro|tailwind|typescript|type ?check(?:s|ed)?|linter|lint|dev server|localhost|sandbox|repository|git|commit(?:ted)?|terminal|screenshots?|source files?|\w+\.(?:astro|css|js|ts|json))\b|\b(?:the )?build (?:passed|passes|succeeded|failed|output|step|command|checks?)\b/i;

function words(text: string) {
	return text.split(/\s+/).filter(Boolean).length;
}

/**
 * Keeps an agent's change summary short and plain: at most five sentences
 * (a bulleted list counts as one) and about 80 words, without notes about its
 * own tooling such as "I haven't been able to view the pages". Sentences are
 * kept or dropped whole. A list that does not fit keeps its lead-in and its
 * first items, then "…and more", so a long summary is never emptied.
 */
export function customerSummary(text: string, maxSentences = 5, maxWords = 80) {
	const units: { bullet: boolean; text: string; paragraph: number }[] = [];
	let paragraph = 0;
	for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) {
			paragraph++;
			continue;
		}
		const bullet = /^([-*•]|\d+[.)])\s+/.test(trimmed);
		if (bullet) {
			const item = trimmed.replace(/^([-*•]|\d+[.)])\s+/, "");
			if (!internalNote.test(item))
				units.push({ bullet: true, text: item, paragraph });
			paragraph++;
			continue;
		}
		for (const sentence of trimmed.split(/(?<=[.!?])\s+(?=[A-Z"“(])/)) {
			const clean = sentence.trim();
			if (clean && !internalNote.test(clean))
				units.push({ bullet: false, text: clean, paragraph });
		}
	}
	// Consecutive bullets form one list, which counts as one sentence.
	const groups: (typeof units)[] = [];
	for (const unit of units) {
		const last = groups.at(-1);
		if (unit.bullet && last?.[0].bullet) last.push(unit);
		else groups.push([unit]);
	}
	const cutWords = (value: string, limit: number) => {
		const parts = value.split(/\s+/);
		return parts.length <= limit
			? value
			: `${parts.slice(0, Math.max(1, limit)).join(" ")}…`;
	};
	const kept: typeof units = [];
	let total = 0;
	let sentences = 0;
	for (const group of groups) {
		if (sentences >= maxSentences) break;
		const count = group.reduce((sum, unit) => sum + words(unit.text), 0);
		if (total + count <= maxWords) {
			kept.push(...group);
			total += count;
			sentences++;
			continue;
		}
		if (group[0].bullet) {
			// Keep the first items that fit (at least one, shortened if it must
			// be), then say there is more, rather than dropping the whole list.
			const shown: typeof units = [];
			for (const unit of group) {
				const size = words(unit.text);
				if (shown.length && total + size > maxWords) break;
				const room = Math.max(maxWords - total, 12);
				shown.push({ ...unit, text: cutWords(unit.text, room) });
				total += Math.min(size, room);
			}
			kept.push(...shown);
			if (shown.length < group.length)
				kept.push({ ...group[0], text: "…and more" });
		} else if (!kept.length)
			kept.push({ ...group[0], text: cutWords(group[0].text, maxWords) });
		break;
	}
	// A lead-in such as "Here's what changed:" never dangles without its list.
	while (
		kept.length > 1 &&
		!kept.at(-1)?.bullet &&
		kept.at(-1)?.text.endsWith(":")
	)
		kept.pop();
	let output = "";
	let previous: (typeof units)[number] | undefined;
	for (const unit of kept) {
		if (!previous) output = unit.bullet ? `- ${unit.text}` : unit.text;
		else if (unit.bullet)
			output += `\n${previous.bullet ? "" : "\n"}- ${unit.text}`;
		else if (previous.bullet || previous.paragraph !== unit.paragraph)
			output += `\n\n${unit.text}`;
		else output += ` ${unit.text}`;
		previous = unit;
	}
	return output.trim();
}

/**
 * The chat line for a reply with nothing customer-facing left after trimming
 * (for example, only notes about the agent's tooling). It says what actually
 * happened to that change: never "ready" for a version that is not.
 */
export function replyFallback(
	site: Pick<
		Site,
		"generations" | "versions" | "activeVersionId" | "businessProposal"
	>,
	message: Pick<Message, "runId">,
) {
	const generation = message.runId
		? site.generations?.find((item) =>
				item.attempts.some((attempt) => attempt.runId === message.runId),
			)
		: undefined;
	if (!generation) return "Thanks, we’ve noted this change.";
	if (site.businessProposal?.generationId === generation.id)
		return "I’ve prepared an update to your business details. Check it below and choose “Update” to show it on your website.";
	if (generation.proposedBusinessChange)
		return "I suggested an update to your business details.";
	const version = site.versions.find(
		(item) => item.id === generation.resultVersionId,
	);
	if (generation.status === "ready")
		return !version
			? "Nothing on your website needed to change for this."
			: generation.baseVersionId
				? "Your changes are ready to look at in the preview."
				: "Your new website is ready to look at.";
	if (generation.status === "failed")
		return site.activeVersionId
			? "This version isn’t ready yet. Your previous version is still safe."
			: "Your website isn’t ready yet.";
	return "We’re getting this version ready.";
}

/**
 * A generation as the browser may see it. The wrapped agent instructions
 * (`requestPrompt`) and technical failure detail stay on the server; the
 * owner's own words (`prompt`) and each attempt's outcome are enough for the
 * interface.
 */
export function publicGeneration(generation: Generation) {
	return {
		...generation,
		attempts: generation.attempts.map(({ requestPrompt, ...attempt }) => ({
			...attempt,
			failure: attempt.failure && { ...attempt.failure, errors: [] },
		})),
	};
}
