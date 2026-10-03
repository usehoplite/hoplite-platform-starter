import { minutes, parseHours, weekDayOf } from "./hours";
import type { Business } from "./types";

/** Host-owned pages and helpers served on every website origin. */

export function escapeHtml(value: string) {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

/** A stable, URL-safe identifier for the business in test-mode receipts. */
export function organizationSlug(business: Pick<Business, "name">) {
	return (
		business.name
			.normalize("NFKD")
			.replace(/[̀-ͯ]/g, "")
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 60) || "business"
	);
}

/**
 * Visitor-facing routes in a website's source: every static page under
 * src/pages. Dynamic and private (underscore) pages are not listed.
 */
export function pageRoutes(files: { path: string }[]) {
	const routes = new Set<string>();
	for (const { path } of files) {
		const match = path.match(/^src\/pages\/(.+)\.(?:astro|md|html)$/);
		if (!match) continue;
		const parts = match[1].split("/");
		if (parts.some((part) => part.startsWith("_") || part.includes("[")))
			continue;
		if (parts.at(-1) === "index") parts.pop();
		if (parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) continue;
		routes.add(`/${parts.join("/")}`);
	}
	return [...routes]
		.sort((a, b) => (a === "/" ? -1 : b === "/" ? 1 : a.localeCompare(b)))
		.slice(0, 40);
}

/** The page a preview opens on: any simple host-relative path, else home. */
export function safePreviewPath(path: string | null | undefined) {
	return path &&
		path.length <= 200 &&
		/^\/(?:[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\/?)?$/.test(path)
		? path
		: "/";
}

/** Friendly name for a route in the page picker. */
export function routeLabel(route: string) {
	if (route === "/") return "Home";
	const last = route.replace(/\/$/, "").split("/").at(-1) ?? route;
	const words = last.replace(/[-_]+/g, " ").trim();
	return words ? words[0].toUpperCase() + words.slice(1) : route;
}

export function formatPrice(value: number, currency = "EUR") {
	try {
		const format = new Intl.NumberFormat("en-IE", {
			style: "currency",
			currency,
		});
		return Number.isInteger(value) &&
			format.resolvedOptions().maximumFractionDigits === 2
			? new Intl.NumberFormat("en-IE", {
					style: "currency",
					currency,
					minimumFractionDigits: 0,
					maximumFractionDigits: 0,
				}).format(value)
			: format.format(value);
	} catch {
		return `${currency} ${value}`;
	}
}

/** WCAG relative luminance of an sRGB colour given as 0–255 channels. */
function luminance([r, g, b]: number[]) {
	const linear = (channel: number) => {
		const value = channel / 255;
		return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}
/** WCAG contrast ratio between two sRGB colours. */
export function contrastRatio(a: number[], b: number[]) {
	const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (light + 0.05) / (dark + 0.05);
}
function rgb(value: string) {
	const match = value
		.trim()
		.match(
			/^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})(?:\s*[,/]\s*(\d*\.?\d+))?\s*\)$/,
		);
	if (!match) return;
	const channels = match.slice(1, 4).map(Number);
	if (channels.some((channel) => channel > 255)) return;
	if (match[4] !== undefined && Number(match[4]) < 1) return;
	return channels;
}
/**
 * The website's own booking-button colours, as measured in the browser,
 * accepted only as plain opaque RGB with readable (AA) contrast. Anything else
 * leaves the booking page's neutral button.
 */
export function bookingButtonStyle(style: {
	background: string;
	color: string;
}) {
	const background = rgb(style.background);
	const color = rgb(style.color);
	if (!background || !color || contrastRatio(background, color) < 4.5) return;
	return {
		background: `rgb(${background.join(" ")})`,
		color: `rgb(${color.join(" ")})`,
	};
}

