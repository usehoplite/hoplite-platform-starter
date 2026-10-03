import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { chromium, type Page, type Request } from "playwright";
import { access, hosting } from "./deployment";
import { safeArtifactPath } from "./safety";
import type { Business, QAEvidence, Version } from "./types";

export class PreviewUnavailableError extends Error {}

export async function visitPreview(page: Pick<Page, "goto">, url: string) {
	let response: Awaited<ReturnType<Page["goto"]>>;
	try {
		response = await page.goto(url, { waitUntil: "networkidle" });
	} catch (error) {
		// A navigation stall is a transport failure, unlike an assertion timeout
		// for a missing element in a page which loaded successfully.
		throw new PreviewUnavailableError(
			error instanceof Error ? error.message : String(error),
		);
	}
	if (response?.headers()["x-studio-preview-state"] === "starting") {
		throw new PreviewUnavailableError(
			"The preview gateway is waiting for its upstream service",
		);
	}
	return response;
}

export function artifactRoutes(files: { path: string }[]): string[] {
	const routes = files
		.filter((f) => f.path.endsWith(".html"))
		.map(({ path }) => {
			assert.ok(safeArtifactPath(path), `Unsafe page path: ${path}`);
			const encoded = path.split("/").map(encodeURIComponent).join("/");
			return `/${encoded}`.replace(/\/index\.html$/, "/");
		});
	assert.ok(routes.includes("/"), "The build has no home page");
	return [...new Set(routes)].sort();
}

type QAOptions = {
	routes: string[];
	business: Business;
	// Injectable only for the acceptance fixture; customer calls use the gateway.
	origin?: string;
	/** Called after every route finishes at one viewport. */
	onPageChecked?: () => void;
};

export const qaViewports = [
	{ width: 1440, height: 900 },
	{ width: 768, height: 1024 },
	{ width: 390, height: 844 },
];

/** Cheap, high-signal axe rules the quick check runs after every build. */
export const quickRules = [
	"color-contrast",
	"link-name",
	"button-name",
	"image-alt",
	"label",
	"html-has-lang",
];
/** Phone and computer: the viewports the quick check scans. */
export const quickViewports = [qaViewports[2], qaViewports[0]];

export type QuickCheckResult = {
	/** Concrete evidence for a repair: viewport, rule, element and measurement. */
	issues: string[];
	/** The primary booking button's colours, for the host-owned booking page. */
	bookingStyle?: { background: string; color: string };
};

/** At most this many pages per viewport, so the check stays fast. */
export const quickRouteLimit = 12;
function pageName(route: string) {
	if (route === "/") return "Home page";
	if (route === "/book")
		return "Booking page (/book: Site Studio's page, styled by public/site.css)";
	return `Page ${route}`;
}

/**
 * The quick accessibility check: seconds, not the full QA. It opens every
 * page it is given (by default the home page) at one phone and one computer
 * viewport and runs the contrast rule (plus a few cheap critical rules) over
 * each whole page, including its visible booking buttons. Only serious or
 * critical findings are reported. It never submits forms or leaves the
 * gateway origin. A page that does not load is left to the build and the
 * full checks.
 */
