import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { validBusiness } from "../lib/business";
import { customerSummary } from "../lib/customer-copy";
import { formatWeeklyHours, parseHours } from "../lib/hours";
import {
	classifyUpstream,
	isNavigation,
	isPlatformStartupPage,
	previewFallback,
	readUpstreamBody,
	sanitizePreviewHtml,
} from "../lib/preview-gateway";
import {
	checkSummary,
	releaseChanges,
	versionLine,
} from "../lib/release-summary";
import {
	bookingButtonStyle,
	bookingPage,
	bookingSlots,
	contrastRatio,
	pausedPage,
	waitingPage,
} from "../lib/site-pages";
import { business, type Site, type Version } from "../lib/types";

const page = { contentType: "text/html; charset=utf-8", navigation: true };

test("B1: upstream errors and the platform startup page never reach the owner", () => {
	// Modal's plain-text answer after idle archival.
	assert.equal(
		classifyUpstream({
			status: 404,
			contentType: "text/plain",
			body: "Sandbox not found",
			navigation: true,
		}),
		"unavailable",
	);
	assert.equal(
		classifyUpstream({
			status: 404,
			contentType: "text/plain",
			body: "Sandbox not found",
			navigation: false,
		}),
		"unavailable",
	);
	for (const status of [502, 503, 504])
		assert.equal(
			classifyUpstream({ ...page, status, body: "<h1>Bad gateway</h1>" }),
			"unavailable",
		);
	assert.equal(
		classifyUpstream({
			status: 500,
			contentType: "application/json",
			body: '{"error":"internal_error"}',
			navigation: true,
		}),
		"unavailable",
	);
	// The website's own server error keeps its status (browser checks treat it
	// as the agent's to repair) but its technical page is replaced.
	assert.equal(
		classifyUpstream({
			...page,
			status: 500,
			body: "<vite-error-overlay>ReferenceError at /src/pages/index.astro</vite-error-overlay>",
		}),
		"error",
	);
	assert.equal(classifyUpstream({ ...page, status: 401, body: "" }), "expired");
	assert.equal(
		classifyUpstream({
			status: 202,
			contentType: "application/json",
			body: '{"status":"starting"}',
			navigation: true,
		}),
		"starting",
	);
	assert.equal(
		classifyUpstream({
			status: 425,
			contentType: "text/plain",
			body: "",
			navigation: true,
		}),
		"starting",
	);
	// The platform's startup page: 202, its status endpoint or its branded title,
	// including after it is served with 200.
	const startup =
		'<!doctype html><title>Loading preview · Hoplite</title><h1>Loading preview...</h1><script>fetch("/.hoplite/preview-status")</script>';
	assert.equal(
		classifyUpstream({ ...page, status: 202, body: startup }),
		"starting",
	);
	assert.equal(
		classifyUpstream({ ...page, status: 200, body: startup }),
		"starting",
	);
	assert.ok(isPlatformStartupPage(startup));
	assert.ok(
		isPlatformStartupPage(
			'<title>Loading preview</title><script>fetch("/.hoplite/preview-status")</script>',
		),
		"an unbranded startup page is still recognised by its status endpoint",
	);
	// The website's own pages, including its own "page not found", pass.
	assert.equal(
		classifyUpstream({
			...page,
			status: 200,
			body: "<title>Salon Nua</title><h1>Welcome</h1>",
		}),
		"ok",
	);
	assert.equal(
		classifyUpstream({ ...page, status: 404, body: "<h1>Page not found</h1>" }),
		"ok",
	);
	assert.equal(
		classifyUpstream({
			status: 404,
			contentType: "image/png",
			body: "",
			navigation: false,
		}),
		"ok",
		"a missing image is the website's own business",
	);
	// Site Studio's waiting page is neutral and says what is happening.
	const waiting = waitingPage("Waking your preview…");
	assert.match(waiting, /Waking your preview…/);
	assert.doesNotMatch(waiting, /hoplite|sandbox|modal/i);
});

