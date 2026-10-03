// Studio-owned integration. Generated pages may style and place it, not replace it.
const menu = document.querySelector(".menu-toggle");
menu?.addEventListener("click", () => {
	const nav = document.querySelector("nav");
	const open = nav.classList.toggle("open");
	menu.setAttribute("aria-expanded", String(open));
});
function formatPrice(value, currency) {
	const code = currency || "EUR";
	try {
		const locale = document.documentElement.lang || undefined;
		const format = new Intl.NumberFormat(locale, {
			style: "currency",
			currency: code,
		});
		// Whole prices drop ".00" in two-decimal currencies; others keep their
		// standard precision (for example KWD 28.000).
		return Number.isInteger(value) &&
			format.resolvedOptions().maximumFractionDigits === 2
			? new Intl.NumberFormat(locale, {
					style: "currency",
					currency: code,
					minimumFractionDigits: 0,
					maximumFractionDigits: 0,
				}).format(value)
			: format.format(value);
	} catch {
		return `${code} ${value}`;
	}
}
function unbroken(text) {
	const span = document.createElement("span");
	span.style.whiteSpace = "nowrap";
	span.textContent = text;
	return span;
}
// Lines may wrap between "Mon–Fri 07:00–20:00" segments, never inside one.
function renderHours(element, hours) {
	const nodes = [];
	for (const part of hours.split(/(\s*[·•|;,\n]\s*)/)) {
		if (!part) continue;
		if (/^\s*[·•|;,\n]\s*$/.test(part) || part.length > 32) {
			for (const piece of part.split(
				/(\d{1,2}[:.]\d{2}\s*[–—-]\s*\d{1,2}[:.]\d{2})/,
			)) {
				if (!piece) continue;
				nodes.push(
					/^\d{1,2}[:.]\d{2}\s*[–—-]\s*\d{1,2}[:.]\d{2}$/.test(piece)
						? unbroken(piece)
						: document.createTextNode(piece),
				);
			}
		} else nodes.push(unbroken(part));
	}
	element.replaceChildren(...nodes);
}
// Phone numbers and email addresses are tappable on phones.
function contactHref(kind, value) {
	if (kind === "phone") {
		const number = value.replace(/[^\d+]/g, "").replace(/(?!^)\+/g, "");
		return number.replace(/\D/g, "").length >= 5 ? `tel:${number}` : "";
	}
	if (kind === "email") {
		const email = value.trim();
		return /^[^\s@<>"'()]+@[^\s@<>"'()]+\.[^\s@<>"'()]+$/.test(email)
			? `mailto:${email}`
			: "";
	}
	return "";
}
function renderContact(element, kind, value) {
	const href = contactHref(kind, value);
	if (!href) {
		element.textContent = value;
		return;
	}
	if (element.tagName === "A") {
		element.href = href;
		element.textContent = value;
		return;
	}
	const link = document.createElement("a");
	link.href = href;
	link.textContent = value;
	element.replaceChildren(link);
}
fetch("/site-kit/data")
	.then((r) => {
		if (!r.ok) throw new Error("Business data unavailable");
		return r.json();
	})
	.then((data) => {
		for (const element of document.querySelectorAll("[data-business]")) {
			const kind = element.dataset.business;
			const value = data[kind] || "";
			if (kind === "hours" && typeof value === "string")
				renderHours(element, value);
			else if (
				(kind === "phone" || kind === "email") &&
				typeof value === "string"
			)
				renderContact(element, kind, value);
			else element.textContent = value;
		}
		for (const element of document.querySelectorAll("[data-services]")) {
			element.replaceChildren(
				...data.services.map((service, index) => {
					const card = document.createElement("article");
					card.className = "service";
					const number = document.createElement("span");
					number.className = "number";
					number.textContent = `0${index + 1}`;
					const h = document.createElement("h3");
					h.textContent = service.name;
					card.append(number, h);
					const description =
						typeof service.description === "string"
							? service.description.trim()
							: "";
					if (description) {
						const p = document.createElement("p");
						p.textContent = description;
						card.append(p);
					}
					const bottom = document.createElement("div");
					bottom.className = "service-bottom";
					const cost = document.createElement("span");
					cost.textContent = [
						formatPrice(service.price, data.currency),
						service.duration,
					]
						.filter(Boolean)
						.join(" · ");
					const a = document.createElement("a");
					a.href = `/book?service=${encodeURIComponent(service.name)}`;
					// A service's own booking text wins over the business default.
					a.textContent =
						(typeof service.bookingLabel === "string" &&
							service.bookingLabel.trim()) ||
						(typeof data.bookingLabel === "string" &&
							data.bookingLabel.trim()) ||
						"Book";
					bottom.append(cost, a);
					card.append(bottom);
					return card;
				}),
			);
			// Lets page styles lay out any number of cards without empty gaps.
			element.dataset.count = String(data.services.length);
		}
		for (const element of document.querySelectorAll("[data-team]")) {
			element.dataset.count = String((data.team || []).length);
			element.replaceChildren(
				...(data.team || []).map((person) => {
					const card = document.createElement("article");
					card.className = "team-member";
					const h = document.createElement("h3");
					h.textContent = person.name;
					card.append(h);
					if (person.role) {
						const p = document.createElement("p");
						p.textContent = person.role;
						card.append(p);
					}
					const bio = typeof person.bio === "string" ? person.bio.trim() : "";
					if (bio) {
						const p = document.createElement("p");
						p.className = "bio";
						p.textContent = bio;
						card.append(p);
					}
					return card;
				}),
			);
		}
	})
	.catch(() => {
		for (const el of document.querySelectorAll("[data-services]"))
			el.textContent = "We could not load our services. Please try again.";
	});
for (const form of document.querySelectorAll("[data-lead-form]")) {
	form.addEventListener("submit", async (event) => {
		event.preventDefault();
		if (!form.reportValidity()) return;
		const button = form.querySelector("button[type=submit]");
		if (button.disabled) return;
		button.disabled = true;
		try {
			const response = await fetch("/site-kit/leads", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(Object.fromEntries(new FormData(form))),
			});
			if (!response.ok) throw new Error("Please try again.");
			form.querySelector("[role=status]").textContent =
				"Thanks — your test enquiry was received. No message was sent.";
		} catch {
			form.querySelector("[role=status]").textContent =
				"Something went wrong. Please try again.";
			button.disabled = false;
		}
	});
}