export async function quickAccessibilityCheck(
	siteId: string,
	versionId: string,
	options: {
		origin?: string;
		viewports?: typeof quickViewports;
		routes?: string[];
	} = {},
): Promise<QuickCheckResult> {
	const origin = options.origin ?? hosting.checkOrigin;
	// The home and booking pages come first, so a large site never pushes
	// them out of the scan.
	const requested = options.routes ?? [];
	const routes = [
		...new Set([
			"/",
			...requested.filter((route) => route === "/book"),
			...requested,
		]),
	].slice(0, quickRouteLimit);
	const browser = await chromium.launch({
		headless: true,
		channel: "chrome",
		handleSIGINT: false,
		handleSIGTERM: false,
	});
	const issues: string[] = [];
	let bookingStyle: QuickCheckResult["bookingStyle"];
	try {
		for (const viewport of options.viewports ?? quickViewports) {
			const context = await browser.newContext({
				viewport,
				serviceWorkers: "block",
			});
			try {
				// With the access gate on, the gateway needs preview access.
				const cookie = access.checkCookie(origin);
				if (cookie) await context.addCookies([cookie]);
				context.setDefaultTimeout(8_000);
				context.setDefaultNavigationTimeout(15_000);
				await context.route("**/*", async (route) => {
					const request = route.request();
					if (
						new URL(request.url()).origin !== origin ||
						!["GET", "HEAD"].includes(request.method())
					)
						await route.abort();
					else await route.continue();
				});
				const opened = await context.request.get(
					`${origin}/__open?site=${encodeURIComponent(siteId)}&version=${encodeURIComponent(versionId)}&path=/`,
					{ maxRedirects: 0 },
				);
				assert.equal(opened.status(), 302, "Could not open the saved version");
				const page = await context.newPage();
				for (const route of routes) {
					let response: Awaited<ReturnType<Page["goto"]>>;
					try {
						response = await page.goto(`${origin}${route}`, {
							waitUntil: "networkidle",
						});
					} catch (error) {
						// One slow page never discards the other pages' findings;
						// it is left to the build and the full checks.
						if (route === "/") throw error;
						continue;
					}
					if (route === "/")
						assert.equal(response?.status(), 200, "The home page did not load");
					else if (response?.status() !== 200) continue;
					const result = await new AxeBuilder({ page })
						.withRules(quickRules)
						.analyze();
					for (const violation of result.violations) {
						if (!["critical", "serious"].includes(violation.impact ?? ""))
							continue;
						for (const node of violation.nodes.slice(0, 4))
							issues.push(
								`${pageName(route)} at ${viewport.width}px: ${violation.id} (${violation.help}) on ${node.target.join(" ")}. ${(node.failureSummary ?? "").replace(/\s+/g, " ").trim()}`.slice(
									0,
									600,
								),
							);
					}
					if (route !== "/") continue;
					bookingStyle ??= await page.evaluate(() => {
						for (const link of document.querySelectorAll<HTMLAnchorElement>(
							'a[href^="/book"]',
						)) {
							const box = link.getBoundingClientRect();
							const style = getComputedStyle(link);
							if (!box.width || !box.height || style.visibility === "hidden")
								continue;
							const background = style.backgroundColor;
							if (
								background &&
								background !== "transparent" &&
								!/rgba\([^)]*,\s*0\)$/.test(background)
							)
								return { background, color: style.color };
						}
						return;
					});
				}
			} finally {
				await context.close();
			}
		}
	} finally {
		await browser.close();
	}
	return { issues: [...new Set(issues)].slice(0, 16), bookingStyle };
}

