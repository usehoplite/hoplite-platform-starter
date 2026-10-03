import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { runInNewContext } from "node:vm";
import { c as archive } from "tar";
import type { SourceFile } from "../lib/hoplite";
import { progressLabel } from "../lib/progress";
import { bytes, hardcodedBusinessFacts, sha256 } from "../lib/safety";
import { type Business, business, type Site } from "../lib/types";

// These tests exercise Site Studio's optional browser checks.
process.env.STUDIO_QA_CHECKS = "on";

const root = await mkdtemp(join(tmpdir(), "studio-customer-fit-"));
process.env.STUDIO_DATA_DIR = root;
after(() => rm(root, { recursive: true, force: true }));

type FakeNode = {
	tagName?: string;
	className?: string;
	href?: string;
	style?: Record<string, string>;
	dataset?: Record<string, string>;
	children: FakeNode[];
	textContent: string;
	append?: (...nodes: FakeNode[]) => void;
	replaceChildren?: (...nodes: FakeNode[]) => void;
};

function fakeElement(tag: string, dataset: Record<string, string> = {}) {
	let text = "";
	const node = {
		tagName: tag.toUpperCase(),
		className: "",
		href: "",
		style: {} as Record<string, string>,
		dataset,
		children: [] as FakeNode[],
		get textContent(): string {
			return node.children.length
				? node.children.map((child) => child.textContent).join("")
				: text;
		},
		set textContent(value: string) {
			node.children = [];
			text = String(value);
		},
		append(...nodes: FakeNode[]) {
			node.children.push(...nodes);
		},
		replaceChildren(...nodes: FakeNode[]) {
			text = "";
			node.children = [...nodes];
		},
	};
	return node;
}

/** Runs the shipped Site Kit against a minimal DOM and the given live data. */
async function renderSiteKit(
	data: Business,
	lang = "en",
	path = "seed/public/site-kit.js",
) {
	const services = fakeElement("div");
	const hours = fakeElement("span", { business: "hours" });
	const phone = fakeElement("span", { business: "phone" });
	const email = fakeElement("span", { business: "email" });
	// A generated page may also bind the email to its own link.
	const emailLink = fakeElement("a", { business: "email" });
	const team = fakeElement("div");
	const document = {
		documentElement: { lang },
		querySelector: () => null,
		querySelectorAll: (selector: string) =>
			({
				"[data-business]": [hours, phone, email, emailLink],
				"[data-services]": [services],
				"[data-team]": [team],
			})[selector] ?? [],
		createElement: (tag: string) => fakeElement(tag),
		createTextNode: (text: string) => ({ children: [], textContent: text }),
	};
	const source = await readFile(path, "utf8");
	runInNewContext(source, {
		document,
		fetch: async () => ({ ok: true, json: async () => data }),
	});
	for (let i = 0; i < 5; i++)
		await new Promise((resolve) => setImmediate(resolve));
	return { services, hours, phone, email, emailLink, team, source };
}

function cards(services: FakeNode) {
	return services.children.map((card) => {
		const find = (predicate: (node: FakeNode) => boolean) =>
			card.children.find(predicate);
		const bottom = find((node) => node.className === "service-bottom");
		return {
			name: find((node) => node.tagName === "H3")?.textContent,
			description: find((node) => node.tagName === "P")?.textContent,
			cost: bottom?.children[0].textContent,
			link: bottom?.children[1].textContent,
			href: bottom?.children[1].href,
		};
	});
}

