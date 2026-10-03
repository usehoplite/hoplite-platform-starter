import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import {
	applyBusinessProposal,
	BusinessDetailsError,
	describeBusinessChange,
	extractBusinessProposal,
	validBusiness,
	withoutBusinessProposal,
} from "../lib/business";
import { customerSummary, replyFallback } from "../lib/customer-copy";
import { sanitizePreviewHtml } from "../lib/preview-gateway";
import {
	ownerVersions,
	releaseChanges,
	versionLine,
} from "../lib/release-summary";
import { bookingPage, bookingSlots } from "../lib/site-pages";
import { business, type Site, type Version } from "../lib/types";

// Round 4 (final audit, 28 September): honest summaries, every version in
// the publish dialog, the booking page, the preview path shim and business
// facts confirmed from chat.

test("M1: a lead-in and a long list never trim to nothing", () => {
	// The shape the agent wrote in run 4 (A and C2): a lead-in, three long
	// bullets and a closing line, about 90 words in all.
	const reply =
		"Your Harbour Studio website is ready, with a calm sea-inspired look and bold lettering. Here's what visitors will find:\n\n" +
		"- A welcoming home page that introduces the studio, its classes and the team, with a clear way to book a first session straight away.\n" +
		"- A services page listing every class with its live price and length, so visitors can compare options before they choose one to book.\n" +
		"- A contact page with your address, opening hours, phone and email, plus a short enquiry form for questions.\n\n" +
		"Have a look through the preview and tell us what you would like to change.";
	const summary = customerSummary(reply);
	assert.ok(summary.length > 0, "never empty");
	assert.match(summary, /^Your Harbour Studio website is ready/);
	assert.match(
		summary,
		/Here's what visitors will find:\n\n- A welcoming home page/,
	);
	assert.match(summary, /\n- …and more$/);
	assert.ok(summary.split(/\s+/).length <= 90, summary);
	// A lone long bullet is shortened rather than dropped.
	const lone = customerSummary(
		`- ${Array.from({ length: 120 }, (_, i) => `w${i}`).join(" ")}`,
	);
	assert.match(lone, /^- w0 w1/);
	assert.ok(lone.endsWith("…"));
});

function version(id: string, patch: Partial<Version> = {}): Version {
	return {
		id,
		sourceId: `source-${id}`,
		label: `Version ${id}`,
		createdAt: "2026-09-28T10:00:00Z",
		qa: { status: "passed", checks: [], errors: [], screenshots: [] },
		...patch,
	};
}
const at = "2026-09-28T10:00:00Z";

test("M1: a reply with nothing left says what actually happened to its change", () => {
	const site: Pick<
		Site,
		"generations" | "versions" | "activeVersionId" | "businessProposal"
	> = {
		versions: [version("v1"), version("v2", { failure: undefined })],
		activeVersionId: "v1",
		generations: [
			{
				id: "create",
				prompt: "",
				status: "ready",
				resultVersionId: "v1",
				createdAt: at,
				attempts: [{ id: "a1", runId: "run-create" }],
			},
			{
				id: "edit",
				prompt: "Add a team page",
				baseVersionId: "v1",
				status: "ready",
				resultVersionId: "v2",
				createdAt: at,
				attempts: [{ id: "a2", runId: "run-edit" }],
			},
			{
				id: "broken",
				prompt: "Make it better",
				baseVersionId: "v2",
				status: "failed",
				createdAt: at,
				attempts: [{ id: "a3", runId: "run-broken" }],
			},
			{
				id: "building",
				prompt: "Bigger text",
				baseVersionId: "v2",
				status: "checking",
				createdAt: at,
				attempts: [{ id: "a4", runId: "run-building" }],
			},
			{
				id: "nothing",
				prompt: "Add a tracker",
				baseVersionId: "v2",
				status: "ready",
				createdAt: at,
				attempts: [{ id: "a5", runId: "run-nothing" }],
			},
		],
	};
	assert.equal(
		replyFallback(site, { runId: "run-create" }),
		"Your new website is ready to look at.",
	);
	assert.equal(
		replyFallback(site, { runId: "run-edit" }),
		"Your changes are ready to look at in the preview.",
	);
	const failed = replyFallback(site, { runId: "run-broken" });
	assert.doesNotMatch(failed, /ready to look at/);
	assert.match(failed, /isn’t ready yet/);
	assert.doesNotMatch(
		replyFallback(site, { runId: "run-building" }),
		/ready to look at/,
	);
	assert.match(
		replyFallback(site, { runId: "run-nothing" }),
		/Nothing on your website needed to change/,
	);
	assert.match(
		replyFallback(
			{ ...site, versions: [], activeVersionId: undefined },
			{ runId: "run-broken" },
		),
		/Your website isn’t ready yet/,
	);
	// Once a proposed business change was answered, its reply still says so.
	const answered = site.generations?.find((item) => item.id === "nothing");
	assert.ok(answered);
	answered.proposedBusinessChange = true;
	assert.equal(
		replyFallback(site, { runId: "run-nothing" }),
		"I suggested an update to your business details.",
	);
});

