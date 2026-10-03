import assert from "node:assert/strict";
import { test } from "node:test";
import { markdown } from "../lib/markdown";
import { customerMessages } from "../lib/store";
import type { Message, Site } from "../lib/types";

test("agent replies render a safe Markdown subset", () => {
	assert.deepEqual(
		markdown(
			"**How it looks:** Night-blue and coral.\n\n## Pages\n- **Home:** hours\n- [Contact](https://harbour.example/contact)\n1. First\n2. Second",
		),
		[
			{
				type: "paragraph",
				content: [
					{
						type: "strong",
						children: [{ type: "text", text: "How it looks:" }],
					},
					{ type: "text", text: " Night-blue and coral." },
				],
			},
			{
				type: "paragraph",
				content: [
					{ type: "strong", children: [{ type: "text", text: "Pages" }] },
				],
			},
			{
				type: "list",
				ordered: false,
				items: [
					[
						{ type: "strong", children: [{ type: "text", text: "Home:" }] },
						{ type: "text", text: " hours" },
					],
					[
						{
							type: "link",
							href: "https://harbour.example/contact",
							children: [{ type: "text", text: "Contact" }],
						},
					],
				],
			},
			{
				type: "list",
				ordered: true,
				items: [
					[{ type: "text", text: "First" }],
					[{ type: "text", text: "Second" }],
				],
			},
		],
	);
	// Raw HTML and script links stay inert text.
	assert.deepEqual(
		markdown('<img src=x onerror="alert(1)"> [open](javascript:alert(1))'),
		[
			{
				type: "paragraph",
				content: [
					{ type: "text", text: '<img src=x onerror="alert(1)"> ' },
					{ type: "text", text: "[open](javascript:alert(1)" },
					{ type: "text", text: ")" },
				],
			},
		],
	);
	assert.deepEqual(markdown("snake_case_name and *soft* `code`"), [
		{
			type: "paragraph",
			content: [
				{ type: "text", text: "snake_case_name and " },
				{ type: "em", children: [{ type: "text", text: "soft" }] },
				{ type: "text", text: " " },
				{ type: "code", text: "code" },
			],
		},
	]);
});

test("the chat shows one customer reply per change, not commentary or repairs", () => {
	const at = (minute: number) =>
		`2026-09-26T16:${String(minute).padStart(2, "0")}:00Z`;
	const reply = (
		id: string,
		minute: number,
		content: string,
		runId?: string,
	): Message => ({ id, role: "assistant", content, time: at(minute), runId });
	const site: Site = {
		id: "website",
		name: "Harbour Studio",
		createdAt: at(0),
		updatedAt: at(0),
		phase: "idle",
		messages: [
			{ id: "ask", role: "user", content: "Make a website", time: at(1) },
			// Hoplite's live message joins commentary and the final reply.
			reply(
				"live",
				2,
				"Two small fixes were being overridden.The first draft is ready.",
				"run-1",
			),
			reply("final", 5, "The first draft is ready.", "run-1"),
			reply("repair", 8, "Raised the label contrast.", "run-repair"),
			{ id: "ask-2", role: "user", content: "Add hours", time: at(10) },
			reply("working", 11, "Now I'll add the hours.", "run-2"),
		],
		versions: [],
		previewRevision: 0,
		runId: "run-2",
	};
	site.phase = "generating";
	assert.deepEqual(
		customerMessages(site).map((message) => message.id),
		["ask", "final", "ask-2"],
		"progress commentary for the running change stays hidden",
	);
	site.phase = "idle";
	site.messages.push(
		reply("final-2", 12, "Your hours are on the home page.", "run-2"),
	);
	assert.deepEqual(
		customerMessages(site).map((message) => message.id),
		["ask", "final", "ask-2", "final-2"],
	);
	// Messages saved before run identities keep only the last reply of a change.
	site.messages = site.messages.map(({ runId, ...message }) => message);
	assert.deepEqual(
		customerMessages(site).map((message) => message.id),
		["ask", "repair", "ask-2", "final-2"],
	);
});
