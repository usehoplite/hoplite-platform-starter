import {
	dayLabels,
	formatWeeklyHours,
	minutes,
	parseHours,
	validTime,
	type WeekDay,
	type WeeklyHours,
	weekDays,
} from "./hours";
import { formatPrice } from "./site-pages";
import type { Business, JsonObject, JsonValue } from "./types";

export const businessLimits = {
	services: 50,
	team: 30,
	name: 100,
	duration: 40,
	price: 100_000,
	description: 300,
	role: 100,
	bio: 300,
	businessDescription: 1000,
	category: 100,
	bookingLabel: 40,
};

/** Thrown with a message the business owner can act on. */
export class BusinessDetailsError extends Error {
	override name = "BusinessDetailsError";
}

function field(value: JsonValue | undefined, label: string, max = 1000) {
	if (value === undefined || value === null) return "";
	if (typeof value !== "string")
		throw new BusinessDetailsError(`Check the ${label} field.`);
	const text = value.trim();
	if (text.length > max)
		throw new BusinessDetailsError(
			`Keep the ${label} under ${max.toLocaleString("en")} characters.`,
		);
	return text;
}

function record(value: JsonValue | undefined): JsonObject | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? value
		: undefined;
}

/** Validates hours set day by day: a missing day is closed. */
function openingHours(value: JsonValue | undefined): WeeklyHours | undefined {
	if (value === undefined || value === null) return;
	const days = record(value);
	if (!days) throw new BusinessDetailsError("Check your opening hours.");
	const hours: WeeklyHours = {};
	for (const [key, range] of Object.entries(days)) {
		if (!weekDays.includes(key as WeekDay))
			throw new BusinessDetailsError("Check your opening hours.");
		if (range === undefined || range === null) continue;
		const day = key as WeekDay;
		const times = record(range);
		if (!times || !validTime(times.open) || !validTime(times.close))
			throw new BusinessDetailsError(
				`Enter opening and closing times for ${dayLabels[day]}.`,
			);
		if (minutes(times.open) >= minutes(times.close))
			throw new BusinessDetailsError(
				`${dayLabels[day]} must close after it opens.`,
			);
		hours[day] = { open: times.open, close: times.close };
	}
	return hours;
}

/**
 * Validates the business details an owner saves. Any number of services and
 * team members (within generous limits), each with its own fields. Messages
 * name the field to fix in plain language.
 */
export function validBusiness(value: JsonObject): Business {
	const name = field(value.name, "business name", 200);
	if (!name) throw new BusinessDetailsError("Enter your business name.");
	const email = field(value.email, "email", 254);
	if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
		throw new BusinessDetailsError(
			"Enter an email address like name@example.com.",
		);
	const phone = field(value.phone, "phone", 40);
	if (phone && !/^[+\d\s().-]{5,40}$/.test(phone))
		throw new BusinessDetailsError(
			"Enter a phone number using digits, spaces and an optional +.",
		);
	if (!Array.isArray(value.services) || !value.services.length)
		throw new BusinessDetailsError("Add at least one service.");
	if (value.services.length > businessLimits.services)
		throw new BusinessDetailsError(
			`You can list up to ${businessLimits.services} services.`,
		);
	const seen = new Set<string>();
	const services = value.services.map((item, index) => {
		const service = record(item);
		if (!service) throw new BusinessDetailsError(`Check service ${index + 1}.`);
		const serviceName = field(
			service.name,
			`name of service ${index + 1}`,
			businessLimits.name,
		);
		if (!serviceName)
			throw new BusinessDetailsError(`Give service ${index + 1} a name.`);
		const key = serviceName.toLocaleLowerCase("en");
		if (seen.has(key))
			throw new BusinessDetailsError(
				`You have two services called “${serviceName}”. Give each service its own name.`,
			);
		seen.add(key);
		const price = service.price;
		if (
			typeof price !== "number" ||
			!Number.isFinite(price) ||
			price < 0 ||
			price > businessLimits.price
		)
			throw new BusinessDetailsError(
				`Enter a price for ${serviceName} (0 or more).`,
			);
		const duration = field(
			service.duration,
			`length of ${serviceName}`,
			businessLimits.duration,
		);
		const description = field(
			service.description,
			`description of ${serviceName}`,
			businessLimits.description,
		);
		const bookingLabel = field(
			service.bookingLabel,
			`booking button text of ${serviceName}`,
			businessLimits.bookingLabel,
		);
		return {
			name: serviceName,
			// Prices are stored to the cent; Site Kit formats them per currency.
			price: Math.round(price * 100) / 100,
			duration,
			...(description ? { description } : {}),
			...(bookingLabel ? { bookingLabel } : {}),
		};
	});
	const team = value.team === undefined ? [] : value.team;
	if (!Array.isArray(team))
		throw new BusinessDetailsError("Check your team details.");
	if (team.length > businessLimits.team)
		throw new BusinessDetailsError(
			`You can list up to ${businessLimits.team} team members.`,
		);
	const people = team.map((item, index) => {
		const person = record(item);
		if (!person)
			throw new BusinessDetailsError(`Check team member ${index + 1}.`);
		const personName = field(
			person.name,
			`name of team member ${index + 1}`,
			businessLimits.name,
		);
		if (!personName)
			throw new BusinessDetailsError(`Give team member ${index + 1} a name.`);
		const role = field(
			person.role,
			`role of ${personName}`,
			businessLimits.role,
		);
		const bio = field(person.bio, `bio of ${personName}`, businessLimits.bio);
		return { name: personName, role, ...(bio ? { bio } : {}) };
	});
	const currency = field(value.currency, "currency", 3).toUpperCase();
	if (currency && !Intl.supportedValuesOf("currency").includes(currency))
		throw new BusinessDetailsError(
			"Enter a three-letter currency code such as EUR, GBP or USD.",
		);
	const bookingLabel = field(
		value.bookingLabel,
		"booking button text",
		businessLimits.bookingLabel,
	);
	const weeklyHours = openingHours(value.weeklyHours);
	return {
		name,
		category: field(value.category, "business type", businessLimits.category),
		description: field(
			value.description,
			"business description",
			businessLimits.businessDescription,
		),
		email,
		phone,
		address: field(value.address, "location", 300),
		// Hours set day by day are authoritative; Site Kit shows their text.
		hours: weeklyHours
			? formatWeeklyHours(weeklyHours)
			: field(value.hours, "opening hours", 300),
		...(weeklyHours ? { weeklyHours } : {}),
		...(currency ? { currency } : {}),
		...(bookingLabel ? { bookingLabel } : {}),
		services,
		team: people,
	};
}