test("Site Kit service cards use each business's own descriptions, currency and booking label", async () => {
	const plain = await renderSiteKit(structuredClone(business));
	assert.doesNotMatch(plain.source, /Thoughtful, personalised care|↗/);
	assert.deepEqual(cards(plain.services)[0], {
		name: "Reformer Pilates",
		description: undefined,
		cost: "€28 · 50 min",
		link: "Book",
		href: "/book?service=Reformer%20Pilates",
	});
	assert.ok(
		cards(plain.services).every((card) => card.description === undefined),
		"no description means no filler paragraph",
	);

	const salon: Business = {
		...structuredClone(business),
		currency: "GBP",
		bookingLabel: "Book an appointment",
		services: [
			{
				name: "Cut & finish",
				price: 45,
				duration: "45 min",
				description: "  A consultation, wash, cut and blow-dry.  ",
			},
			{ name: "Colour", price: 82.5, duration: "" },
			{ name: "Fringe trim", price: 8, duration: "10 min", description: " " },
		],
	};
	const rendered = cards((await renderSiteKit(salon)).services);
	assert.deepEqual(
		rendered.map(({ description, cost, link }) => ({
			description,
			cost,
			link,
		})),
		[
			{
				description: "A consultation, wash, cut and blow-dry.",
				cost: "£45 · 45 min",
				link: "Book an appointment",
			},
			{ description: undefined, cost: "£82.50", link: "Book an appointment" },
			{
				description: undefined,
				cost: "£8 · 10 min",
				link: "Book an appointment",
			},
		],
	);
	const usd = cards(
		(await renderSiteKit({ ...structuredClone(business), currency: "USD" }))
			.services,
	);
	assert.equal(usd[0].cost, "$28 · 50 min");
	const kwd = cards(
		(await renderSiteKit({ ...structuredClone(business), currency: "KWD" }))
			.services,
	);
	assert.match(
		kwd[0].cost ?? "",
		/^KWD\s28\.000 · 50 min$/,
		"three-decimal currencies keep their standard precision",
	);
});

test("Site Kit keeps each opening-hours range on one line", async () => {
	const { hours, phone } = await renderSiteKit(structuredClone(business));
	assert.equal(hours.textContent, business.hours, "visible text is unchanged");
	const unbroken = hours.children
		.filter((node) => node.style?.whiteSpace === "nowrap")
		.map((node) => node.textContent);
	assert.deepEqual(unbroken, ["Mon–Fri 07:00–20:00", "Sat 09:00–14:00"]);
	assert.equal(phone.textContent, business.phone);
	assert.equal(phone.children.length, 1, "the number is one tappable link");

	const prose =
		"Weekdays by appointment, including early mornings 06:30–08:00 and late evenings";
	const long = await renderSiteKit({
		...structuredClone(business),
		hours: prose,
	});
	assert.equal(long.hours.textContent, prose);
	assert.deepEqual(
		long.hours.children
			.filter((node) => node.style?.whiteSpace === "nowrap")
			.map((node) => node.textContent),
		["Weekdays by appointment", "06:30–08:00"],
		"long segments may wrap, but never inside a time range",
	);
});

test("Site Kit makes the phone and email tappable and shows team bios from live data", async () => {
	const data: Business = {
		...structuredClone(business),
		phone: "+353 (91) 555-0142",
		email: "bookings@salon.example",
		team: [
			{ name: "Aoife", role: "Stylist", bio: "  Colour specialist.  " },
			{ name: "Cian", role: "Barber" },
		],
	};
	const { phone, email, emailLink, team } = await renderSiteKit(data);
	const [phoneLink] = phone.children;
	assert.equal(phoneLink.tagName, "A");
	assert.equal(phoneLink.href, "tel:+353915550142");
	assert.equal(
		phone.textContent,
		data.phone,
		"the visible number is unchanged",
	);
	const [mailLink] = email.children;
	assert.equal(mailLink.tagName, "A");
	assert.equal(mailLink.href, "mailto:bookings@salon.example");
	assert.equal(emailLink.href, "mailto:bookings@salon.example");
	assert.equal(emailLink.children.length, 0, "an existing link is reused");
	assert.equal(emailLink.textContent, data.email);
	const cards = team.children.map((card) =>
		card.children.map((node) => [
			node.tagName,
			node.className,
			node.textContent,
		]),
	);
	assert.deepEqual(cards, [
		[
			["H3", "", "Aoife"],
			["P", "", "Stylist"],
			["P", "bio", "Colour specialist."],
		],
		[
			["H3", "", "Cian"],
			["P", "", "Barber"],
		],
	]);
	// Unusable values stay plain text rather than broken links.
	const plain = await renderSiteKit({
		...structuredClone(business),
		phone: "ask",
		email: "not an email",
	});
	assert.equal(plain.phone.children.length, 0);
	assert.equal(plain.phone.textContent, "ask");
	assert.equal(plain.email.children.length, 0);
	// Websites saved with revision 2 keep their original, unlinked behaviour.
	const saved = await renderSiteKit(
		data,
		"en",
		"lib/foundation-r2/public/site-kit.js",
	);
	assert.equal(saved.phone.children.length, 0);
});