test("M2: a first publish lists the whole new website and never the owner's raw request", () => {
	const site: Pick<
		Site,
		"versions" | "publishedVersionId" | "generations" | "activeVersionId"
	> = {
		versions: [
			version("1", { generationId: "g1", label: "Version 1" }),
			version("2", {
				generationId: "g2",
				label: "Version 2",
				changeSummary: "A more premium look.",
			}),
			version("3", { generationId: "g3", label: "Version 3" }),
		],
		generations: [
			{ id: "g1", prompt: "", status: "ready", createdAt: at, attempts: [] },
			{
				id: "g2",
				prompt: "make it feel more premium",
				baseVersionId: "1",
				status: "ready",
				createdAt: at,
				attempts: [],
			},
			{
				id: "g3",
				prompt: "add a page about our team",
				baseVersionId: "2",
				status: "ready",
				createdAt: at,
				attempts: [],
			},
		],
	};
	const going = releaseChanges(site, "3", "publish");
	assert.deepEqual(
		going.map((change) => [change.label, change.summary]),
		[
			["Version 1", "Created your website."],
			["Version 2", "A more premium look."],
			["Version 3", "Updated your website."],
		],
	);
	assert.ok(
		going.every((change) => !/add a page about our team/.test(change.summary)),
	);
	assert.equal(versionLine(site, site.versions[0]), "Created your website.");
});

test("8: a repair replaces its change's candidate; the owner sees one version per change", () => {
	const site: Pick<
		Site,
		"versions" | "generations" | "publishedVersionId" | "activeVersionId"
	> = {
		versions: [
			version("candidate", {
				generationId: "g1",
				label: "Version 1",
				failure: {
					category: "repairable",
					stage: "browser",
					errors: [],
					advisory: true,
				},
			}),
			version("repaired", { generationId: "g1", label: "Version 1" }),
		],
		generations: [
			{
				id: "g1",
				prompt: "",
				status: "ready",
				resultVersionId: "repaired",
				createdAt: at,
				attempts: [],
			},
		],
		activeVersionId: "repaired",
	};
	assert.deepEqual(
		ownerVersions(site).map((item) => item.id),
		["repaired"],
	);
	// When the repair fails, the checked candidate is the change's result.
	site.generations = [
		{
			...(site.generations?.[0] as NonNullable<Site["generations"]>[0]),
			resultVersionId: "candidate",
		},
	];
	site.activeVersionId = "candidate";
	assert.deepEqual(
		ownerVersions(site).map((item) => item.id),
		["candidate"],
	);
	assert.deepEqual(
		releaseChanges(site, "candidate", "publish").map((item) => item.label),
		["Version 1"],
	);
});

