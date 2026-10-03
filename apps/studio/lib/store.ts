import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ReleaseObjects } from "./release-storage";
import {
	type Business,
	business,
	type Conversation,
	type Message,
	type PublishIntent,
	type Site,
} from "./types";
export type Database = {
	business: Business;
	/** The organisation's one website. Earlier demo versions saved several sites. */
	siteId?: string;
	sites: Site[];
	brandImports?: {
		id: string;
		sourceUrl: string;
		createdAt: string;
		storage?: ReleaseObjects;
	}[];
	brandReferences?: {
		id: string;
		importId: string;
		assetIds: string[];
		createdAt: string;
	}[];
	brandReferenceId?: string;
};
export const dataRoot = resolve(process.env.STUDIO_DATA_DIR || "../../.data");
export const seedRoot = resolve("seed");
let state: Database;
let pending = Promise.resolve();
export async function database() {
	if (state) return state;
	await mkdir(dataRoot, { recursive: true });
	try {
		state = JSON.parse(await readFile(join(dataRoot, "metadata.json"), "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		state = { business, sites: [] };
		await save();
	}
	return state;
}
export function save() {
	pending = pending
		.catch(() => undefined)
		.then(() => writeSnapshot(JSON.stringify(state, null, 2)));
	return pending;
}
async function writeSnapshot(snapshot: string) {
	const temp = join(dataRoot, "metadata.json.tmp");
	await writeFile(temp, snapshot, { mode: 0o600 });
	await rename(temp, join(dataRoot, "metadata.json"));
}
export function saveBrandReference(
	reference: NonNullable<Database["brandReferences"]>[number],
) {
	pending = pending
		.catch(() => undefined)
		.then(async () => {
			const references = [...(state.brandReferences ?? []), reference];
			await writeSnapshot(
				JSON.stringify(
					{
						...state,
						brandReferences: references,
						brandReferenceId: reference.id,
					},
					null,
					2,
				),
			);
			// Expose the new selection only after its durable commit. A failed save
			// cannot roll back another approval or leak an uncommitted reference.
			state.brandReferences = references;
			state.brandReferenceId = reference.id;
		});
	return pending;
}
export class PublicationConflict extends Error {}
export function commitPublication(
	site: Site,
	versionId: string,
	intent: PublishIntent,
) {
	const commit = pending
		.catch(() => undefined)
		.then(async () => {
			const prior = site.publications?.find((event) => event.id === intent.id);
			if (prior) {
				if (
					prior.versionId !== versionId ||
					prior.previousVersionId !== intent.expectedVersionId ||
					prior.action !== intent.action
				)
					throw new PublicationConflict(
						"This publication request was already used for another release.",
					);
				return prior;
			}
			if (site.deletedAt || !state.sites.includes(site))
				throw new Error("Website not found");
			if ((site.publishedVersionId ?? null) !== intent.expectedVersionId)
				throw new PublicationConflict(
					"The published website changed in another tab. Close this review and check the latest release before publishing.",
				);
			if (intent.action === "rollback" && !site.publishedVersionId)
				throw new Error(
					"Publish a website before restoring an earlier release.",
				);
			const version = site.versions.find((item) => item.id === versionId);
			if (
				!version?.artifactDirectory ||
				version.qa?.status !== "passed" ||
				version.failure
			)
				throw new Error("This release is no longer ready to publish.");
			const event = {
				id: intent.id,
				action: intent.action,
				versionId,
				previousVersionId: intent.expectedVersionId,
				createdAt: new Date().toISOString(),
				actor: "Local demo member",
				qaReport: version.qaReport,
			};
			const publications = [...(site.publications ?? []), event];
			const snapshot: Database = structuredClone(state);
			const target = snapshot.sites.find((item) => item.id === site.id);
			if (!target) throw new Error("Website not found");
			target.publishedVersionId = versionId;
			target.publications = publications;
			target.updatedAt = event.createdAt;
			// Public readers continue seeing the prior release until the pointer and
			// its audit event have both been atomically renamed into the durable file.
			await writeSnapshot(JSON.stringify(snapshot, null, 2));
			site.publishedVersionId = versionId;
			site.publications = publications;
			site.updatedAt = event.createdAt;
			return event;
		});
	// A failed publication must not poison subsequent metadata saves.
	pending = commit.then(
		() => undefined,
		() => undefined,
	);
	return commit;
}
export async function findSite(id: string) {
	const site = (await database()).sites.find(
		(s) => s.id === id && !s.deletedAt,
	);
	if (!site) throw new Error("Website not found");
	return site;
}

/**
 * Site Studio gives each organisation exactly one website. Metadata from earlier
 * demo versions can hold several; the most recently created one becomes the
 * organisation's website and the others stay saved but unreachable.
 * STUDIO_SITE_ID selects a different saved site for local development.
 */
export function organisationSite(db: Database) {
	const live = db.sites.filter((site) => !site.deletedAt);
	const pinned = process.env.STUDIO_SITE_ID || db.siteId;
	return (
		live.find((site) => site.id === pinned) ??
		live.reduce<Site | undefined>(
			(latest, site) =>
				!latest || (site.createdAt ?? "") > (latest.createdAt ?? "")
					? site
					: latest,
			undefined,
		)
	);
}

export function conversationTitle(prompt: string) {
	const text = prompt.trim().replace(/\s+/g, " ");
	return text.length > 60 ? `${text.slice(0, 59)}…` : text || "New change";
}

/** Conversations including, for older metadata, the single implicit one. */
export function siteConversations(site: Site): Conversation[] {
	if (site.conversations?.length) return site.conversations;
	if (!site.threadId && !site.messages.length) return [];
	const first = site.messages.find((message) => message.role === "user");
	return [
		{
			id: `legacy-${site.id}`,
			title: conversationTitle(first?.content ?? "Earlier changes"),
			threadId: site.threadId,
			createdAt: site.createdAt,
			updatedAt: site.updatedAt,
		},
	];
}

/**
 * The chat a customer sees: their requests and one reply per change. The
 * reply is the final message of the change's first run. Progress commentary,
 * automatic repairs and a run still in progress stay internal.
 */
export function customerMessages(site: Site): Message[] {
	const shown: Message[] = [];
	let replies: Message[] = [];
	const flush = () => {
		const run = replies.find((message) => message.runId)?.runId;
		const reply = (
			run ? replies.filter((message) => message.runId === run) : replies
		).at(-1);
		if (reply && !(run && site.phase === "generating" && run === site.runId))
			shown.push(reply);
		replies = [];
	};
	for (const message of site.messages) {
		if (message.role === "user") {
			flush();
			shown.push(message);
		} else replies.push(message);
	}
	flush();
	return shown;
}

/** Records the implicit conversation of older metadata before it changes. */
export function ensureConversations(site: Site) {
	if (site.conversations?.length) return site.conversations;
	site.conversations = siteConversations(site).map((item) => ({ ...item }));
	const legacy = site.conversations[0];
	if (legacy) {
		for (const message of site.messages) message.conversationId ??= legacy.id;
		for (const generation of site.generations ?? [])
			generation.conversationId ??= legacy.id;
		site.conversationId ??= legacy.id;
	}
	return site.conversations;
}

/** Hides a conversation. The website, its drafts and releases are unchanged. */
export async function deleteConversation(site: Site, id: string) {
	const conversation = siteConversations(site).find((item) => item.id === id);
	if (!conversation) return "not-found";
	if (conversation.deletedAt) return "deleted";
	if (
		["generating", "building", "checking"].includes(site.phase) ||
		site.generations?.some(
			(generation) =>
				generation.id === site.generationId &&
				generation.status === "admitting",
		)
	)
		return "busy";
	const saved = ensureConversations(site).find((item) => item.id === id);
	if (!saved) return "not-found";
	saved.deletedAt = new Date().toISOString();
	// A change still waiting in this conversation is withdrawn with it.
	const queued = site.queuedChange;
	if (queued?.conversationId === id) site.queuedChange = undefined;
	try {
		await save();
	} catch (error) {
		saved.deletedAt = undefined;
		if (queued?.conversationId === id) site.queuedChange = queued;
		throw error;
	}
	return "deleted";
}
