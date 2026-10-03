import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { validBusiness } from "../lib/business";
import { hardcodedBusinessFacts } from "../lib/safety";
import {
	bookingPage,
	bookingSlots,
	organizationSlug,
	pageRoutes,
	routeLabel,
	safePreviewPath,
} from "../lib/site-pages";
import { type Business, business, type JsonObject } from "../lib/types";

const root = await mkdtemp(join(tmpdir(), "studio-business-editor-"));
process.env.STUDIO_DATA_DIR = root;
after(() => rm(root, { recursive: true, force: true }));

function input(overrides: Partial<Business> = {}): JsonObject {
	return JSON.parse(JSON.stringify({ ...business, ...overrides }));
}

test("owners can list any number of services and team members, with optional details", () => {
	const services = Array.from({ length: 7 }, (_, i) => ({
		name: `  Treatment ${i + 1} `,
		price: 20 + i + 0.499,
		duration: i % 2 ? "45 min" : "",
		...(i === 0 ? { description: "  A gentle start.  " } : {}),
	}));
	const saved = validBusiness(
		input({
			category: "Physiotherapy clinic",
			description: "We help people move without pain.",
			services,
			team: [
				{
					name: "Aoife",
					role: "Physiotherapist",
					bio: " Ten years in sport. ",
				},
				{ name: "Cian", role: "" },
			],
		}),
	);
	assert.equal(saved.services.length, 7, "no fixed number of services");
	assert.deepEqual(saved.services[0], {
		name: "Treatment 1",
		price: 20.5,
		duration: "",
		description: "A gentle start.",
	});
	assert.equal(saved.services[1].duration, "45 min");
	assert.equal("description" in saved.services[1], false);
	assert.deepEqual(saved.team, [
		{ name: "Aoife", role: "Physiotherapist", bio: "Ten years in sport." },
		{ name: "Cian", role: "" },
	]);
	assert.equal(saved.category, "Physiotherapy clinic");
	assert.equal(saved.description, "We help people move without pain.");
	// Removing everyone from the team is allowed; services need at least one.
	assert.deepEqual(validBusiness(input({ team: [] })).team, []);
	assert.equal(
		validBusiness(input({ services: [services[0]] })).services.length,
		1,
	);
});

test("invalid business details are rejected with a message naming what to fix", () => {
	const reject = (overrides: Partial<Business>, message: RegExp) =>
		assert.throws(() => validBusiness(input(overrides)), {
			name: "BusinessDetailsError",
			message,
		});
	reject({ services: [] }, /at least one service/);
	reject(
		{ services: [{ name: " ", price: 10, duration: "" }] },
		/Give service 1 a name/,
	);
	reject(
		{
			services: [
				{ name: "Massage", price: 10, duration: "" },
				{ name: "massage", price: 12, duration: "" },
			],
		},
		/two services called “massage”/,
	);
	reject(
		{ services: [{ name: "Massage", price: -1, duration: "" }] },
		/price for Massage/,
	);
	reject(
		{
			services: Array.from({ length: 51 }, (_, i) => ({
				name: `S${i}`,
				price: 1,
				duration: "",
			})),
		},
		/up to 50 services/,
	);
	reject({ team: [{ name: "", role: "Coach" }] }, /team member 1 a name/);
	reject(
		{ team: [{ name: "Aoife", role: "", bio: "x".repeat(301) }] },
		/bio of Aoife under 300/,
	);
	reject({ name: "  " }, /business name/);
	reject({ email: "not-an-email" }, /email address/);
	reject({ phone: "call me" }, /phone number/);
	reject({ currency: "EURO" }, /currency/);
	reject({ currency: "ZZZ" }, /three-letter currency/);
});