test("5 and 7: the booking page is readable and offers only the chosen day's times", () => {
	const now = new Date(2026, 8, 28, 12, 24); // Monday 12:24
	const hours = {
		...business,
		weeklyHours: {
			mon: { open: "08:00", close: "18:00" },
			sat: { open: "09:00", close: "14:00" },
		},
	};
	const saved = validBusiness(hours);
	const page = bookingPage(saved, new URLSearchParams(), undefined, { now });
	// No dimmed text on the booking page (it failed contrast in run 4).
	assert.doesNotMatch(page, /opacity:\s*\.75/);
	assert.doesNotMatch(page, /\.note[^{]*\{[^}]*opacity/);
	// The page carries each day's hours; its script narrows the times.
	const data = JSON.parse(
		page.match(
			/<script type="application\/json" id="booking-days">([^<]*)<\/script>/,
		)?.[1] ?? "{}",
	);
	const saturday = data.days.find(
		(day: { value: string }) => day.value === "2026-10-03",
	);
	assert.deepEqual([saturday.open, saturday.close], [9 * 60, 14 * 60]);
	const today = data.days.find(
		(day: { value: string }) => day.value === "2026-09-28",
	);
	assert.ok(today.earliest > 12 * 60 + 24, "today starts after now");
	assert.equal(data.lengths["Sports massage"], 60);
	// With a day chosen, the server lists only that day's times.
	const chosen = bookingPage(
		saved,
		new URLSearchParams({ service: "Sports massage", day: "2026-10-03" }),
		undefined,
		{ now },
	);
	const options = [...chosen.matchAll(/<option value="(\d\d:\d\d)"/g)].map(
		(match) => match[1],
	);
	assert.equal(options[0], "09:00");
	assert.equal(options.at(-1), "13:00", "a 60-minute visit ends by 14:00");
	// Today offers nothing already past.
	const slots = bookingSlots(saved, "50 min", now);
	assert.equal(slots[0].value, "2026-09-28");
	assert.equal(slots[0].times[0], "12:30");
	// The script runs in the page: choosing Saturday lists only its times.
	const script = page.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
	assert.match(script, /Choose a day first/);
	assert.match(script, /start \+ length\(\) <= item\.close/);
});

test("9: live preview pages rewrite injected workspace paths before any module runs", () => {
	const html = sanitizePreviewHtml(
		'<!doctype html><html><head><meta charset="utf-8"><script type="module" src="/@vite/client"></script></head><body></body></html>',
	);
	assert.ok(
		html.indexOf("<script>") < html.indexOf('type="module"'),
		"the shim runs before the development client",
	);
	assert.doesNotMatch(html, /hoplite/i, "the page never names the provider");
	const shim = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
	class Element {
		attributes: Record<string, string> = {};
		setAttribute(name: string, value: string) {
			this.attributes[name] = value;
		}
		getAttribute(name: string) {
			return this.attributes[name];
		}
	}
	runInNewContext(shim, {
		Element,
		MutationObserver: class {
			observed = 0;
			observe() {
				this.observed++;
			}
		},
		document: { documentElement: {} },
	});
	const style = new Element();
	style.setAttribute(
		"data-vite-dev-id",
		"/tmp/hoplite/workspaces/thr-bdcc0c3a/src/styles/tailwind.css",
	);
	assert.equal(
		style.getAttribute("data-vite-dev-id"),
		"/src/styles/tailwind.css",
	);
	style.setAttribute("href", "/tmp/hoplite/workspaces/x/keep");
	assert.equal(style.getAttribute("href"), "/tmp/hoplite/workspaces/x/keep");
});

test("decision b: a business fact from chat becomes a validated, confirmable change", () => {
	const current = validBusiness(business);
	const reply =
		"I’ve prepared that for you to confirm.\n\n```studio-business\n" +
		JSON.stringify({ weeklyHours: { mon: null } }) +
		"\n```";
	const patch = extractBusinessProposal(reply);
	assert.deepEqual(patch, { weeklyHours: { mon: null } });
	assert.equal(
		withoutBusinessProposal(reply).trim(),
		"I’ve prepared that for you to confirm.",
	);
	// Still streaming: a half-written block never shows either.
	assert.equal(
		withoutBusinessProposal("Done.\n\n```studio-busi").trim(),
		"Done.",
	);
	assert.equal(
		withoutBusinessProposal('Done.\n\n```studio-business\n{"we').trim(),
		"Done.",
	);
	assert.ok(patch);
	const next = applyBusinessProposal(current, patch);
	assert.equal(next.weeklyHours?.mon, undefined);
	assert.equal(next.hours, "Tue–Fri 07:00–20:00 · Sat 09:00–14:00");
	assert.deepEqual(describeBusinessChange(current, next), {
		title: "Update your opening hours",
		changes: ["Monday → Closed"],
	});
	const tuesday = applyBusinessProposal(current, {
		weeklyHours: { tue: { open: "09:00", close: "17:00" } },
	});
	assert.deepEqual(describeBusinessChange(current, tuesday).changes, [
		"Tuesday → 09:00–17:00",
	]);
	const services = applyBusinessProposal(current, {
		services: {
			add: [{ name: "Yoga", price: 20, duration: "60 min" }],
			update: [
				{ name: "reformer pilates", price: 31, bookingLabel: "Reserve" },
			],
			remove: ["Sports massage"],
		},
	});
	assert.deepEqual(describeBusinessChange(current, services), {
		title: "Update your services",
		changes: [
			"Reformer Pilates: price €28 → €31, booking text → Reserve",
			"New service: Yoga (€20 · 60 min)",
			"Remove service: Sports massage",
		],
	});
	// Every change is listed, however many there are.
	const many = applyBusinessProposal(current, {
		services: {
			add: Array.from({ length: 14 }, (_, i) => ({
				name: `Class ${i}`,
				price: 10,
				duration: "30 min",
			})),
		},
	});
	assert.equal(describeBusinessChange(current, many).changes.length, 14);
	const contact = applyBusinessProposal(current, { phone: "+353 91 555 0199" });
	assert.equal(
		describeBusinessChange(current, contact).title,
		"Update your contact details",
	);
	// Invalid or unknown changes are refused with the Business details rules.
	for (const invalid of [
		{ weeklyHours: { mon: { open: "18:00", close: "09:00" } } },
		{ services: { remove: ["Nonexistent"] } },
		{ favouriteColour: "blue" },
		// A field the details do not hold would be dropped on save.
		{ services: { update: [{ name: "Sports massage", colour: "red" }] } },
		{ team: { add: [{ name: "Niamh", role: "Coach", photo: "x.png" }] } },
		{ services: { add: [{ name: "Free", price: -1, duration: "" }] } },
		{},
	])
		assert.throws(
			() => applyBusinessProposal(current, invalid),
			BusinessDetailsError,
		);
	// Free-text hours cannot be changed a day at a time.
	assert.throws(
		() =>
			applyBusinessProposal(
				{ ...current, hours: "By appointment", weeklyHours: undefined },
				{ weeklyHours: { mon: null } },
			),
		/day by day/,
	);
	assert.equal(
		extractBusinessProposal("```studio-business\nnot json\n```"),
		undefined,
	);
	// Written inline on one line, it is still read (and still never shown).
	const inline = 'Done. ```studio-business {"phone":"+353 1 555 0100"}```';
	assert.deepEqual(extractBusinessProposal(inline), {
		phone: "+353 1 555 0100",
	});
	assert.equal(withoutBusinessProposal(inline).trim(), "Done.");
});

test("decision c and polish: per-service booking text, Site Kit card counts, plain page wording", async () => {
	const saved = validBusiness({
		...business,
		bookingLabel: "Book now",
		services: [
			{ name: "Class", price: 10, duration: "60 min", bookingLabel: "Join" },
			{ name: "Massage", price: 50, duration: "60 min", bookingLabel: "  " },
		],
	});
	assert.equal(saved.services[0].bookingLabel, "Join");
	assert.equal(saved.services[1].bookingLabel, undefined);
	assert.throws(
		() =>
			validBusiness({
				...business,
				services: [
					{ name: "A", price: 1, duration: "", bookingLabel: "x".repeat(41) },
				],
			}),
		/booking button text of A/,
	);
	const kit = await readFile("seed/public/site-kit.js", "utf8");
	assert.match(kit, /service\.bookingLabel/);
	assert.match(kit, /dataset\.count/);
	const studio = await readFile("components/studio.tsx", "utf8");
	assert.doesNotMatch(studio, /THE SOURCE OF TRUTH/);
	assert.match(
		studio,
		/<Textarea\s+aria-label=\{`\$\{label\} bio`\}[\s\S]*?maxLength=\{300\}/,
		"team bios are a multi-line field with a limit",
	);
	assert.match(
		studio,
		/data\?\.staff && publishable && release\.buildId/,
		"downloading raw website files is a staff tool",
	);
});