test("new websites get the fixed foundation; saved websites keep their original owned bytes", async () => {
	const { seedFiles } = await import("../lib/service");
	const file = (files: SourceFile[], path: string) => {
		const found = files.find((item) => item.path === path);
		assert.ok(found, path);
		return bytes(found).toString();
	};
	const current = await readFile("seed/public/site-kit.js", "utf8");
	const revisionTwo = await readFile(
		"lib/foundation-r2/public/site-kit.js",
		"utf8",
	);
	const revisionThree = await readFile(
		"lib/foundation-r3/public/site-kit.js",
		"utf8",
	);
	assert.notEqual(current, revisionTwo);
	assert.notEqual(current, revisionThree);
	assert.notEqual(revisionTwo, revisionThree);
	for (const starterVersion of [undefined, "2"] as const) {
		const latest = await seedFiles(undefined, starterVersion, "blank", 4);
		assert.match(
			file(latest, "astro.config.mjs"),
			/devToolbar: \{ enabled: false \}/,
		);
		assert.equal(file(latest, "public/site-kit.js"), current);
		// Revision-3 websites keep their Site Kit bytes byte for byte.
		assert.equal(
			file(
				await seedFiles(undefined, starterVersion, "blank", 3),
				"public/site-kit.js",
			),
			revisionThree,
		);
		// Revision-2 websites keep their Site Kit bytes byte for byte.
		const saved = await seedFiles(undefined, starterVersion, "blank", 2);
		assert.match(
			file(saved, "astro.config.mjs"),
			/devToolbar: \{ enabled: false \}/,
		);
		assert.equal(file(saved, "public/site-kit.js"), revisionTwo);
	}
	for (const saved of [
		await seedFiles(),
		await seedFiles(undefined, undefined, "blank"),
		await seedFiles(undefined, "2", "blank"),
	]) {
		assert.equal(
			file(saved, "public/site-kit.js"),
			await readFile("lib/foundation-r1/public/site-kit.js", "utf8"),
		);
		assert.match(file(saved, "public/site-kit.js"), /Book a session ↗/);
	}
	assert.doesNotMatch(
		file(await seedFiles(), "astro.config.mjs"),
		/devToolbar/,
		"saved legacy websites keep the config their source was checked against",
	);
	assert.equal(
		file(await seedFiles(), "package.json"),
		await readFile("seed/package.json", "utf8"),
	);
});

test("creating a website asks the agent to render live business facts only through Site Kit bindings", async () => {
	const { database } = await import("../lib/store");
	const { createSite, hoplite } = await import("../lib/service");
	await database();
	Object.defineProperty(hoplite, "configured", { value: true });
	const original = hoplite.json;
	let prompt = "";
	let imported: SourceFile[] = [];
	hoplite.json = async <T>(
		path: string,
		body?: Parameters<typeof hoplite.json>[1],
	): Promise<T> => {
		if (path === "/api/platform/v1/apps")
			return { app: { id: "app-created" } } as T;
		assert.ok(body && typeof body === "object" && !Array.isArray(body));
		if (path.endsWith("/sources")) {
			imported = body.files as SourceFile[];
			return { source: { id: "source-created" } } as T;
		}
		if (path.endsWith("/threads")) {
			prompt = String(body.prompt);
			return { thread: { id: "thread" }, run: { id: "run" } } as T;
		}
		throw new Error(`Unexpected request ${path}`);
	};
	try {
		const site = await createSite("Make a website for my business.");
		assert.equal(site.foundationRevision, 4);
		assert.match(
			bytes(
				imported.find((file) => file.path === "astro.config.mjs") ?? {
					path: "",
					content: "",
				},
			).toString(),
			/devToolbar: \{ enabled: false \}/,
		);
		assert.match(prompt, /never write them into page copy/);
		assert.match(prompt, /not even paraphrased/);
		assert.match(prompt, /"50 minutes"/);
		assert.match(prompt, /open from early morning into the evening/);
		for (const binding of [
			"[data-services] for services, prices and durations",
			"[data-team] for practitioners",
			'[data-business="hours"]',
			'[data-business="address"]',
			'[data-business="phone"]',
			'[data-business="email"]',
		])
			assert.ok(prompt.includes(binding), binding);
		assert.match(prompt, /a p only when the business wrote a description/);
		assert.match(prompt, /tappable tel: and mailto: links/);
		assert.match(prompt, /class="bio"/);
		(await database()).sites = [];
	} finally {
		hoplite.json = original;
	}
});

