import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import ts from "typescript";
import {
	customerSummary,
	type FailureKind,
	failureMessage,
	publicGeneration,
	rebuildable,
} from "../lib/customer-copy";
import { progressLabel } from "../lib/progress";
import { bookingPage, waitingPage } from "../lib/site-pages";
import { business } from "../lib/types";

/** Names and wording a business owner must never see. */
const forbidden =
	/\bHoplite\b|\bAstro\b|Responsive|Saved source version|Build and browser checks passed|Harbour|Galway|Powered by|Built on|connection_interrupted|\bdemo\b|QA report|Run checks again|Download build|Production artifact|source version|HTTP \d|_unavailable|_failed/i;

/** Every string and JSX text a component can render, without comments or imports. */
async function renderedStrings(path: string) {
	const source = ts.createSourceFile(
		path,
		await readFile(path, "utf8"),
		ts.ScriptTarget.Latest,
		true,
		path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
	);
	const strings: string[] = [];
	const visit = (node: ts.Node) => {
		if (
			ts.isImportDeclaration(node) ||
			ts.isExportDeclaration(node) ||
			(ts.isJsxAttribute(node) &&
				["className", "href", "src", "rel", "target", "sandbox"].includes(
					node.name.getText(),
				))
		)
			return;
		if (ts.isJsxText(node) && node.text.trim()) strings.push(node.text.trim());
		else if (
			ts.isStringLiteral(node) ||
			ts.isNoSubstitutionTemplateLiteral(node)
		)
			strings.push(node.text);
		else if (ts.isTemplateExpression(node))
			strings.push(
				[
					node.head.text,
					...node.templateSpans.map((span) => span.literal.text),
				].join("…"),
			);
		ts.forEachChild(node, visit);
	};
	visit(source);
	return strings;
}

test("the studio UI never shows platform or technology names to customers", async () => {
	for (const path of [
		"components/studio.tsx",
		"components/brand-panel.tsx",
		"app/layout.tsx",
		"app/login/page.tsx",
		"lib/customer-copy.ts",
		"lib/progress.ts",
	]) {
		const strings = await renderedStrings(path);
		assert.ok(strings.length > 0, path);
		const leaks = strings.filter((text) => forbidden.test(text));
		assert.deepEqual(leaks, [], `${path} shows: ${leaks.join(" | ")}`);
	}
	// Host-rendered pages inside the customer's website preview, for a
	// business other than the sample one.
	const salon = {
		...business,
		name: "Salon Nua",
		email: "hello@salon.example",
		address: "4 Main Street, Cork",
	};
	for (const html of [
		waitingPage(),
		bookingPage(salon, new URLSearchParams()),
		bookingPage(salon, new URLSearchParams({ service: "Sports massage" })),
	])
		assert.doesNotMatch(html, forbidden);
	// The Site Kit's own visible text inside every generated website.
	for (const text of await renderedStrings("seed/public/site-kit.js"))
		assert.doesNotMatch(text, forbidden, text);
	for (const phase of ["building", "checking", "generating"] as const)
		assert.doesNotMatch(progressLabel({ phase }) ?? "", forbidden);
});

test("failure messages are plain and honest about first versus later versions", () => {
	const kinds: FailureKind[] = [
		"rebuild",
		"deadline",
		"regenerate",
		"repair_exhausted",
		"not_started",
		"uncertain",
	];
	for (const kind of kinds) {
		const first = failureMessage(kind, false);
		const later = failureMessage(kind, true);
		for (const message of [first, later]) {
			assert.doesNotMatch(message, forbidden, message);
			assert.doesNotMatch(message, /[a-z]+_[a-z]+|\berror\b|code/i, message);
		}
		assert.doesNotMatch(
			first,
			/previous (ready )?version/,
			`${kind}: a first version has nothing to fall back on`,
		);
	}
	assert.match(
		failureMessage("rebuild", true),
		/previous version is still safe/,
	);
	assert.match(failureMessage("rebuild", false), /finish the same version/);
	assert.match(failureMessage("deadline", false), /took too long/);
	assert.match(failureMessage("not_started", true), /Nothing was changed/);
	assert.match(failureMessage("uncertain", false), /same request/);
});

