// Studio-owned integration. Generated pages may style and place it, not replace it.
const menu = document.querySelector(".menu-toggle");
menu?.addEventListener("click", () => {
	const nav = document.querySelector("nav");
	const open = nav.classList.toggle("open");
	menu.setAttribute("aria-expanded", String(open));
});
fetch("/site-kit/data")
	.then((r) => {
		if (!r.ok) throw new Error("Business data unavailable");
		return r.json();
	})
	.then((data) => {
		for (const element of document.querySelectorAll("[data-business]"))
			element.textContent = data[element.dataset.business] || "";
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
					const p = document.createElement("p");
					p.textContent =
						"Thoughtful, personalised care. A little time for yourself.";
					const bottom = document.createElement("div");
					bottom.className = "service-bottom";
					const cost = document.createElement("span");
					cost.textContent = `€${service.price} · ${service.duration}`;
					const a = document.createElement("a");
					a.href = `/book?service=${encodeURIComponent(service.name)}`;
					a.textContent = "Book a session ↗";
					bottom.append(cost, a);
					card.append(number, h, p, bottom);
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