test("the source check flags live business facts copied into page copy", () => {
	const page = (content: string): SourceFile[] => [
		{ path: "src/pages/index.astro", content },
	];
	assert.deepEqual(
		hardcodedBusinessFacts(
			page(`---
import "../styles/tailwind.css";
---
<html lang="en"><head><title>Harbour Studio</title></head><body>
<a href="tel:+353915550142" data-business="phone">+353 91 555 0142</a>
<p>Opening hours: <span data-business="hours">Mon–Fri 07:00–20:00</span></p>
<div data-services><article><h3>Reformer Pilates</h3><span>€28 · 50 min</span></article></div>
<p>See our services and prices below. Classes run in small groups of 6.</p>
<script is:inline>const example = "€28 · 7:00–20:00";</script>
</body></html>`),
			business,
		),
		[],
		"values inside bindings, link targets and scripts are not copy",
	);
	const findings = hardcodedBusinessFacts(
		page(`<html><body>
<h2>Reformer Pilates</h2><p>50 minutes. From € 28.00 per class.</p>
<p>We're open 7:00 - 20:00 on weekdays.</p>
<p>Call +353 (91) 555-0142 or write to Hello@Harbour.example.</p>
<p>A sports massage is 60-minute bliss for €70.</p>
</body></html>`),
		business,
	);
	assert.deepEqual(
		findings.map((finding) => finding.split(". ")[0]),
		[
			"src/pages/index.astro: the opening hours 7:00–20:00 are written into the page",
			"src/pages/index.astro: the price of Reformer Pilates is written into the page",
			"src/pages/index.astro: the 50 min duration of Reformer Pilates is written into the page",
			"src/pages/index.astro: the price of Sports massage is written into the page",
			"src/pages/index.astro: the 60 min duration of Sports massage is written into the page",
			"src/pages/index.astro: the phone number is written into the page text",
			"src/pages/index.astro: the email address is written into the page text",
		],
	);
	assert.ok(findings.every((finding) => finding.includes("[data-")));
	assert.deepEqual(
		hardcodedBusinessFacts(
			page(
				'<html><head><meta name="description" content="Open Mon–Fri 07:00–20:00"/></head><body><img src="/a.png" alt="Reformer class, €28"/></body></html>',
			),
			business,
		).map((finding) => finding.split(". ")[0]),
		[
			"src/pages/index.astro: the opening hours 7:00–20:00 are written into the page",
			"src/pages/index.astro: the price of Reformer Pilates is written into the page",
		],
		"meta descriptions and alt text are copy too",
	);
	assert.deepEqual(
		hardcodedBusinessFacts(
			page("<p>Only £28 today, 8 minutes from the station.</p>"),
			business,
		),
		[],
		"another currency or an unrelated number is not a copied fact",
	);
	assert.equal(
		hardcodedBusinessFacts(page("<p>Only £28 today.</p>"), {
			...business,
			currency: "GBP",
		}).length,
		1,
	);
});

