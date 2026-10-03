import type { WeeklyHours } from "./hours";
import type { ReleaseObjects } from "./release-storage";

export type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonValue[]
	| JsonObject;
export type JsonObject = { [key: string]: JsonValue | undefined };

export type Message = {
	id: string;
	/** "system" is a neutral status line, never words put in the owner's mouth. */
	role: "user" | "assistant" | "system";
	content: string;
	time: string;
	/** Absent on messages saved before conversations; they belong to the earlier one. */
	conversationId?: string;
	/** The Platform run that wrote an assistant message. */
	runId?: string;
};
/** A customer conversation. Every conversation edits the organisation's one website. */
export type Conversation = {
	id: string;
	title: string;
	/** The Platform thread this conversation used most recently. */
	threadId?: string;
	createdAt: string;
	updatedAt: string;
	deletedAt?: string;
};
export type GenerationFailure = {
	category: "repairable" | "infrastructure" | "integration" | "unsupported";
	stage: "generation" | "source" | "build" | "browser";
	errors: string[];
	/**
	 * Quick-check findings only: the candidate is otherwise publishable and
	 * becomes the ready draft if its one repair does not succeed.
	 */
	advisory?: boolean;
};
export type Generation = {
	id: string;
	prompt: string;
	conversationId?: string;
	baseVersionId?: string;
	resultVersionId?: string;
	status: "admitting" | "running" | "checking" | "ready" | "failed";
	createdAt: string;
	finishedAt?: string;
	/** Its reply proposed a business-details change (see BusinessProposal). */
	proposedBusinessChange?: boolean;
	attempts: {
		id: string;
		requestPrompt?: string;
		queuedMessageId?: string;
		runId?: string;
		versionId?: string;
		failure?: GenerationFailure;
	}[];
};
export type QAEvidence = {
	route: string;
	url: string;
	viewport: { width: number; height: number };
	action: string;
	expected: string;
	actual: string;
	status: "passed" | "failed" | "warning";
	screenshot?: string;
	console: string[];
	network: string[];
};
export type Version = {
	id: string;
	sourceId: string;
	sourceChecked?: boolean;
	generationId?: string;
	runId?: string;
	label: string;
	changeSummary?: string;
	/** An automatic repair's own note; kept out of the customer's chat. */
	repairSummary?: string;
	createdAt: string;
	buildId?: string;
	buildOperationId?: string;
	buildLogRetryStartedAt?: string;
	/** When the current build was admitted; bounds the studio-side deadline. */
	buildStartedAt?: string;
	/** When admission of the current build was first requested (not yet admitted). */
	buildRequestedAt?: string;
	/** A build the studio gave up on that may still hold the workspace. */
	abandonedBuildId?: string;
	/** When browser checks started for this candidate (checks on only). */
	checksStartedAt?: string;
	/** Visitor-facing pages in this version's source, for the page picker. */
	routes?: string[];
	previewWaitStartedAt?: string;
	failure?: GenerationFailure;
	qa?: {
		status: "passed" | "failed";
		failureCategory?: GenerationFailure["category"];
		checks: string[];
		errors: string[];
		screenshots: string[];
		warnings?: string[];
		evidence?: QAEvidence[];
		/** False when Site Studio's browser checks were off for this version. */
		browserChecks?: boolean;
	};
	artifactDirectory?: string;
	storage?: ReleaseObjects;
	qaReport?: string;
	/** The website's own booking-button colours, used on the booking page. */
	bookingStyle?: { background: string; color: string };
};
export type BusinessProposal = {
	id: string;
	conversationId?: string;
	generationId: string;
	runId?: string;
	/** The validated change, re-applied to the current details on confirm. */
	patch: JsonObject;
	/** Plain wording for the confirmation card. */
	title: string;
	changes: string[];
	/** Hash of the details the card describes; a mismatch means they changed. */
	baseline?: string;
	createdAt: string;
};
export type Publication = {
	id: string;
	action: "publish" | "rollback";
	versionId: string;
	previousVersionId: string | null;
	createdAt: string;
	actor: string;
	qaReport?: string;
};
export type PublishIntent = {
	id: string;
	action: Publication["action"];
	expectedVersionId: string | null;
};
export type Site = {
	designSeed?: "blank";
	starterVersion?: "2";
	/**
	 * Revision of the Studio-owned foundation files (Site Kit, legacy Astro
	 * config). Absent on websites saved before revision 2; every saved website
	 * keeps its original bytes so its source gates still match. Revision 3 adds
	 * tappable phone/email links and team bios; revision 4 adds each service's
	 * own booking text and card counts on the service and team lists.
	 */
	foundationRevision?: 2 | 3 | 4;
	/**
	 * A business-details change the agent proposed from something the owner
	 * said in chat. Validated when proposed and again when the owner confirms;
	 * nothing changes until they choose "Update".
	 */
	businessProposal?: BusinessProposal;
	/** The Hoplite Platform app for this website (externalId = site id). */
	appId?: string;
	id: string;
	name: string;
	createdAt: string;
	updatedAt: string;
	deletedAt?: string;
	threadId?: string;
	workspaceActivity?: { id: string; threadId: string; lastAttemptAt?: number };
	workspaceError?: string;
	brandReferenceId?: string;
	sourceId?: string;
	runId?: string;
	activity?: { runId: string; text: string };
	/** When the current change last showed any progress (admission, messages). */
	progressAt?: string;
	/** Computed for the browser: the agent has gone quiet (see lib/progress.ts). */
	stall?: "slow" | "stalled";
	/**
	 * The workspace no longer matches the ready version (a failed repair was
	 * set aside): the preview shows the saved ready version and the next change
	 * starts a fresh thread from it.
	 */
	restartFromReady?: boolean;
	/** A request sent while another change was running; starts when idle. */
	queuedChange?: {
		id: string;
		prompt: string;
		conversationId: string;
		createdAt: string;
	};
	/** Browser-check progress for the candidate being checked (page visits). */
	qaProgress?: { checked: number; total: number };
	buildVersionId?: string;
	generationId?: string;
	generations?: Generation[];
	phase: "idle" | "generating" | "building" | "checking" | "failed";
	error?: string;
	messages: Message[];
	conversations?: Conversation[];
	/** The conversation whose thread holds the current draft workspace (threadId). */
	conversationId?: string;
	versions: Version[];
	publishedVersionId?: string;
	publications?: Publication[];
	activeVersionId?: string;
	previewRevision: number;
};
export type StudioState = {
	previewGatewayId: string;
	/** Public origins of the preview gateway and the published website. */
	previewOrigin: string;
	sitesOrigin: string;
	/** The organisation's one website; null until onboarding creates it. */
	site: Site | null;
	configured: boolean;
	/** Site Studio's STUDIO_QA_CHECKS setting; drives the progress wording. */
	browserChecks: boolean;
	business: Business;
	/** What the live preview is doing, as last observed by the gateway. */
	previewState: "paused" | "waking" | "live" | null;
	/** Staff/developer tools such as the raw check report are available. */
	staff: boolean;
};
export type Business = {
	name: string;
	category: string;
	description: string;
	email: string;
	phone: string;
	address: string;
	/** The opening-hours text Site Kit shows; derived from `weeklyHours` when set. */
	hours: string;
	/** Opening hours set day by day in Business details (a missing day is closed). */
	weeklyHours?: WeeklyHours;
	/** ISO 4217 code for service prices; Site Kit defaults to EUR. */
	currency?: string;
	/** Visible text of each service's booking link; Site Kit defaults to "Book". */
	bookingLabel?: string;
	services: {
		name: string;
		price: number;
		duration: string;
		/** Shown on the service card only when the business provides one. */
		description?: string;
		/** This service's own booking link text; else `bookingLabel` (revision 4). */
		bookingLabel?: string;
	}[];
	/** A short optional bio is shown on the team card (foundation revision 3). */
	team: { name: string; role: string; bio?: string }[];
};
export const business: Business = {
	name: "Harbour Studio",
	category: "Movement & wellbeing",
	description:
		"A calm, welcoming movement studio in Galway. Personal care, thoughtful practice, and room to feel like yourself.",
	email: "hello@harbour.example",
	phone: "+353 91 555 0142",
	address: "12 The Long Walk, Galway, Ireland",
	hours: "Mon–Fri 07:00–20:00 · Sat 09:00–14:00",
	services: [
		{ name: "Reformer Pilates", price: 28, duration: "50 min" },
		{ name: "Initial consultation", price: 45, duration: "30 min" },
		{ name: "Sports massage", price: 70, duration: "60 min" },
	],
	team: [
		{ name: "Aoife", role: "Physiotherapist & Pilates instructor" },
		{ name: "Cian", role: "Sports massage therapist" },
	],
};