test("only the agent's own failures regenerate; everything else rebuilds", () => {
	assert.equal(
		rebuildable({ category: "infrastructure", stage: "build", errors: [] }),
		true,
	);
	assert.equal(
		rebuildable({ category: "integration", stage: "browser", errors: [] }),
		true,
	);
	assert.equal(
		rebuildable({ category: "repairable", stage: "build", errors: [] }),
		false,
	);
	assert.equal(
		rebuildable({
			category: "infrastructure",
			stage: "generation",
			errors: [],
		}),
		false,
		"no saved draft to rebuild",
	);
	assert.equal(
		rebuildable({ category: "repairable", stage: "source", errors: [] }),
		false,
	);
	assert.equal(rebuildable(undefined), false);
});

test("change summaries are trimmed to a few plain sentences", () => {
	const long =
		"Harbour Studio now has a four-page website with a calm, coastal feel: deep sea-blue, soft misty grey and warm sand. " +
		"Visitors can book a session from any page. The menu works neatly on phones. " +
		"I haven't been able to view the pages on screen yet, so please have a look through the preview. " +
		"The contact page lists your address and hours. Your team page introduces Aoife and Cian. " +
		"The services page shows each session with a booking button.";
	const trimmed = customerSummary(long);
	assert.doesNotMatch(trimmed, /haven't been able|view the pages/);
	assert.ok(trimmed.split(/(?<=[.!?])\s+/).length <= 5, trimmed);
	assert.ok(trimmed.split(/\s+/).length <= 80, trimmed);
	assert.match(trimmed, /^Harbour Studio now has a four-page website/);

	const bullets =
		"Here's what changed:\n\n- **Home:** a new welcome.\n- **Team:** bios for everyone.\n- Ran `npm run build` and the build passed.\n- **Contact:** a simpler form.\n- **Services:** clearer prices.\n- **Visit:** directions.";
	const list = customerSummary(bullets);
	assert.doesNotMatch(list, /npm|build passed/);
	assert.equal(
		list.split("\n").filter((line) => line.startsWith("- ")).length,
		5,
		"a short list is kept complete, without the tooling note",
	);
	assert.match(
		list,
		/^Here's what changed:\n\n- \*\*Home:\*\* a new welcome\./,
	);

	const runOn = Array.from({ length: 120 }, (_, i) => `word${i}`).join(" ");
	const cut = customerSummary(runOn);
	assert.equal(cut.split(/\s+/).length, 80);
	assert.ok(cut.endsWith("…"));
	assert.equal(
		customerSummary("We build strength with small classes."),
		"We build strength with small classes.",
		"ordinary words like build are kept",
	);
});

test("the browser never receives the agent instructions or failure detail", () => {
	const generation = {
		id: "g1",
		prompt: "Make the heading friendlier",
		status: "failed" as const,
		createdAt: "2026-10-03T00:00:00.000Z",
		attempts: [
			{
				id: "a1",
				requestPrompt: "You are a website designer. Rules: Static Astro only.",
				runId: "run-1",
				failure: {
					category: "repairable" as const,
					stage: "build" as const,
					errors: ["npm run build exited with code 1"],
				},
			},
			{ id: "a2", requestPrompt: "REPAIR: Correct the supplied failures." },
		],
	};
	const shown = publicGeneration(generation);
	// The owner's own request and each attempt's outcome are kept.
	assert.equal(shown.prompt, "Make the heading friendlier");
	assert.deepEqual(
		shown.attempts.map((attempt) => attempt.id),
		["a1", "a2"],
	);
	assert.equal(shown.attempts[0].runId, "run-1");
	assert.equal(shown.attempts[0].failure?.stage, "build");
	assert.deepEqual(shown.attempts[0].failure?.errors, []);
	for (const attempt of shown.attempts)
		assert.equal("requestPrompt" in attempt, false);
	assert.doesNotMatch(
		JSON.stringify(shown),
		/website designer|Static Astro|REPAIR:|npm run build/,
	);
	// The saved generation keeps its instructions for retries and repairs.
	assert.equal(generation.attempts[1].requestPrompt?.startsWith("REPAIR"), true);
});

test("the state endpoint sends generations through the public projection", async () => {
	const server = await readFile("server.ts", "utf8");
	assert.match(server, /\.\.\.publicGeneration\(generation\)/);
	assert.doesNotMatch(server, /requestPrompt/);
});