/**
 * Business facts an owner states in chat ("we're closed on Mondays") become a
 * proposed change the owner confirms with one tap. The agent writes it as one
 * fenced `studio-business` JSON block; the studio parses it, never shows it,
 * and validates it against the same rules as the Business details page.
 */
const textFields = {
	name: "Business name",
	category: "Type of business",
	description: "About your business",
	email: "Email",
	phone: "Phone",
	address: "Location",
	currency: "Currency",
	bookingLabel: "Booking button text",
} as const;
type TextField = keyof typeof textFields;
const proposalLimit = 8000;
/** The block, on its own lines or written inline on one line. */
const proposalBlock = /```studio-business\s*([\s\S]*?)\s*```/;

/** The proposed change in an agent message, if it wrote a readable one. */
export function extractBusinessProposal(text: string): JsonObject | undefined {
	const match = text.match(proposalBlock);
	if (!match || match[1].length > proposalLimit) return;
	try {
		return record(JSON.parse(match[1]));
	} catch {
		return;
	}
}

/** Chat text without proposal blocks, including one still being written. */
export function withoutBusinessProposal(text: string) {
	let clean = text.replace(/```studio-business[\s\S]*?(?:```|$)/g, "");
	const fence = clean.lastIndexOf("```");
	if (fence !== -1 && "```studio-business".startsWith(clean.slice(fence)))
		clean = clean.slice(0, fence);
	return clean;
}

function operations(value: JsonValue | undefined) {
	if (value === undefined) return [];
	if (!Array.isArray(value))
		throw new BusinessDetailsError("That change can't be read.");
	return value;
}

/**
 * Applies a proposed change to the current details and validates the result
 * exactly like a Business details save. Throws BusinessDetailsError when the
 * change is not something the details hold, names something that does not
 * exist, or leaves the details invalid.
 */
export function applyBusinessProposal(
	current: Business,
	patch: JsonObject,
): Business {
	const allowed = new Set([
		...Object.keys(textFields),
		"weeklyHours",
		"services",
		"team",
	]);
	if (
		!Object.keys(patch).length ||
		Object.keys(patch).some((key) => !allowed.has(key))
	)
		throw new BusinessDetailsError(
			"That change isn't something your business details hold.",
		);
	const next: JsonObject = JSON.parse(JSON.stringify(current));
	for (const key of Object.keys(textFields) as TextField[]) {
		const value = patch[key];
		if (value === undefined) continue;
		if (typeof value !== "string")
			throw new BusinessDetailsError(`Check the ${textFields[key]}.`);
		next[key] = value;
	}
	if (patch.weeklyHours !== undefined) {
		const days = record(patch.weeklyHours);
		if (!days) throw new BusinessDetailsError("Check your opening hours.");
		const base = current.weeklyHours ?? parseHours(current.hours);
		// Free-text hours cannot be changed one day at a time.
		if (!base && weekDays.some((day) => !(day in days)))
			throw new BusinessDetailsError(
				"Set your opening hours day by day in Business details first.",
			);
		const hours: JsonObject = { ...(base ?? {}) };
		for (const [day, range] of Object.entries(days)) {
			if (!weekDays.includes(day as WeekDay))
				throw new BusinessDetailsError("Check your opening hours.");
			if (range === null) delete hours[day];
			else hours[day] = range;
		}
		next.weeklyHours = hours;
	}
	for (const [key, label] of [
		["services", "service"],
		["team", "team member"],
	] as const) {
		if (patch[key] === undefined) continue;
		const changes = record(patch[key]);
		if (
			!changes ||
			Object.keys(changes).some(
				(op) => !["add", "update", "remove"].includes(op),
			)
		)
			throw new BusinessDetailsError("That change can't be read.");
		const list = [...((next[key] as JsonObject[] | undefined) ?? [])];
		const find = (name: JsonValue | undefined) => {
			const index =
				typeof name === "string"
					? list.findIndex(
							(item) =>
								String(item.name).toLocaleLowerCase("en") ===
								name.trim().toLocaleLowerCase("en"),
						)
					: -1;
			if (index < 0)
				throw new BusinessDetailsError(
					`There is no ${label} called “${String(name)}”.`,
				);
			return index;
		};
		// Only fields the details actually hold: anything else would be
		// silently dropped on save, so the owner would confirm a partial change.
		const fields =
			key === "services"
				? ["name", "price", "duration", "description", "bookingLabel"]
				: ["name", "role", "bio"];
		const entry = (change: JsonValue, update: boolean) => {
			const item = record(change);
			if (
				!item ||
				Object.keys(item).some(
					(field) =>
						!fields.includes(field) && !(update && field === "newName"),
				)
			)
				throw new BusinessDetailsError("That change can't be read.");
			return item;
		};
		for (const name of operations(changes.remove)) list.splice(find(name), 1);
		for (const change of operations(changes.update)) {
			const item = entry(change, true);
			const index = find(item.name);
			const { name: _name, newName, ...fields } = item;
			list[index] = {
				...list[index],
				...fields,
				...(typeof newName === "string" ? { name: newName } : {}),
			};
		}
		for (const change of operations(changes.add))
			list.push(entry(change, false));
		next[key] = list;
	}
	return validBusiness(next);
}

