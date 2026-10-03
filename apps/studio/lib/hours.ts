import type { JsonValue } from "./types";

/**
 * Opening hours set day by day in Business details. The website shows them
 * through Site Kit's `hours` text, which is derived from these ranges (for
 * example "Mon–Fri 07:00–20:00 · Sat 09:00–14:00"), so every Site Kit
 * revision keeps working unchanged.
 */
export const weekDays = [
	"mon",
	"tue",
	"wed",
	"thu",
	"fri",
	"sat",
	"sun",
] as const;
export type WeekDay = (typeof weekDays)[number];
/** Each open day's hours; a missing day is closed. */
export type WeeklyHours = Partial<
	Record<WeekDay, { open: string; close: string }>
>;

export const dayLabels: Record<WeekDay, string> = {
	mon: "Monday",
	tue: "Tuesday",
	wed: "Wednesday",
	thu: "Thursday",
	fri: "Friday",
	sat: "Saturday",
	sun: "Sunday",
};
const short: Record<WeekDay, string> = {
	mon: "Mon",
	tue: "Tue",
	wed: "Wed",
	thu: "Thu",
	fri: "Fri",
	sat: "Sat",
	sun: "Sun",
};

/** "HH:MM" on a 24-hour clock. */
export function validTime(value: JsonValue | undefined): value is string {
	return typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}
export function minutes(time: string) {
	const [hours, mins] = time.split(":").map(Number);
	return hours * 60 + mins;
}

/** The hours text Site Kit shows, grouping neighbouring days with equal hours. */
export function formatWeeklyHours(hours: WeeklyHours) {
	const parts: string[] = [];
	let start = 0;
	while (start < weekDays.length) {
		const range = hours[weekDays[start]];
		if (!range) {
			start++;
			continue;
		}
		let end = start;
		while (
			end + 1 < weekDays.length &&
			hours[weekDays[end + 1]]?.open === range.open &&
			hours[weekDays[end + 1]]?.close === range.close
		)
			end++;
		const days =
			end === start
				? short[weekDays[start]]
				: `${short[weekDays[start]]}–${short[weekDays[end]]}`;
		parts.push(`${days} ${range.open}–${range.close}`);
		start = end + 1;
	}
	return parts.join(" · ");
}

const dayPattern = "(mon|tue|wed|thu|fri|sat|sun)[a-z]*\\.?";
const segment = new RegExp(
	`^${dayPattern}(?:\\s*[–—-]\\s*${dayPattern})?\\s*:?\\s*(?:(\\d{1,2})[:.](\\d{2})\\s*[–—-]\\s*(\\d{1,2})[:.](\\d{2})|(closed))$`,
	"i",
);

/**
 * Reads hours written like the saved text ("Mon–Fri 07:00–20:00 · Sat
 * 09:00–14:00"). Returns undefined for anything else, so free text is never
 * guessed at.
 */
export function parseHours(text: string): WeeklyHours | undefined {
	const pieces = text
		.split(/\s*[·•|;\n]\s*|,\s+(?=[A-Za-z])/)
		.map((piece) => piece.trim())
		.filter(Boolean);
	if (!pieces.length) return;
	const result: WeeklyHours = {};
	for (const piece of pieces) {
		const match = piece.match(segment);
		if (!match) return;
		const from = weekDays.indexOf(match[1].toLowerCase() as WeekDay);
		const to = match[2]
			? weekDays.indexOf(match[2].toLowerCase() as WeekDay)
			: from;
		if (from < 0 || to < from) return;
		if (match[7]) continue;
		const open = `${match[3].padStart(2, "0")}:${match[4]}`;
		const close = `${match[5].padStart(2, "0")}:${match[6]}`;
		if (
			!validTime(open) ||
			!validTime(close) ||
			minutes(open) >= minutes(close)
		)
			return;
		for (let day = from; day <= to; day++)
			result[weekDays[day]] = { open, close };
	}
	return result;
}

/** The day of the week of a date, in the same order as `weekDays`. */
export function weekDayOf(date: Date): WeekDay {
	return weekDays[(date.getDay() + 6) % 7];
}
