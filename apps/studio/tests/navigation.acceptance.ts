import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { test } from "node:test";
import next from "next";
import { chromium } from "playwright";
import {
	business,
	type Conversation,
	type Message,
	type StudioState,
} from "../lib/types";

const time = "2026-09-25T00:00:00Z";
function conversation(id: string, updatedAt = time): Conversation {
	return { id, title: `${id} change`, createdAt: time, updatedAt };
}
function message(id: string, content: string): Message {
	return { id, role: "user", content, time, conversationId: id };
}
type Body = { prompt?: string; conversationId?: string | null; name?: string };
async function read(req: IncomingMessage): Promise<Body> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(Buffer.from(chunk));
	return JSON.parse(Buffer.concat(chunks).toString());
}

test("onboarding creates the organisation's one website and conversations stay on it", {
	timeout: 120_000,
}, async () => {
	const state: StudioState = {
		site: null,
		business,
		configured: true,
		browserChecks: false,
		previewGatewayId: "navigation-fixture",
		previewOrigin: "http://127.0.0.1:4321",
		sitesOrigin: "http://127.0.0.1:4322",
		previewState: null,
		staff: false,
	};
	const requests: { path: string; body: Body }[] = [];
	const app = next({ dev: false, hostname: "127.0.0.1" });
	await app.prepare();
	const handle = app.getRequestHandler();
	const server = createServer(async (req, res) => {
		const json = (value: string, status = 200) => {
			res.writeHead(status, { "content-type": "application/json" });
			res.end(value);
		};
		if (req.url === "/api/state") json(JSON.stringify(state));
		else if (req.url === "/api/brand")
			json(JSON.stringify({ brief: null, activeBrief: null, selected: null }));
		else if (req.url === "/api/business" && req.method === "POST") {
			requests.push({ path: req.url, body: await read(req) });
			json(JSON.stringify({ ok: true }));
		} else if (req.url === "/api/site" && req.method === "POST") {
			const body = await read(req);
			requests.push({ path: req.url, body });
			if (state.site)
				json(JSON.stringify({ error: "Your website already exists." }), 409);
			else {
				state.site = {
					id: "website",
					name: business.name,
					createdAt: time,
					updatedAt: time,
					phase: "idle",
					messages: [message("first", "Only first transcript")],
					conversations: [conversation("first")],
					conversationId: "first",
					versions: [],
					previewRevision: 0,
				};
				json(
					JSON.stringify({ site: state.site, conversationId: "first" }),
					201,
				);
			}
		} else if (req.url === "/api/site/messages" && req.method === "POST") {
			const body = await read(req);
			requests.push({ path: req.url, body });
			assert.ok(state.site);
			const id =
				typeof body.conversationId === "string" ? body.conversationId : "third";
			if (!state.site.conversations?.some((item) => item.id === id))
				state.site.conversations?.unshift(
					conversation(id, "2026-09-25T02:00:00Z"),
				);
			state.site.messages.push({
				...message(id, String(body.prompt)),
				id: `${id}-${state.site.messages.length}`,
			});
			state.site.conversationId = id;
			json(JSON.stringify({ site: state.site, conversationId: id }));
		} else void handle(req, res);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const origin = `http://127.0.0.1:${address.port}`;
	const browser = await chromium.launch({ channel: "chrome", headless: true });
	try {
		for (const viewport of [
			{ width: 1440, height: 1000 },
			{ width: 390, height: 844 },
		]) {
			state.site = null;
			requests.length = 0;
			const page = await browser.newPage({ viewport });
			page.setDefaultTimeout(10_000);
			const errors: string[] = [];
			page.on("pageerror", (error) => errors.push(error.message));
			await page.route("http://127.0.0.1:4321/**", (route) =>
				route.fulfill({
					contentType: "text/html",
					body: "<h1>Preview fixture</h1>",
				}),
			);
			async function sidebar() {
				const open = page.getByRole("button", {
					name: "Open sidebar",
					exact: true,
				});
				if (await open.isVisible()) await open.click();
			}
			async function chat() {
				const tab = page.getByRole("button", { name: "Chat", exact: true });
				if (await tab.isVisible()) await tab.click();
			}
			async function showing(id: string | null, transcript: string) {
				if (id)
					await page.waitForURL(
						(url) => url.searchParams.get("conversation") === id,
					);
				else
					await page.waitForURL((url) => !url.searchParams.has("conversation"));
				await page
					.getByText(transcript, { exact: true })
					.waitFor({ state: "attached" });
				assert.equal(
					await page.getByText(/^Only \w+ transcript$/).count(),
					1,
					"only the selected conversation's messages are shown",
				);
				assert.equal(
					new URL(
						(await page.locator("iframe").getAttribute("src")) || origin,
					).searchParams.get("site"),
					"website",
					"every conversation previews the same website",
				);
				assert.equal(
					await page.getByRole("button", { name: /New website/ }).count(),
					0,
				);
			}

			// First visit: onboarding, then the website.
			await page.goto(origin, { waitUntil: "domcontentloaded" });
			for (const heading of [
				"Check your business details",
				"Bring your brand with you",
				"Create your website",
			])
				await page
					.getByRole("heading", { name: heading, exact: true })
					.waitFor();
			assert.equal(
				await page.getByRole("button", { name: "New change" }).count(),
				0,
			);
			assert.equal(await page.getByText("Your websites").count(), 0);
			// Unsaved business edits are saved before the website is created.
			await page
				.getByRole("textbox", { name: "Business name", exact: true })
				.fill("Harbour Studio Galway");
			await page
				.getByRole("button", { name: "Create my website", exact: true })
				.click();
			await showing("first", "Only first transcript");
			assert.deepEqual(
				requests.map((request) => request.path),
				["/api/business", "/api/site"],
			);
			assert.equal(requests[0].body.name, "Harbour Studio Galway");
			// An empty request is sent as-is; nothing is written in the owner's name.
			assert.deepEqual(requests[1].body, { prompt: "" });

			// A returning customer lands on the website with their latest conversation.
			// The fixture server replaced the site; TypeScript cannot see that.
			const website = state.site as StudioState["site"];
			assert.ok(website);
			website.conversations = [
				conversation("second", "2026-09-25T01:00:00Z"),
				conversation("first"),
			];
			website.messages = [
				message("first", "Only first transcript"),
				message("second", "Only second transcript"),
			];
			website.conversationId = "second";
			await page.goto(origin, { waitUntil: "domcontentloaded" });
			await showing(null, "Only second transcript");
			await page
				.getByRole("button", { name: "Publish", exact: true })
				.waitFor();
			await sidebar();
			await page
				.locator(".recent-site-open")
				.getByText("first change", { exact: true })
				.click();
			await showing("first", "Only first transcript");
			await page.goBack({ waitUntil: "domcontentloaded" });
			await showing(null, "Only second transcript");
			await page.goForward({ waitUntil: "domcontentloaded" });
			await showing("first", "Only first transcript");
			await page.reload({ waitUntil: "domcontentloaded" });
			await showing("first", "Only first transcript");

			// A follow-up in an earlier conversation still edits the same website.
			await chat();
			await page
				.getByRole("textbox", { name: "Describe your website changes" })
				.fill("Change the colours");
			await page.getByRole("button", { name: "Send message" }).click();
			await showing("first", "Only first transcript");
			assert.deepEqual(requests.at(-1), {
				path: "/api/site/messages",
				body: { prompt: "Change the colours", conversationId: "first" },
			});

			await sidebar();
			await page
				.getByRole("link", { name: "Business details", exact: true })
				.click();
			await page
				.getByRole("heading", { name: "Business details", exact: true })
				.waitFor();
			await sidebar();
			await page
				.getByRole("link", { name: "Your website", exact: true })
				.click();
			await showing(null, "Only first transcript");

			// A new change starts a new conversation on the same website.
			await sidebar();
			await page
				.getByRole("button", { name: "New change", exact: true })
				.click();
			await page.waitForURL(
				(url) => url.searchParams.get("conversation") === "new",
			);
			assert.equal(await page.getByText(/^Only \w+ transcript$/).count(), 0);
			await chat();
			await page
				.getByRole("textbox", { name: "Describe your website changes" })
				.fill("Only third transcript");
			await page.getByRole("button", { name: "Send message" }).click();
			await showing("third", "Only third transcript");
			assert.deepEqual(requests.at(-1), {
				path: "/api/site/messages",
				body: { prompt: "Only third transcript", conversationId: null },
			});
			assert.equal(
				requests.filter((request) => request.path === "/api/site").length,
				1,
				"only onboarding creates the website",
			);
			assert.deepEqual(errors, []);
			await page.close();
		}
	} finally {
		await browser.close();
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
		await app.close();
	}
});