test("the status line follows the real pipeline stage", () => {
	const site: Parameters<typeof progressLabel>[0] = {
		phase: "generating",
		runId: "run-1",
		generationId: "change",
		generations: [
			{
				id: "change",
				prompt: "Make a website",
				status: "running",
				createdAt: "2026-09-27",
				attempts: [{ id: "a1", runId: "run-1" }],
			},
		],
	};
	assert.equal(progressLabel(site), null, "no invented text before the agent");
	site.activity = { runId: "run-1", text: "Writing your services page" };
	assert.equal(progressLabel(site), "Writing your services page");
	site.activity = { runId: "old-run", text: "An older update" };
	assert.equal(progressLabel(site), null);
	site.phase = "building";
	assert.equal(progressLabel(site), "Building your website…");
	site.phase = "checking";
	assert.equal(
		progressLabel(site),
		"Checking every page on phones and computers…",
	);
	site.qaProgress = { checked: 7, total: 24 };
	assert.equal(
		progressLabel(site),
		"Checking every page on phones and computers (7 of 24)…",
	);
	site.qaProgress = { checked: 24, total: 24 };
	assert.equal(progressLabel(site), "Almost ready…");
	site.phase = "generating";
	site.generations?.[0].attempts.push({ id: "a2", runId: "run-2" });
	site.runId = "run-2";
	site.activity = { runId: "run-2", text: "Repairing axe violations" };
	assert.equal(progressLabel(site), "Fixing a couple of small things…");
	site.phase = "idle";
	assert.equal(progressLabel(site), null);
	site.phase = "failed";
	assert.equal(progressLabel(site), null);
});

test("browser checks report page progress for the live preview and the artifact", async () => {
	const { database } = await import("../lib/store");
	const { hoplite, tick } = await import("../lib/service");
	const db = await database();
	const html = Buffer.from("<!doctype html><h1>Fixture</h1>");
	const fixture = join(root, "qa-fixture");
	await mkdir(fixture, { recursive: true });
	await writeFile(join(fixture, "index.html"), html);
	await mkdir(join(fixture, "services"), { recursive: true });
	await writeFile(join(fixture, "services", "index.html"), html);
	await archive(
		{ cwd: fixture, file: join(root, "qa-artifact.tar.gz"), gzip: true },
		["index.html", "services/index.html"],
	);
	const artifact = await readFile(join(root, "qa-artifact.tar.gz"));
	await mkdir(join(root, "versions", "candidate"), { recursive: true });
	const site: Site = {
		id: "progress-site",
		appId: "app",
		name: "Progress",
		createdAt: "2026-09-27",
		updatedAt: "2026-09-27",
		phase: "building",
		threadId: "thread",
		runId: "run",
		buildVersionId: "candidate",
		previewRevision: 0,
		messages: [],
		versions: [
			{
				id: "candidate",
				sourceId: "source",
				sourceChecked: true,
				label: "Candidate",
				createdAt: "2026-09-27",
				buildId: "build",
			},
		],
	};
	db.sites = [site];
	const originalJson = hoplite.json;
	const originalResponse = hoplite.response;
	hoplite.json = async <T>(path: string): Promise<T> => {
		if (path.includes("/preview"))
			return {
				preview: {
					status: "ready",
					url: "https://preview.example",
					gateway: {
						token: "fixture",
						header: "x-preview",
						expiresAt: new Date(Date.now() + 60_000).toISOString(),
					},
				},
			} as T;
		if (path.includes("/runs/"))
			return { run: { status: "completed", resultSourceId: "source" } } as T;
		if (path.endsWith("/manifest"))
			return {
				files: [
					{ path: "index.html", sha256: sha256(html) },
					{ path: "services/index.html", sha256: sha256(html) },
				],
			} as T;
		return {
			build: { status: "ready", artifactSha256: sha256(artifact) },
		} as T;
	};
	hoplite.response = async () => new Response(artifact);
	const seen: string[] = [];
	try {
		await tick(async (_siteId, _versionId, directory, options) => {
			await mkdir(directory, { recursive: true });
			assert.equal(site.phase, "checking");
			for (let i = 0; i < options.routes.length * 3; i++) {
				seen.push(progressLabel(site) ?? "");
				options.onPageChecked?.();
			}
			return {
				status: "passed",
				checks: ["Passed"],
				errors: [],
				screenshots: [],
			};
		});
		assert.equal(seen.length, 12, "2 routes × 3 viewports × 2 targets");
		assert.equal(
			seen[0],
			"Checking every page on phones and computers (0 of 12)…",
		);
		assert.equal(
			seen[11],
			"Checking every page on phones and computers (11 of 12)…",
		);
		assert.equal(site.phase, "idle");
		assert.equal(site.qaProgress, undefined);
	} finally {
		hoplite.json = originalJson;
		hoplite.response = originalResponse;
	}
});