/** Service length in minutes, from text such as "50 min" or "1.5 hours". */
export function serviceMinutes(duration: string) {
	const hours = duration.match(
		/(\d+(?:[.,]\d+)?)\s*(?:h|hr|hrs|hour|hours)\b/i,
	);
	const mins = duration.match(/(\d+)\s*(?:m|min|mins|minutes?)\b/i);
	const total =
		(hours ? Math.round(Number(hours[1].replace(",", ".")) * 60) : 0) +
		(mins ? Number(mins[1]) : 0);
	return total > 0 && total <= 12 * 60 ? total : 30;
}
function localDate(date: Date) {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function clock(value: number) {
	return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}
/**
 * The days the booking page can offer over the next two weeks, with each
 * day's opening and closing minutes from the saved opening hours (09:00–17:00
 * on every day when they cannot be read). Today starts after the current time.
 */
function openDays(
	business: Pick<Business, "hours" | "weeklyHours">,
	now: Date,
) {
	const hours = business.weeklyHours ?? parseHours(business.hours);
	const days: {
		value: string;
		label: string;
		open: number;
		close: number;
		earliest: number;
	}[] = [];
	for (let offset = 0; offset < 14; offset++) {
		const date = new Date(
			now.getFullYear(),
			now.getMonth(),
			now.getDate() + offset,
		);
		const range = hours
			? hours[weekDayOf(date)]
			: { open: "09:00", close: "17:00" };
		if (!range) continue;
		days.push({
			value: localDate(date),
			label: new Intl.DateTimeFormat("en-IE", {
				weekday: "short",
				day: "numeric",
				month: "short",
			}).format(date),
			open: minutes(range.open),
			close: minutes(range.close),
			// Today offers only start times that are still ahead.
			earliest: offset === 0 ? now.getHours() * 60 + now.getMinutes() + 1 : 0,
		});
	}
	return days;
}
/** Start times on one day for a visit of `length` minutes, every half hour. */
function dayTimes(
	day: { open: number; close: number; earliest: number },
	length: number,
) {
	const times: string[] = [];
	for (let start = day.open; start + length <= day.close; start += 30)
		if (start >= day.earliest) times.push(clock(start));
	return times;
}
/**
 * The days and start times the test-mode booking page offers for a service:
 * the next two weeks, following the saved opening hours when they can be
 * read (every half hour a visit still fits before closing).
 */
export function bookingSlots(
	business: Pick<Business, "hours" | "weeklyHours">,
	duration: string,
	now = new Date(),
) {
	const length = serviceMinutes(duration);
	return openDays(business, now)
		.map(({ value, label, ...day }) => ({
			value,
			label,
			times: dayTimes(day, length),
		}))
		.filter((day) => day.times.length);
}

/**
 * The booking page every website links to with /book. It is in test mode:
 * the visitor chooses a service, a day and a time and sees a confirmation;
 * no appointment is created. Its button uses the website's own booking colour
 * when one was measured.
 */
export function bookingPage(
	business: Business,
	query: URLSearchParams,
	organization = organizationSlug(business),
	options: {
		now?: Date;
		style?: { background: string; color: string };
	} = {},
) {
	const name = escapeHtml(business.name || "Our business");
	const chosen = business.services.find(
		(service) => service.name === query.get("service"),
	);
	const slots = bookingSlots(business, chosen?.duration ?? "", options.now);
	const day = slots.find((item) => item.value === query.get("day"));
	const time = query.get("time") ?? "";
	// When any time is on offer, a confirmation needs a valid day and time.
	const askedForTime =
		query.has("day") || query.has("time") || query.get("requested") === "1";
	const slotTaken =
		askedForTime && slots.length > 0 && !day?.times.includes(time);
	const requested = query.get("requested") === "1" && chosen && !slotTaken;
	const when =
		requested && day
			? ` for ${escapeHtml(
					new Intl.DateTimeFormat("en-IE", {
						weekday: "long",
						day: "numeric",
						month: "long",
					}).format(new Date(`${day.value}T12:00:00`)),
				)} at ${escapeHtml(time)}`
			: "";
	const style = options.style && bookingButtonStyle(options.style);
	const services = business.services
		.map((service, index) => {
			const id = `service-${index}`;
			const details = [
				formatPrice(service.price, business.currency),
				service.duration,
			]
				.filter(Boolean)
				.map(escapeHtml)
				.join(" · ");
			return `<label class="option" for="${id}"><input type="radio" id="${id}" name="service" value="${escapeHtml(service.name)}" required${service === chosen ? " checked" : ""}><span><strong>${escapeHtml(service.name)}</strong>${details ? `<small>${details}</small>` : ""}${service.description ? `<small>${escapeHtml(service.description)}</small>` : ""}</span></label>`;
		})
		.join("");
	const contact = [
		business.phone
			? `<a href="tel:${escapeHtml(business.phone.replace(/[^\d+]/g, ""))}">${escapeHtml(business.phone)}</a>`
			: "",
		business.email
			? `<a href="mailto:${escapeHtml(business.email)}">${escapeHtml(business.email)}</a>`
			: "",
	]
		.filter(Boolean)
		.join(" · ");
	const heading = requested
		? `Thanks — ${escapeHtml(chosen.name)} is noted${when}`
		: chosen
			? `Book ${escapeHtml(chosen.name)}`
			: "Choose a service";
	// The chosen day's own times; before a day is chosen (and without
	// scripts) every time any day offers. The script below narrows the list to
	// the chosen day and service, and the day is checked again on submit.
	const times = day
		? day.times
		: [...new Set(slots.flatMap((item) => item.times))].sort();
	const script = slots.length
		? `<script type="application/json" id="booking-days">${JSON.stringify({
				days: openDays(business, options.now ?? new Date()),
				lengths: Object.fromEntries(
					business.services.map((service) => [
						service.name,
						serviceMinutes(service.duration),
					]),
				),
			}).replaceAll("<", "\\u003c")}</script><script>${bookingScript}</script>`
		: "";
	const schedule = slots.length
		? `<fieldset class="when"><legend>Day and time</legend>${slotTaken ? `<p class="notice" role="alert">${query.has("day") || query.has("time") ? "That time isn’t available on that day. Choose another day or time." : "Choose a day and a time to continue."}</p>` : ""}<label for="booking-day">Day<select id="booking-day" name="day" required><option value="">Choose a day</option>${slots.map((item) => `<option value="${item.value}"${item === day ? " selected" : ""}>${escapeHtml(item.label)}</option>`).join("")}</select></label><label for="booking-time">Time<select id="booking-time" name="time" required><option value="">Choose a time</option>${times.map((item) => `<option value="${item}"${item === time && !slotTaken ? " selected" : ""}>${item}</option>`).join("")}</select></label></fieldset>`
		: "";
	const body = requested
		? `<p>Online booking for ${name} is in test mode, so no appointment was made and nothing was charged.</p><p><a class="button" href="/book">Book something else</a></p>`
		: `<form method="get" action="/book"><fieldset><legend>Services</legend>${services || "<p>Services will appear here soon.</p>"}</fieldset>${schedule}<input type="hidden" name="requested" value="1"><button type="submit">Continue</button></form><p class="note">Online booking is in test mode: no appointment is made and nothing is charged.</p>`;
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${chosen ? `Book ${escapeHtml(chosen.name)}` : "Book"} · ${name}</title><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><link rel="stylesheet" href="/site.css"><style>
.studio-booking { box-sizing:border-box; max-width:640px; margin:0 auto; padding:32px 20px 56px; }
.studio-booking * { box-sizing:border-box; }
.studio-booking .brand { display:inline-block; margin-bottom:32px; font-weight:600; text-decoration:none; color:inherit; }
.studio-booking h1 { margin:0 0 12px; line-height:1.15; }
.studio-booking fieldset { border:0; margin:24px 0; padding:0; display:grid; gap:12px; }
.studio-booking legend { font-weight:600; margin-bottom:12px; }
.studio-booking .option { display:flex; gap:12px; align-items:flex-start; padding:16px; border:1px solid color-mix(in srgb, currentColor 22%, transparent); border-radius:12px; cursor:pointer; }
.studio-booking .option:has(input:checked) { border-color:currentColor; }
.studio-booking .option input { margin-top:4px; }
.studio-booking .option span { display:grid; gap:4px; }
.studio-booking small { font-size:.9em; }
.studio-booking button, .studio-booking .button { display:inline-block; font:inherit; padding:12px 22px; border:0; border-radius:999px; background:${style?.background ?? "CanvasText"}; color:${style?.color ?? "Canvas"}; text-decoration:none; cursor:pointer; }
.studio-booking .when { grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); }
.studio-booking .when legend, .studio-booking .when .notice { grid-column:1 / -1; }
.studio-booking .when label { display:grid; gap:6px; font-weight:600; }
.studio-booking select { font:inherit; padding:10px 12px; border:1px solid color-mix(in srgb, currentColor 35%, transparent); border-radius:10px; background:Canvas; color:CanvasText; }
.studio-booking .notice { margin:0; font-weight:600; }
.studio-booking .note, .studio-booking .contact { font-size:.95em; }
</style></head><body><main class="studio-booking" data-booking-organization="${escapeHtml(organization)}"><a class="brand" href="/">${name}</a><h1>${heading}</h1>${body}${contact ? `<p class="contact">Questions? ${contact}</p>` : ""}<p><a href="/">← Back to ${name}</a></p></main>${requested ? "" : script}</body></html>`;
}

/**
 * Narrows the booking page's times to the chosen day and service: only that
 * day's opening hours, only visits that end by closing, and on today only
 * times still ahead. Days with no time for the chosen service are disabled.
 */
const bookingScript = `(() => {
	const data = JSON.parse(document.getElementById("booking-days").textContent);
	const form = document.querySelector(".studio-booking form");
	const day = form && form.elements.namedItem("day");
	const time = form && form.elements.namedItem("time");
	if (!day || !time) return;
	const clock = (value) => String(Math.floor(value / 60)).padStart(2, "0") + ":" + String(value % 60).padStart(2, "0");
	const length = () => {
		const chosen = form.querySelector('input[name="service"]:checked');
		const known = Object.values(data.lengths);
		return chosen ? data.lengths[chosen.value] || 30 : known.length ? Math.min(...known) : 30;
	};
	const times = (item) => {
		const list = [];
		for (let start = item.open; start + length() <= item.close; start += 30)
			if (start >= item.earliest) list.push(clock(start));
		return list;
	};
	const update = () => {
		for (const option of day.options) {
			if (!option.value) continue;
			const item = data.days.find((entry) => entry.value === option.value);
			option.disabled = !item || !times(item).length;
		}
		if (day.selectedOptions[0] && day.selectedOptions[0].disabled) day.value = "";
		const item = data.days.find((entry) => entry.value === day.value);
		const list = item ? times(item) : [];
		const kept = time.value;
		time.replaceChildren(new Option(item ? "Choose a time" : "Choose a day first", ""), ...list.map((value) => new Option(value, value)));
		time.value = list.includes(kept) ? kept : "";
	};
	form.addEventListener("change", (event) => {
		if (event.target !== time) update();
	});
	update();
})();`;

/**
 * Shown inside the preview frame when the workspace is paused after idle.
 * It never refreshes itself into a restart: only the owner's "Wake preview"
 * click (or activity in the studio) wakes it. Its poll reads the gateway's
 * own state, never the workspace, and reloads once a wake is under way.
 */
export function pausedPage(siteId: string, path: string) {
	const wake = `/__open?site=${encodeURIComponent(siteId)}&wake=1&path=${encodeURIComponent(path)}`;
	return `<!doctype html><html lang="en"><head><title>Preview paused</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>
body { margin:0;display:grid;place-items:center;min-height:100vh;background:#f4f4f4;color:#333;font:14px/20px system-ui }
main { display:grid;justify-items:center;gap:12px;text-align:center;padding:24px }
p { margin:0 }
.hint { color:#666;font-size:12px;line-height:18px }
a { display:inline-block;padding:8px 14px;border-radius:8px;background:#121212;color:#fff;text-decoration:none;font-weight:500 }
a:focus-visible { outline:2px solid #2563eb;outline-offset:2px }
</style></head><body><main><p>Your preview is paused. Your website is saved.</p><a href="${escapeHtml(wake)}">Wake preview</a><p class="hint">It pauses after a while without changes to save resources.</p></main><script>
setInterval(async () => {
	try {
		const response = await fetch("/__preview-state", { cache: "no-store" });
		const { state } = await response.json();
		if (state !== "paused") location.reload();
	} catch {}
}, 3000);
</script></body></html>`;
}

/** Shown inside the preview frame while a website starts. Neutral, unbranded. */
export function waitingPage(message = "Loading preview…") {
	return `<!doctype html><html lang="en"><head><title>${escapeHtml(message)}</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>
body { margin:0;display:grid;place-items:center;min-height:100vh;background:#f4f4f4;color:#666;font:12px/18px system-ui }
main { display:grid;justify-items:center;gap:16px;text-align:center;padding:24px }
.spinner { width:24px;height:24px;border:2px solid rgb(102 102 102 / .25);border-top-color:#666;border-radius:50%;animation:spin 1s linear infinite }
p { margin:0 }
@keyframes spin { to { transform:rotate(360deg) } }
@media(prefers-reduced-motion:reduce) { .spinner {animation:none} }
</style></head><body><main role="status"><div class="spinner" aria-hidden="true"></div><p>${escapeHtml(message)}</p></main></body></html>`;
}