test("saved details persist and feed the live Site Kit data and booking page", async () => {
	const { database, save } = await import("../lib/store");
	const db = await database();
	db.business = validBusiness(
		input({
			name: "Salon <Nua> & Co",
			email: "hello@salon.example",
			currency: "GBP",
			services: [
				{ name: "Cut & finish", price: 45, duration: "45 min" },
				{ name: "Colour", price: 82.5, duration: "" },
			],
		}),
	);
	await save();
	const persisted = JSON.parse(
		await readFile(join(root, "metadata.json"), "utf8"),
	);
	assert.deepEqual(persisted.business, db.business);

	const page = bookingPage(
		db.business,
		new URLSearchParams({ service: "Colour" }),
	);
	assert.match(page, /Salon &lt;Nua&gt; &amp; Co/, "business name is escaped");
	assert.doesNotMatch(page, /<Nua>/);
	assert.match(page, /Cut &amp; finish/);
	assert.match(page, /£45 · 45 min/);
	assert.match(page, /£82\.50/);
	assert.match(page, /<h1>Book Colour<\/h1>/);
	assert.match(page, /value="Colour" required checked/);
	assert.match(page, /data-booking-organization="salon-nua-co"/);
	assert.match(page, /href="tel:\+353915550142"/);
	assert.match(page, /href="mailto:hello@salon\.example"/);
	assert.doesNotMatch(
		page,
		/demo|live business data|Harbour Studio|harbour\.|Hoplite/i,
	);
	assert.doesNotMatch(
		page,
		/href="\/book\?service=/,
		"the booking page does not link back to itself for each service",
	);
	const incomplete = bookingPage(
		db.business,
		new URLSearchParams({ service: "Colour", requested: "1" }),
	);
	assert.match(incomplete, /Choose a day and a time to continue/);
	assert.doesNotMatch(incomplete, /is noted/);
	const [slot] = bookingSlots(db.business, "");
	assert.ok(slot);
	const done = bookingPage(
		db.business,
		new URLSearchParams({
			service: "Colour",
			day: slot.value,
			time: slot.times.at(-1) ?? "",
			requested: "1",
		}),
	);
	assert.match(done, /Colour is noted for/);
	assert.match(done, /no appointment was made/);
	assert.equal(organizationSlug({ name: "Café Ómós" }), "cafe-omos");
	assert.equal(organizationSlug({ name: "!!!" }), "business");
});

test("the page picker lists the draft's own generated pages", () => {
	assert.deepEqual(
		pageRoutes([
			{ path: "src/pages/index.astro" },
			{ path: "src/pages/team.astro" },
			{ path: "src/pages/services/index.astro" },
			{ path: "src/pages/visit-us.astro" },
			{ path: "src/pages/_draft.astro" },
			{ path: "src/pages/blog/[slug].astro" },
			{ path: "public/site.css" },
		]),
		["/", "/services", "/team", "/visit-us"],
	);
	assert.equal(routeLabel("/"), "Home");
	assert.equal(routeLabel("/visit-us"), "Visit us");
	assert.equal(safePreviewPath("/team"), "/team");
	assert.equal(safePreviewPath("/services/"), "/services/");
	for (const unsafe of [
		"https://evil.example",
		"//evil.example",
		"/../secret",
		"/a?b=c",
		"",
		null,
	])
		assert.equal(safePreviewPath(unsafe), "/", String(unsafe));
});

test("the copied-facts check covers the full address, titles and meta descriptions", () => {
	const findings = hardcodedBusinessFacts(
		[
			{
				path: "src/pages/index.astro",
				content: `---
const description = "Pilates at 12 The Long Walk, Galway, Ireland";
---
<html><head><title>Harbour Studio</title><meta name="description" content="Call +353 91 555 0142 today" /></head>
<body><p>Visit us in Galway.</p><p data-business="address"></p></body></html>`,
			},
		],
		business,
	);
	assert.equal(findings.length, 2);
	assert.match(findings.join("\n"), /full address/);
	assert.match(findings.join("\n"), /phone number/);
	assert.deepEqual(
		hardcodedBusinessFacts(
			[
				{
					path: "src/pages/index.astro",
					content: "<p>A calm studio in Galway.</p>",
				},
			],
			business,
		),
		[],
		"naming the town is not a copied address",
	);
});