test("B1: the gateway's own reloads never restart a paused preview", () => {
	// Nothing the gateway does restarts a workspace: without an owner wake in
	// progress, a gone preview shows the paused page (no auto-refresh).
	for (const verdict of ["unavailable", "expired", "no_grant"] as const)
		assert.deepEqual(previewFallback(verdict, false), {
			page: "paused",
			state: "paused",
			dropGrant: verdict !== "no_grant",
		});
	// While a wake the owner asked for is starting it, the waiting page
	// refreshes (reading the workspace, not restarting it).
	assert.equal(previewFallback("unavailable", true).page, "waiting");
	assert.equal(previewFallback("starting", false).page, "waiting");
	assert.equal(previewFallback("starting", false).dropGrant, false);
	const paused = pausedPage("site-1", "/services");
	assert.match(paused, /Your preview is paused/);
	assert.match(
		paused,
		/href="\/__open\?site=site-1&amp;wake=1&amp;path=%2Fservices"/,
		"only the explicit button wakes it",
	);
	assert.doesNotMatch(paused, /http-equiv/i, "it never refreshes itself");
	assert.equal(
		paused.match(/__open/g)?.length,
		1,
		"its script never opens (and so never wakes) the preview",
	);
	assert.match(
		paused,
		/fetch\("\/__preview-state"/,
		"its poll reads gateway state only",
	);
	assert.doesNotMatch(paused, /hoplite|sandbox/i);
});

test("14: preview HTML never carries the private workspace path", () => {
	const html =
		'<style type="text/css" data-vite-dev-id="/tmp/hoplite/workspaces/thr-bdcc0c3a/src/styles/tailwind.css">*{}</style><script type="module" src="/@fs/tmp/hoplite/workspaces/thr-bdcc0c3a/node_modules/x.js"></script><main data-astro-source-file="/tmp/hoplite/workspaces/thr-bdcc0c3a/src/pages/index.astro">Hi</main>';
	const clean = sanitizePreviewHtml(html);
	assert.match(clean, /data-vite-dev-id="\/src\/styles\/tailwind\.css"/);
	assert.match(clean, /data-astro-source-file="\/src\/pages\/index\.astro"/);
	assert.doesNotMatch(
		clean.replace(/\/@fs\/tmp\/hoplite\/[^"]+/, ""),
		/hoplite/,
	);
	assert.match(clean, /src="\/@fs\/tmp\/hoplite\//, "module URLs still load");
});

test("B1: navigations are told apart from scripts, styles and pings", async () => {
	assert.equal(isNavigation({ "sec-fetch-mode": "navigate" }), true);
	assert.equal(isNavigation({ "sec-fetch-dest": "iframe" }), true);
	assert.equal(
		isNavigation({ "sec-fetch-mode": "cors", accept: "text/html" }),
		false,
	);
	assert.equal(isNavigation({ accept: "text/x-vite-ping" }), false);
	assert.equal(isNavigation({ accept: "text/html,*/*" }), true);
	const body = "<h1>Hello</h1>";
	assert.equal(
		(
			await readUpstreamBody(Readable.from([gzipSync(body)]), "gzip")
		).toString(),
		body,
	);
	await assert.rejects(
		readUpstreamBody(Readable.from([Buffer.alloc(32)]), "", 16),
		/too large/,
	);
});

test("8 and round 4: a long list keeps its lead-in and first items; nothing dangles", () => {
	const intro = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
	const list = `${intro}.\n\nHere's what changed:\n\n- A new welcome at the top.\n- Bios for everyone on the team page.\n- A simpler contact form with fewer fields.\n- Clearer prices on every service card.`;
	const trimmed = customerSummary(list);
	assert.match(
		trimmed,
		/Here's what changed:\n\n- A new welcome at the top\.\n- Bios for everyone on the team page\.\n- …and more$/,
		"the lead-in stays with the items that fit, then says there is more",
	);
	assert.ok(trimmed.split(/\s+/).length <= 85, trimmed);
	// A lead-in with no list after it is still never left dangling.
	assert.equal(
		customerSummary("Your website is ready.\n\nHere's what changed:"),
		"Your website is ready.",
	);
	const short = customerSummary(
		"Here's what changed:\n\n- One.\n- Two.\n- Three.\n- Four.\n- Five.\n- Six.",
	);
	assert.equal(
		short.split("\n").filter((line) => line.startsWith("- ")).length,
		6,
	);
	const longList = Array.from(
		{ length: 12 },
		(_, i) => `- Item ${i} has a few more words to describe it`,
	).join("\n");
	const kept = customerSummary(longList);
	const bullets = kept.split("\n").filter((line) => line.startsWith("- "));
	assert.equal(bullets.length, 9, "the first eight items, then more");
	assert.equal(bullets.at(-1), "- …and more");
});

function version(id: string, patch: Partial<Version> = {}): Version {
	return {
		id,
		sourceId: `source-${id}`,
		label: `Version ${id}`,
		createdAt: "2026-09-27T10:00:00Z",
		qa: { status: "passed", checks: [], errors: [], screenshots: [] },
		...patch,
	};
}

test("7 and 11: the publish dialog lists every change going live; each version has a plain line", () => {
	const site: Pick<Site, "versions" | "publishedVersionId" | "generations"> = {
		versions: [
			version("1", { changeSummary: "Your first website." }),
			version("2", { changeSummary: "A more premium look." }),
			version("3", {
				changeSummary: "A broken attempt.",
				failure: { category: "repairable", stage: "build", errors: [] },
			}),
			version("4", {
				changeSummary:
					"- **Team:** a new page about your team.\n- Bigger text.",
			}),
			version("5", { generationId: "g5" }),
		],
		publishedVersionId: "1",
		generations: [
			{
				id: "g5",
				prompt: "Add a big book now button",
				baseVersionId: "4",
				status: "ready",
				createdAt: "",
				attempts: [],
			},
		],
	};
	assert.deepEqual(
		releaseChanges(site, "5", "publish").map((change) => change.summary),
		[
			"A more premium look.",
			"- **Team:** a new page about your team.\n- Bigger text.",
			"Updated your website.",
		],
		"every ready change since the published version; a missing summary gets a plain default, never the owner's request",
	);
	assert.deepEqual(
		releaseChanges(site, "2", "rollback").map((change) => change.label),
		["Version 2"],
	);
	assert.equal(
		versionLine(site, site.versions[3]),
		"Team: a new page about your team.",
	);
	assert.equal(versionLine(site, site.versions[4]), "Updated your website.");
	const long = version("6", {
		changeSummary: `${"A very long sentence ".repeat(10)}end.`,
	});
	assert.ok(versionLine(site, long).length <= 101);
	assert.ok(versionLine(site, long).endsWith("…"));
});

test("12: checks are summarised in plain words", () => {
	const summary = checkSummary(
		version("1", {
			routes: ["/", "/services", "/team"],
			qa: {
				status: "passed",
				checks: ["/ · 1440px · Booking link 7"],
				errors: [],
				screenshots: [],
				warnings: ["/ at 390px: region: Some content is not contained"],
			},
		}),
	);
	assert.equal(summary.pages, "3 pages checked: Home, Services and Team");
	assert.match(summary.devices, /phones, tablets and computers/);
	assert.match(summary.issues, /1 small suggestion/);
	const all = JSON.stringify(summary);
	assert.doesNotMatch(all, /1440px|Booking link \d|Preview:|region:|axe|JSON/);
});

test("13: opening hours are set day by day and feed the hours text", () => {
	assert.deepEqual(parseHours(business.hours), {
		mon: { open: "07:00", close: "20:00" },
		tue: { open: "07:00", close: "20:00" },
		wed: { open: "07:00", close: "20:00" },
		thu: { open: "07:00", close: "20:00" },
		fri: { open: "07:00", close: "20:00" },
		sat: { open: "09:00", close: "14:00" },
	});
	assert.equal(
		formatWeeklyHours(parseHours(business.hours) ?? {}),
		business.hours,
	);
	assert.equal(parseHours("Weekdays by appointment"), undefined);
	const saved = validBusiness({
		...business,
		weeklyHours: {
			...parseHours(business.hours),
			tue: { open: "09:00", close: "17:00" },
		},
	});
	assert.equal(
		saved.hours,
		"Mon 07:00–20:00 · Tue 09:00–17:00 · Wed–Fri 07:00–20:00 · Sat 09:00–14:00",
	);
	assert.throws(
		() =>
			validBusiness({
				...business,
				weeklyHours: { mon: { open: "18:00", close: "09:00" } },
			}),
		/Monday must close after it opens/,
	);
	assert.throws(
		() => validBusiness({ ...business, weeklyHours: { funday: null } }),
		/opening hours/,
	);
});

test("10 and 16: the test booking page offers a day and time and uses the site's booking colour", () => {
	const now = new Date(2026, 8, 28, 8); // a Monday
	const slots = bookingSlots(business, "50 min", now);
	assert.equal(slots.length, 12, "two weeks without the closed Sundays");
	assert.equal(slots[0].value, "2026-09-28");
	assert.equal(slots[0].times[0], "08:30", "today offers only times ahead");
	assert.equal(slots[1].times[0], "07:00");
	assert.equal(
		slots[0].times.at(-1),
		"19:00",
		"a 50-minute visit fits before 20:00",
	);
	const saturday = slots.find((slot) => slot.value === "2026-10-03");
	assert.equal(saturday?.times.at(-1), "13:00");
	const style = { background: "rgb(20, 60, 40)", color: "rgb(255, 255, 255)" };
	const choose = bookingPage(
		business,
		new URLSearchParams({ service: "Reformer Pilates" }),
		undefined,
		{ now, style },
	);
	assert.match(choose, /name="day" required/);
	assert.match(choose, /name="time" required/);
	assert.match(choose, /background:rgb\(20 60 40\); color:rgb\(255 255 255\)/);
	const done = bookingPage(
		business,
		new URLSearchParams({
			service: "Reformer Pilates",
			day: "2026-10-03",
			time: "10:30",
			requested: "1",
		}),
		undefined,
		{ now },
	);
	assert.match(
		done,
		/Reformer Pilates is noted for Saturday,? 3 October at 10:30/,
	);
	assert.match(done, /no appointment was made/);
	const closed = bookingPage(
		business,
		new URLSearchParams({
			service: "Reformer Pilates",
			day: "2026-10-03",
			time: "18:00",
			requested: "1",
		}),
		undefined,
		{ now },
	);
	assert.match(closed, /isn’t available on that day/);
	assert.doesNotMatch(closed, /is noted/);
	// Unreadable or low-contrast colours keep the neutral button.
	assert.equal(
		bookingButtonStyle({ background: "red;}", color: "#fff" }),
		undefined,
	);
	assert.equal(
		bookingButtonStyle({
			background: "rgb(200, 200, 200)",
			color: "rgb(255, 255, 255)",
		}),
		undefined,
	);
	assert.equal(
		bookingButtonStyle({
			background: "rgba(0, 0, 0, 0)",
			color: "rgb(255, 255, 255)",
		}),
		undefined,
	);
});

test("15: the studio's muted text colour meets WCAG AA on its surfaces", async () => {
	const css = await readFile("app/globals.css", "utf8");
	const token = (name: string) => {
		const match = css.match(new RegExp(`--${name}:\\s*#([0-9a-f]{6})`, "i"));
		assert.ok(match, name);
		return [0, 2, 4].map((i) => Number.parseInt(match[1].slice(i, i + 2), 16));
	};
	const label = token("label");
	for (const surface of [
		"background",
		"card",
		"tray",
		"thread-floor",
		"chip-hover",
		"chip-down",
		"chip-checked",
		"segment-track",
	])
		assert.ok(
			contrastRatio(label, token(surface)) >= 4.5,
			`--label on --${surface}: ${contrastRatio(label, token(surface)).toFixed(2)}`,
		);
	assert.ok(contrastRatio(label, [255, 255, 255]) >= 4.5);
	assert.ok(
		contrastRatio([0x66, 0x66, 0x66], [0xf4, 0xf4, 0xf4]) >= 4.5,
		"waiting page",
	);
});