export async function browserQA(
	siteId: string,
	versionId: string | undefined,
	directory: string,
	options: QAOptions,
): Promise<NonNullable<Version["qa"]>> {
	const origin = options.origin ?? hosting.checkOrigin;
	const checks: string[] = [];
	const errors: string[] = [];
	const warnings: string[] = [];
	const screenshots: string[] = [];
	const evidence: QAEvidence[] = [];
	let failureCategory: "infrastructure" | "integration" | undefined;
	let setupCategory: typeof failureCategory;
	await mkdir(directory, { recursive: true });
	let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
	try {
		assert.ok(options.routes.length, "No generated routes to check");
		setupCategory = "infrastructure";
		browser = await chromium.launch({
			headless: true,
			channel: "chrome",
			handleSIGINT: false,
			handleSIGTERM: false,
		});
		for (const viewport of qaViewports) {
			const context = await browser.newContext({
				viewport,
				serviceWorkers: "block",
			});
			const cookie = access.checkCookie(origin);
			if (cookie) await context.addCookies([cookie]);
			context.setDefaultTimeout(8_000);
			context.setDefaultNavigationTimeout(30_000);
			const page = await context.newPage();
			const reportedRequests = new WeakSet<Request>();
			let checking = false;
			let leadTesting = false;
			let leadRequests = 0;
			let leadReceiptBody: string | undefined;
			let fixture: Business | undefined;
			let routeName = "/";
			const consoleLog: string[] = [];
			const network: string[] = [];
			const issue = (detail: string, scope = routeName) => {
				if (checking) errors.push(`${scope} at ${viewport.width}px: ${detail}`);
			};
			page.on("pageerror", (e) => {
				consoleLog.push(e.message);
				issue(e.message);
			});
			page.on("console", (message) => {
				if (message.type() === "error") {
					consoleLog.push(message.text());
					issue(message.text());
				}
			});
			context.on("response", (response) => {
				network.push(
					`${response.request().method()} ${response.url()} -> ${response.status()}`,
				);
				if (response.status() >= 400)
					issue(`Failed resource ${response.url()}: HTTP ${response.status()}`);
			});
			context.on("requestfailed", (request) => {
				const detail = `${request.method()} ${request.url()} -> ${request.failure()?.errorText}`;
				network.push(detail);
				if (!reportedRequests.has(request)) issue(detail);
			});
			// This protects the QA browser, not the sandbox's build-time egress.
			await context.route("**/*", async (route) => {
				const request = route.request();
				const url = new URL(request.url());
				if (url.origin !== origin) {
					issue(`Unapproved network destination: ${url.origin}`);
					reportedRequests.add(request);
					await route.abort();
					return;
				}
				if (!["GET", "HEAD"].includes(request.method())) {
					if (
						leadTesting &&
						request.method() === "POST" &&
						url.pathname === "/site-kit/leads"
					) {
						leadRequests++;
						try {
							// Forward the actual browser submission once, retaining its real
							// response before delivering it unchanged to the page. Reading
							// Playwright Response.body after the dev preview's unused fetch
							// response can wait indefinitely for Chromium loadingFinished.
							const response = await route.fetch({
								maxRedirects: 0,
								maxRetries: 0,
								timeout: 10_000,
							});
							leadReceiptBody = await response.text();
							if (response.status() >= 500) failureCategory = "infrastructure";
							await route.fulfill({ response });
						} catch (error) {
							failureCategory = "infrastructure";
							issue(
								`Lead endpoint unavailable: ${error instanceof Error ? error.message : String(error)}`,
							);
							reportedRequests.add(request);
							await route.abort().catch(() => undefined);
						}
					} else {
						issue(
							`Blocked unexpected write: ${request.method()} ${url.pathname}`,
						);
						reportedRequests.add(request);
						await route.abort();
					}
					return;
				}
				if (fixture && url.pathname === "/site-kit/data") {
					await route.fulfill({ json: fixture });
					return;
				}
				await route.continue();
			});
			await context.routeWebSocket("**/*", (socket) => {
				if (new URL(socket.url()).host === new URL(origin).host && !versionId)
					socket.connectToServer();
				else {
					issue(`Unapproved WebSocket: ${socket.url()}`);
					socket.close();
				}
			});
			setupCategory = "infrastructure";
			// Establish the shared browser cookie without loading the gateway's
			// self-refreshing waiting page, which can abort the first checked visit.
			const opened = await context.request.get(
				`${origin}/__open?site=${encodeURIComponent(siteId)}&version=${encodeURIComponent(versionId || "")}&path=/`,
				{ maxRedirects: 0 },
			);
			assert.equal(opened.status(), 302, "Could not open the preview session");
			const deadline = Date.now() + 90_000;
			while (true) {
				const ready = await context.request.get(`${origin}/`, {
					maxRedirects: 0,
				});
				if (
					ready.status() === 200 ||
					(ready.status() >= 500 &&
						ready.headers()["x-studio-preview-state"] !== "starting")
				)
					break;
				if (![202, 503].includes(ready.status()) || Date.now() >= deadline)
					throw new Error(
						`The preview did not become ready: HTTP ${ready.status()}`,
					);
				await new Promise((resolve) => setTimeout(resolve, 1000));
			}
			setupCategory = "integration";
			const capabilities = await context.request.get(`${origin}/site-kit/qa`, {
				maxRedirects: 0,
			});
			assert.ok(
				capabilities.ok(),
				"The gateway has no test-safe Site Kit contract",
			);
			const contract = await capabilities.json();
			assert.equal(
				contract.testMode,
				true,
				"Refusing to submit forms without test mode",
			);
			assert.equal(
				typeof contract.organization,
				"string",
				"Missing test organization",
			);
			const data = await context.request.get(`${origin}/site-kit/data`, {
				maxRedirects: 0,
			});
			assert.ok(data.ok(), "Business data endpoint failed");
			assert.deepEqual(
				await data.json(),
				options.business,
				"The gateway returned different business data",
			);
			setupCategory = undefined;
			checking = true;
			const coveredBindings = new Set<string>();
			let serviceBindings = 0;
			let bookingLinks = 0;
			let leadForms = 0;
			for (const [routeIndex, routeNameValue] of options.routes.entries()) {
				routeName = routeNameValue;
				assert.ok(
					routeName.startsWith("/") && !routeName.startsWith("//"),
					"Invalid QA route",
				);
				assert.equal(
					new URL(routeName, origin).origin,
					origin,
					"QA route leaves gateway",
				);
				consoleLog.length = 0;
				network.length = 0;
				const prefix = `route-${routeIndex}-${viewport.width}`;
				const visit = () => visitPreview(page, `${origin}${routeName}`);
				async function check(
					action: string,
					expected: string,
					run: () => Promise<string | undefined>,
				) {
					const before = errors.length;
					const warningsBefore = warnings.length;
					let actual = expected;
					let status: QAEvidence["status"] = "passed";
					try {
						actual =
							(await run()) ?? "Checks completed without an assertion failure";
					} catch (error) {
						if (error instanceof PreviewUnavailableError)
							failureCategory = "infrastructure";
						actual = error instanceof Error ? error.message : String(error);
						issue(`${action}: ${actual}`);
					}
					if (errors.length > before) {
						status = "failed";
						actual = errors.slice(before).join("\n");
					} else if (warnings.length > warningsBefore) {
						status = "warning";
						actual += `; ${warnings.slice(warningsBefore).join("; ")}`;
					}
					const screenshot = `${prefix}-${evidence.length}.png`;
					let screenshotSaved = false;
					try {
						await page.screenshot({
							path: join(directory, screenshot),
							fullPage: true,
						});
						screenshots.push(screenshot);
						screenshotSaved = true;
					} catch (error) {
						status = "failed";
						actual += `; screenshot failed: ${String(error)}`;
						issue(actual);
					}
					evidence.push({
						route: routeName,
						url: page.url(),
						viewport,
						action,
						expected,
						actual,
						status,
						screenshot: screenshotSaved ? screenshot : undefined,
						console: [...consoleLog],
						network: [...network],
					});
					if (status === "passed")
						checks.push(`${routeName} · ${viewport.width}px · ${action}`);
				}
				await check(
					"Page health",
					"HTTP 200, visible main content, one H1, title, description and no horizontal overflow",
					async () => {
						const response = await visit();
						assert.equal(
							response?.status(),
							200,
							`Page returned HTTP ${response?.status()}`,
						);
						assert.equal(
							await page.getByRole("heading", { level: 1 }).count(),
							1,
							"Expected one H1",
						);
						assert.ok((await page.title()).trim(), "Missing title");
						assert.ok(
							(
								await page
									.locator('meta[name="description"]')
									.getAttribute("content")
							)?.trim(),
							"Missing description",
						);
						assert.ok(
							await page.locator("main").isVisible(),
							"Main content is invisible",
						);
						assert.ok(
							(await page.locator("main").innerText()).trim().length > 20,
							"Empty main content",
						);
						assert.equal(
							await page.evaluate(
								() => document.documentElement.scrollWidth > innerWidth + 2,
							),
							false,
							"Horizontal overflow",
						);
						return `HTTP ${response?.status()}; title: ${await page.title()}; visible main: ${(await page.locator("main").innerText()).trim().length} characters; one H1; no overflow`;
					},
				);
				await check(
					"Accessibility",
					"No critical or serious WCAG A/AA violations",
					async () => {
						const result = await new AxeBuilder({ page })
							.withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
							.analyze();
						await writeFile(
							join(directory, `${prefix}-accessibility.json`),
							JSON.stringify(result, null, 2),
							{ flag: "wx" },
						);
						for (const violation of result.violations) {
							const message = `${violation.id}: ${violation.help}; ${violation.nodes.map((node) => node.target.join(" ")).join(", ")}`;
							if (["critical", "serious"].includes(violation.impact ?? ""))
								issue(message);
							else
								warnings.push(
									`${routeName} at ${viewport.width}px: ${message}`,
								);
						}
						return `${result.passes.length} accessibility rules passed; ${result.violations.length} violations recorded`;
					},
				);
				await check(
					"Navigation",
					"Every internal link loads, the logo returns home and mobile navigation works from the keyboard",
					async () => {
						const links = await page
							.locator("a[href]")
							.evaluateAll((nodes) =>
								nodes.map((node) => (node as HTMLAnchorElement).href),
							);
						for (const target of new Set(links)) {
							if (new URL(target).origin !== origin) continue;
							let next = target;
							for (let redirects = 0; redirects <= 5; redirects++) {
								const response = await context.request.get(next, {
									maxRedirects: 0,
								});
								network.push(`GET ${next} -> ${response.status()}`);
								if (response.status() >= 300 && response.status() < 400) {
									assert.ok(redirects < 5, `Redirect loop: ${target}`);
									next = new URL(response.headers().location, next).href;
									assert.equal(
										new URL(next).origin,
										origin,
										`Internal link redirects off-site: ${target}`,
									);
								} else {
									assert.ok(
										response.ok(),
										`Broken internal link ${target}: HTTP ${response.status()}`,
									);
									break;
								}
							}
						}
						const logo = page.locator("a.brand").first();
						await logo.click();
						await page.waitForLoadState("networkidle");
						assert.equal(
							new URL(page.url()).pathname,
							"/",
							"Logo does not return home",
						);
						await visit();
						const menu = page.getByRole("button", {
							name: "Toggle navigation",
						});
						if (viewport.width === 390) {
							await menu.focus();
							await page.keyboard.press("Enter");
							assert.equal(
								await menu.getAttribute("aria-expanded"),
								"true",
								"Menu did not open",
							);
							const first = page
								.getByRole("navigation")
								.getByRole("link")
								.first();
							assert.ok(await first.isVisible(), "Navigation is hidden");
							await page.keyboard.press("Tab");
							assert.ok(
								await first.evaluate((el) => el === document.activeElement),
								"Menu links are not keyboard reachable",
							);
							await menu.focus();
							await page.keyboard.press("Enter");
							assert.equal(
								await menu.getAttribute("aria-expanded"),
								"false",
								"Menu did not close",
							);
						}
						return `${new Set(links.filter((target) => new URL(target).origin === origin)).size} internal targets loaded; logo returned home${viewport.width === 390 ? "; keyboard menu opened, focused links and closed" : ""}`;
					},
				);
				await check(
					"Booking",
					"Each visible booking link, including the open mobile menu, opens the same organization on this host",
					async () => {
						await visit();
						const links = page.locator("a[href]");
						const count = await links.count();
						let clicked = 0;
						for (let i = 0; i < count; i++) {
							const link = links.nth(i);
							const href = (await link.getAttribute("href")) ?? "";
							if (
								!/\b(book|appointment|reserve)\b/i.test(
									await link.innerText(),
								) &&
								!href.startsWith("/book")
							)
								continue;
							if (!(await link.isVisible()) && viewport.width === 390) {
								const menu = page.getByRole("button", {
									name: "Toggle navigation",
								});
								if (
									(await menu.isVisible()) &&
									(await menu.getAttribute("aria-expanded")) !== "true"
								) {
									await menu.focus();
									await page.keyboard.press("Enter");
								}
							}
							if (!(await link.isVisible())) continue;
							await check(
								`Booking link ${i + 1}`,
								`Open ${href} for organization ${contract.organization} on this host`,
								async () => {
									assert.ok(
										/^\/book(?:\?|$)/.test(href),
										`Booking bypasses Site Kit: ${href}`,
									);
									assert.notEqual(
										await link.getAttribute("target"),
										"_blank",
										"Booking must stay in this preview",
									);
									await link.click();
									await page.waitForLoadState("networkidle");
									assert.equal(
										new URL(page.url()).origin,
										origin,
										"Booking left this host",
									);
									assert.equal(
										new URL(page.url()).pathname,
										"/book",
										"Wrong booking route",
									);
									assert.equal(
										await page
											.locator("main")
											.getAttribute("data-booking-organization"),
										contract.organization,
										"Wrong booking organization",
									);
									assert.ok(
										await page.getByRole("heading", { level: 1 }).isVisible(),
										"Booking did not load",
									);
									clicked++;
									bookingLinks++;

									return `${page.url()} rendered booking for ${contract.organization}`;
								},
							);
							await visit();
						}
						return `${clicked} visible booking links clicked; organization ${contract.organization}; host ${origin}`;
					},
				);
				await check(
					"Live business data",
					"Site Kit bindings render fresh fixture values instead of copied HTML",
					async () => {
						fixture = structuredClone(options.business);
						const sentinel = `QA-${randomUUID()}`;
						fixture.services = [
							{ name: sentinel, price: 37, duration: "41 min" },
						];
						for (const field of [
							"name",
							"address",
							"hours",
							"email",
							"phone",
						] as const)
							fixture[field] = `${sentinel}-${field}`;
						try {
							await visit();
							const bindings = page.locator("[data-business]");
							for (let i = 0; i < (await bindings.count()); i++) {
								const binding = bindings.nth(i);
								const key = await binding.getAttribute("data-business");
								assert.ok(
									key && key in fixture,
									`Unknown data binding: ${key}`,
								);
								coveredBindings.add(key);
								assert.equal(
									await binding.innerText(),
									String(fixture[key as keyof Business]),
									`Stale business value: ${key}`,
								);
							}
							const services = page.locator("[data-services]");
							for (let i = 0; i < (await services.count()); i++) {
								serviceBindings++;
								const text = await services.nth(i).innerText();
								assert.ok(
									text.includes(sentinel) &&
										text.includes("37") &&
										text.includes("41 min"),
									"Services or prices are not live",
								);
							}
							return `${await bindings.count()} business fields and ${await services.count()} service lists rendered changed fixture data`;
						} finally {
							fixture = undefined;
						}
					},
				);
				const forms = page.locator("form");
				for (let i = 0; i < (await forms.count()); i++) {
					leadForms++;
					await check(
						`Lead form ${i + 1}`,
						"Required fields and consent block submission; one test enquiry preserves organization and attribution",
						async () => {
							await visit();
							const form = page.locator("form").nth(i);
							assert.notEqual(
								await form.getAttribute("data-lead-form"),
								null,
								"Form bypasses Site Kit",
							);
							leadTesting = true;
							leadRequests = 0;
							leadReceiptBody = undefined;
							try {
								const submit = form.locator('button[type="submit"]');
								await submit.click();
								assert.equal(
									await form.evaluate((el) =>
										(el as HTMLFormElement).checkValidity(),
									),
									false,
									"Empty form is valid",
								);
								assert.equal(leadRequests, 0, "Empty form sent a request");
								await form.locator('[name="name"]').fill("Site Studio QA");
								await form.locator('[name="email"]').fill("qa@example.test");
								await form
									.locator('[name="message"]')
									.fill("Automated test. No real notification.");
								await submit.click();
								assert.equal(
									await form.evaluate((el) =>
										(el as HTMLFormElement).checkValidity(),
									),
									false,
									"Consent is not required",
								);
								assert.equal(leadRequests, 0, "Form submitted without consent");
								await form.locator('[name="consent"]').check();
								const [response] = await Promise.all([
									page.waitForResponse(
										(r) =>
											new URL(r.url()).pathname === "/site-kit/leads" &&
											r.request().method() === "POST",
									),
									submit.click(),
								]);
								assert.ok(response.ok(), "Lead submit failed");
								assert.ok(
									leadReceiptBody,
									"The lead endpoint returned no receipt",
								);
								const receipt = JSON.parse(leadReceiptBody);
								assert.equal(
									receipt.testMode,
									true,
									"Lead endpoint is not in test mode",
								);
								assert.equal(
									receipt.organization,
									contract.organization,
									"Wrong lead organization",
								);
								assert.equal(
									receipt.attribution,
									"microsite",
									"Missing attribution",
								);
								await form
									.getByRole("status")
									.filter({ hasText: "test enquiry was received" })
									.waitFor();
								assert.ok(
									await submit.isDisabled(),
									"Submit button allows duplicate enquiry",
								);
								await form.evaluate((el) => {
									(el as HTMLFormElement).requestSubmit();
									(el as HTMLFormElement).requestSubmit();
								});
								await page.waitForLoadState("networkidle");
								assert.equal(
									leadRequests,
									1,
									"Duplicate lead submissions reached the backend",
								);
								return `One test enquiry accepted for ${receipt.organization}, attribution ${receipt.attribution}; empty/consent/duplicate attempts sent no extra requests`;
							} finally {
								leadTesting = false;
							}
						},
					);
				}
				options.onPageChecked?.();
			}
			if (!bookingLinks) issue("No booking link was exercised", "Site-wide");
			if (!leadForms) issue("No enquiry form was exercised", "Site-wide");
			if (!serviceBindings)
				issue("No live service listing was exercised", "Site-wide");
			for (const key of ["address", "hours", "email", "phone"])
				if (!coveredBindings.has(key))
					issue(`No live ${key} binding was exercised`, "Site-wide");
			await context.close();
		}
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		if (
			error instanceof PreviewUnavailableError ||
			/net::ERR_|Target.*closed|browser.*closed|ECONNREFUSED|ENOTFOUND/i.test(
				detail,
			)
		)
			failureCategory = "infrastructure";
		failureCategory ??= setupCategory;
		errors.push(detail);
	} finally {
		await browser?.close();
	}
	const result = {
		status: errors.length ? ("failed" as const) : ("passed" as const),
		checks,
		failureCategory,
		errors: [...new Set(errors)],
		warnings: [...new Set(warnings)],
		screenshots,
		evidence,
	};
	await writeFile(
		join(directory, "qa-report.json"),
		JSON.stringify(result, null, 2),
		{ flag: "wx" },
	);
	return result;
}
