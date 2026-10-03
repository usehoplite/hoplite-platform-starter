import { routeLabel } from "./site-pages";
import type { Site, Version } from "./types";

/** Plain-language summaries of versions for the publish dialog and history. */

export function readyVersion(version: Version) {
	return version.qa?.status === "passed" && !version.failure;
}

/**
 * The versions an owner sees: one per change. An automatic repair replaces
 * its change's candidate, so only the change's result (or, while it is
 * still being prepared, its latest candidate) is listed. The ready and
 * published versions always stay visible.
 */
export function ownerVersions(
	site: Pick<
		Site,
		"versions" | "generations" | "publishedVersionId" | "activeVersionId"
	>,
) {
	return site.versions.filter((version) => {
		if (
			!version.generationId ||
			version.id === site.publishedVersionId ||
			version.id === site.activeVersionId
		)
			return true;
		const siblings = site.versions.filter(
			(item) => item.generationId === version.generationId,
		);
		if (siblings.length === 1) return true;
		const result = site.generations?.find(
			(item) => item.id === version.generationId,
		)?.resultVersionId;
		const shown = siblings.some((item) => item.id === result)
			? result
			: siblings.at(-1)?.id;
		return version.id === shown;
	});
}

/**
 * A version's own summary, else a plain default. The owner's request is never
 * shown back to them as if it described the result.
 */
export function versionSummary(
	site: Pick<Site, "generations" | "versions">,
	version: Version,
) {
	if (version.changeSummary?.trim()) return version.changeSummary;
	const generation = site.generations?.find(
		(item) => item.id === version.generationId,
	);
	const first = generation
		? !generation.baseVersionId
		: site.versions[0]?.id === version.id;
	return first ? "Created your website." : "Updated your website.";
}

/**
 * What goes live with a release: every ready change since the published
 * version, oldest first (including the whole new website on a first
 * publish), each with its own summary. Restoring an earlier version (or a
 * first publish of an older one) shows that version alone.
 */
export function releaseChanges(
	site: Pick<
		Site,
		"versions" | "publishedVersionId" | "generations" | "activeVersionId"
	>,
	releaseId: string,
	action: "publish" | "rollback",
) {
	const versions = ownerVersions(site);
	const index = versions.findIndex((item) => item.id === releaseId);
	if (index < 0) return [];
	const release = versions[index];
	const published = versions.findIndex(
		(item) => item.id === site.publishedVersionId,
	);
	const going =
		action === "rollback" || published >= index
			? [release]
			: versions
					.slice(published + 1, index + 1)
					.filter((item) => item === release || readyVersion(item));
	return going.map((item) => ({
		id: item.id,
		label: item.label,
		summary: versionSummary(site, item),
	}));
}

/**
 * One plain line for the versions list: the first sentence or bullet of the
 * change summary (else a plain default), at most about 100 characters.
 */
export function versionLine(
	site: Pick<Site, "generations" | "versions">,
	version: Version,
	limit = 100,
) {
	const source = versionSummary(site, version);
	const first =
		source
			.replace(/\r\n?/g, "\n")
			.split("\n")
			.map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim())
			.find(Boolean) ?? "";
	const plain = first
		.replace(/\*\*(.+?)\*\*|__(.+?)__/g, "$1$2")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
		.replace(/(^|\s)[*_]([^*_]+)[*_](?=\s|[.,!?]|$)/g, "$1$2");
	const sentence = plain.split(/(?<=[.!?])\s+/)[0] ?? plain;
	if (sentence.length <= limit) return sentence;
	const cut = sentence.slice(0, limit);
	return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), limit / 2)).trimEnd()}…`;
}

function list(items: string[]) {
	if (items.length <= 1) return items.join("");
	return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/**
 * A friendly account of the browser checks for owners: which pages, which
 * devices, what was tried and any issues in plain words. The raw report is a
 * staff tool.
 */
export function checkSummary(version: Version) {
	const routes = version.routes?.length ? version.routes : ["/"];
	const pages = routes.map((route) => routeLabel(route));
	const warnings = version.qa?.warnings?.length ?? 0;
	return {
		pages: `${routes.length === 1 ? "1 page" : `${routes.length} pages`} checked: ${list(pages)}`,
		devices: "On phones, tablets and computers",
		tried: [
			"Every page opens and every link works",
			"Booking buttons open your booking page",
			"Contact forms need the required details and consent, and send once",
			"Your prices, services and opening hours show up to date",
			"Text and buttons are readable, and the menu works with a keyboard",
		],
		issues:
			warnings === 0
				? "No issues found"
				: `${warnings === 1 ? "1 small suggestion" : `${warnings} small suggestions`} to make pages easier to read or use. They don’t stop you publishing.`,
	};
}