const same = (a: string, b: string) =>
	a.toLocaleLowerCase("en") === b.toLocaleLowerCase("en");

/** Plain wording for the owner's confirmation card. */
export function describeBusinessChange(before: Business, after: Business) {
	const changes: string[] = [];
	const kinds = new Set<string>();
	const hoursBefore = before.weeklyHours ?? parseHours(before.hours) ?? {};
	const hoursAfter = after.weeklyHours ?? parseHours(after.hours) ?? {};
	for (const day of weekDays) {
		const was = hoursBefore[day];
		const now = hoursAfter[day];
		if (was?.open === now?.open && was?.close === now?.close) continue;
		kinds.add("hours");
		changes.push(
			`${dayLabels[day]} → ${now ? `${now.open}–${now.close}` : "Closed"}`,
		);
	}
	for (const key of Object.keys(textFields) as TextField[]) {
		if ((before[key] ?? "") === (after[key] ?? "")) continue;
		kinds.add(
			["email", "phone", "address"].includes(key) ? "contact" : "details",
		);
		changes.push(
			key === "description"
				? "About your business → updated"
				: `${textFields[key]} → ${after[key] || "none"}`,
		);
	}
	const price = (value: number) => formatPrice(value, after.currency);
	for (const service of after.services) {
		const old = before.services.find((item) => same(item.name, service.name));
		if (!old) {
			kinds.add("services");
			changes.push(
				`New service: ${service.name} (${[price(service.price), service.duration].filter(Boolean).join(" · ")})`,
			);
			continue;
		}
		const fields: string[] = [];
		if (old.price !== service.price)
			fields.push(`price ${price(old.price)} → ${price(service.price)}`);
		if (old.duration !== service.duration)
			fields.push(
				`length ${old.duration || "none"} → ${service.duration || "none"}`,
			);
		if ((old.description ?? "") !== (service.description ?? ""))
			fields.push("description updated");
		if ((old.bookingLabel ?? "") !== (service.bookingLabel ?? ""))
			fields.push(`booking text → ${service.bookingLabel || "the usual text"}`);
		if (fields.length) {
			kinds.add("services");
			changes.push(`${service.name}: ${fields.join(", ")}`);
		}
	}
	for (const service of before.services)
		if (!after.services.some((item) => same(item.name, service.name))) {
			kinds.add("services");
			changes.push(`Remove service: ${service.name}`);
		}
	for (const person of after.team) {
		const old = before.team.find((item) => same(item.name, person.name));
		if (!old) {
			kinds.add("team");
			changes.push(
				`New team member: ${person.name}${person.role ? ` (${person.role})` : ""}`,
			);
			continue;
		}
		const fields: string[] = [];
		if (old.role !== person.role)
			fields.push(`role → ${person.role || "none"}`);
		if ((old.bio ?? "") !== (person.bio ?? "")) fields.push("bio updated");
		if (fields.length) {
			kinds.add("team");
			changes.push(`${person.name}: ${fields.join(", ")}`);
		}
	}
	for (const person of before.team)
		if (!after.team.some((item) => same(item.name, person.name))) {
			kinds.add("team");
			changes.push(`Remove team member: ${person.name}`);
		}
	const titles: Record<string, string> = {
		hours: "Update your opening hours",
		services: "Update your services",
		team: "Update your team",
		contact: "Update your contact details",
	};
	const [only] = kinds;
	return {
		title: (kinds.size === 1 && titles[only]) || "Update your business details",
		// Every change is listed: the owner confirms exactly what is saved.
		changes,
	};
}
