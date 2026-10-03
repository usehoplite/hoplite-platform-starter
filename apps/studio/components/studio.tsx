"use client";
import { Menu } from "@base-ui/react/menu";
import {
	ArrowUp,
	ArrowUpRight,
	Building2,
	Check,
	ChevronDown,
	ChevronRight,
	CircleHelp,
	Clock3,
	Download,
	ExternalLink,
	Globe,
	History,
	Loader2,
	MessageSquare,
	Monitor,
	MoreHorizontal,
	PanelLeftClose,
	PanelLeftOpen,
	PanelsTopLeft,
	Plus,
	RotateCcw,
	ShieldCheck,
	Smartphone,
	Sparkles,
	Tablet,
	Trash2,
	UserRound,
	X,
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
// Uses Hoplite UI primitives and surface recipes. See NOTICE.md for attribution.
import {
	type FormEvent,
	Suspense,
	useId,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import useSWR from "swr";
import { BrandPanel } from "@/components/brand-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { rebuildable } from "@/lib/customer-copy";
import { dayLabels, parseHours, type WeeklyHours, weekDays } from "@/lib/hours";
import { type Inline, markdown } from "@/lib/markdown";
import { progressLabel } from "@/lib/progress";
import {
	checkSummary,
	ownerVersions,
	releaseChanges,
	versionLine,
} from "@/lib/release-summary";
import { routeLabel } from "@/lib/site-pages";
import type {
	Business,
	JsonValue,
	Site,
	StudioState,
	Version,
} from "@/lib/types";
import { cn } from "@/lib/utils";

async function request<T>(
	path: string,
	body?: JsonValue,
	method?: "DELETE",
): Promise<T> {
	const response = await fetch(
		path,
		body === undefined && !method
			? undefined
			: {
					method: method ?? "POST",
					headers: {
						"Content-Type": "application/json",
						"X-Studio-Action": "studio",
					},
					body: JSON.stringify(body),
				},
	);
	// The access gate signed this browser out; show the sign-in page.
	if (response.status === 401) window.location.assign("/login");
	const result = await response.json();
	if (!response.ok)
		throw new Error(result.error || "The request failed. Please try again.");
	return result as T;
}
function InlineText({ parts }: { parts: Inline[] }) {
	return parts.map((part, index) => {
		const key = `${part.type}-${index}`;
		if (part.type === "text") return part.text;
		if (part.type === "code") return <code key={key}>{part.text}</code>;
		if (part.type === "link")
			return (
				<a key={key} href={part.href} target="_blank" rel="noopener noreferrer">
					<InlineText parts={part.children} />
				</a>
			);
		const Tag = part.type;
		return (
			<Tag key={key}>
				<InlineText parts={part.children} />
			</Tag>
		);
	});
}
/** Agent replies as formatted text; see lib/markdown.ts for the safe subset. */
function Markdown({ text }: { text: string }) {
	return markdown(text).map((block, index) => {
		const key = `${block.type}-${index}`;
		if (block.type === "paragraph")
			return (
				<p key={key}>
					<InlineText parts={block.content} />
				</p>
			);
		const List = block.ordered ? "ol" : "ul";
		// Keys come from item content plus its occurrence, so repeats stay unique.
		const seen = new Map<string, number>();
		return (
			<List key={key}>
				{block.items.map((item) => {
					const text = JSON.stringify(item);
					const occurrence = (seen.get(text) ?? 0) + 1;
					seen.set(text, occurrence);
					return (
						<li key={`${text}#${occurrence}`}>
							<InlineText parts={item} />
						</li>
					);
				})}
			</List>
		);
	});
}
function Mark({ small = false }: { small?: boolean }) {
	return (
		<img
			className={cn("brand-mark", small && "small")}
			src="/studio-logo.svg"
			alt=""
			width={small ? 23 : 29}
			height={small ? 23 : 29}
		/>
	);
}
function IconButton({
	label,
	children,
	onClick,
	active,
	disabled,
}: {
	label: string;
	children: React.ReactNode;
	onClick: () => void;
	active?: boolean;
	disabled?: boolean;
}) {
	return (
		<Button
			type="button"
			variant={active ? "secondary" : "ghost"}
			size="icon-sm"
			title={label}
			aria-label={label}
			onClick={onClick}
			disabled={disabled}
		>
			{children}
		</Button>
	);
}
let lastReturn = 0;
/** The owner opened the studio, or came back to its tab: real activity. */
function ownerReturned() {
	if (
		document.visibilityState !== "visible" ||
		Date.now() - lastReturn < 30_000
	)
		return;
	lastReturn = Date.now();
	void request("/api/site/activity", { wake: true }).catch(() => undefined);
}
let lastInteraction = Date.now();
function ownerInteracted() {
	lastInteraction = Date.now();
}
/** Keeps a live preview warm while the owner has the studio open. */
const keepWarmMs = 5 * 60_000;
/** A studio left open this long without interaction lets its preview idle. */
const keepWarmIdleMs = 60 * 60_000;
function keepPreviewWarm() {
	if (
		document.visibilityState !== "visible" ||
		Date.now() - lastInteraction > keepWarmIdleMs
	)
		return;
	// Renews the idle deadline of a running preview; never wakes a paused one.
	void request("/api/site/activity", { keepWarm: true }).catch(() => undefined);
}
/**
 * Wakes a paused preview when the owner opens the website workspace or
 * returns to the studio tab (visibility or focus), and keeps a running one
 * warm while they have the studio open. Automatic reloads and background
 * polling never wake it, and a studio left untouched for an hour stops
 * renewing, so an idle preview still expires.
 */
function watchOwnerReturn(element: HTMLDivElement | null) {
	if (!element) return;
	ownerReturned();
	ownerInteracted();
	document.addEventListener("visibilitychange", ownerReturned);
	window.addEventListener("focus", ownerReturned);
	window.addEventListener("pointerdown", ownerInteracted);
	window.addEventListener("keydown", ownerInteracted);
	const warm = window.setInterval(keepPreviewWarm, keepWarmMs);
	return () => {
		document.removeEventListener("visibilitychange", ownerReturned);
		window.removeEventListener("focus", ownerReturned);
		window.removeEventListener("pointerdown", ownerInteracted);
		window.removeEventListener("keydown", ownerInteracted);
		window.clearInterval(warm);
	};
}
/** Within this distance of the bottom, new messages keep the chat pinned. */
const followThreshold = 120;
function pinnedToLatest(container: HTMLElement) {
	return (
		container.scrollHeight - container.scrollTop - container.clientHeight <
		followThreshold
	);
}
/** Scrolls the chat to its newest message and keeps following it. */
function jumpToLatest(container: HTMLElement | null) {
	if (!container) return;
	container.dataset.following = "true";
	container.scrollTop = container.scrollHeight;
}
/**
 * Follows the newest chat message on load, on send, on progress updates and
 * on replies — unless the owner has scrolled up to read, in which case they
 * stay where they are until they come back near the bottom. The size
 * observer also catches the mobile Chat tab becoming visible.
 */
function followLatest(container: HTMLDivElement | null) {
	if (!container) return;
	const follow = () => {
		if (container.dataset.following !== "false")
			container.scrollTop = container.scrollHeight;
	};
	const scrolled = () => {
		container.dataset.following = String(pinnedToLatest(container));
	};
	container.addEventListener("scroll", scrolled, { passive: true });
	const mutations = new MutationObserver(follow);
	mutations.observe(container, {
		childList: true,
		subtree: true,
		characterData: true,
	});
	const resize = new ResizeObserver(follow);
	resize.observe(container);
	jumpToLatest(container);
	return () => {
		container.removeEventListener("scroll", scrolled);
		mutations.disconnect();
		resize.disconnect();
	};
}
function Composer({
	busy,
	onSend,
	businessName,
	large = false,
	initial = "",
}: {
	busy: boolean;
	onSend: (value: string) => Promise<void>;
	businessName: string;
	large?: boolean;
	initial?: string;
}) {
	const [value, setValue] = useState(initial);
	const [sending, setSending] = useState(false);
	async function send(event?: FormEvent) {
		event?.preventDefault();
		// While a change runs, a new request is queued rather than ignored.
		if ((!large && !value.trim()) || sending) return;
		setSending(true);
		try {
			// An empty first request is allowed: the website is written from the
			// saved business details, and the chat shows a neutral status line.
			await onSend(value.trim());
			setValue("");
		} catch {
			/* The parent renders the actionable API error. */
		} finally {
			setSending(false);
		}
	}
	return (
		<form className={cn("composer", large && "composer-large")} onSubmit={send}>
			<Textarea
				aria-label={
					large ? "Describe your website" : "Describe your website changes"
				}
				placeholder={
					large
						? "What would you like your website to help with? We’ll take care of the design."
						: busy
							? "Anything else? We’ll start it after this change…"
							: "Tell us what you’d like to change…"
				}
				value={value}
				onChange={(e) => setValue(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
						e.preventDefault();
						void send();
					}
				}}
				rows={large ? 3 : 3}
			/>
			<div className="composer-footer">
				<span className="composer-context">
					<Building2 />
					{businessName || "Your business"}
				</span>
				<Button
					type="submit"
					variant="action"
					size={large ? "sm" : "icon-sm"}
					aria-label={large ? "Create my website" : "Send message"}
					disabled={(!large && !value.trim()) || sending}
				>
					{sending ? <Loader2 className="spin" /> : <ArrowUp />}
					{large && "Create my website"}
				</Button>
			</div>
		</form>
	);
}
function currencySymbol(currency = "EUR") {
	try {
		return (
			new Intl.NumberFormat("en-IE", { style: "currency", currency })
				.formatToParts(0)
				.find((part) => part.type === "currency")?.value ?? currency
		);
	} catch {
		// A partly typed code is shown as typed until it is valid.
		return currency;
	}
}
let rows = 0;
function rowKey() {
	rows += 1;
	return `row-${rows}`;
}
function BusinessPanel({
	value,
	onSave,
	onboarding = false,
	onDraft,
	serviceCardFields = true,
	teamBios = true,
	serviceBookingLabels = true,
}: {
	value: Business;
	onSave: (body: Business) => Promise<void>;
	onboarding?: boolean;
	/** False for websites saved before Site Kit read these fields. */
	serviceCardFields?: boolean;
	/** False for websites whose Site Kit predates team bios. */
	teamBios?: boolean;
	/** False for websites whose Site Kit predates per-service booking text. */
	serviceBookingLabels?: boolean;
	/** Onboarding saves unsaved edits before creating the website. */
	onDraft?: (draft: Business) => void;
}) {
	const formId = useId();
	// Saved hours in the usual "Mon–Fri 07:00–20:00" form open day by day.
	const [draft, setDraftState] = useState<Business>(() => {
		const weeklyHours = value.weeklyHours ?? parseHours(value.hours);
		return weeklyHours ? { ...value, weeklyHours } : value;
	});
	// Stable row identities while names are edited, added and removed.
	const [serviceKeys, setServiceKeys] = useState(() =>
		value.services.map(() => rowKey()),
	);
	const [teamKeys, setTeamKeys] = useState(() =>
		value.team.map(() => rowKey()),
	);
	function setDraft(next: Business) {
		setDraftState(next);
		onDraft?.(next);
	}
	function setService(index: number, patch: Partial<Business["services"][0]>) {
		setDraft({
			...draft,
			services: draft.services.map((service, i) =>
				i === index ? { ...service, ...patch } : service,
			),
		});
	}
	function setPerson(index: number, patch: Partial<Business["team"][0]>) {
		setDraft({
			...draft,
			team: draft.team.map((person, i) =>
				i === index ? { ...person, ...patch } : person,
			),
		});
	}
	const [saving, setSaving] = useState(false);
	const [saved, setSaved] = useState(false);
	return (
		<form
			className="business-form"
			onChange={() => setSaved(false)}
			onSubmit={async (e) => {
				e.preventDefault();
				setSaving(true);
				try {
					await onSave(draft);
					setSaved(true);
				} catch {
					setSaved(false);
				} finally {
					setSaving(false);
				}
			}}
		>
			{onboarding ? (
				<div className="panel-intro">
					<span className="section-kicker">STEP 1 · YOUR BUSINESS</span>
					<h2>Check your business details</h2>
					<p>
						Your website is written from these details. You can change them at
						any time.
					</p>
				</div>
			) : (
				<div className="panel-intro">
					<span className="section-kicker">YOUR BUSINESS</span>
					<h1>Business details</h1>
					<p>Manage the business information your website uses.</p>
				</div>
			)}
			<label htmlFor={`${formId}-name`}>
				Business name
				<Input
					id={`${formId}-name`}
					value={draft.name}
					onChange={(e) => {
						setSaved(false);
						setDraft({ ...draft, name: e.target.value });
					}}
					required
					maxLength={200}
				/>
			</label>
			<label htmlFor={`${formId}-category`}>
				Type of business
				<Input
					id={`${formId}-category`}
					value={draft.category}
					placeholder="For example: hair salon, physiotherapy clinic"
					maxLength={100}
					onChange={(e) => setDraft({ ...draft, category: e.target.value })}
				/>
			</label>
			<label htmlFor={`${formId}-description`}>
				About your business
				<Textarea
					id={`${formId}-description`}
					value={draft.description}
					placeholder="A few sentences about what you do and who you help"
					maxLength={1000}
					rows={3}
					onChange={(e) => setDraft({ ...draft, description: e.target.value })}
				/>
			</label>
			<label htmlFor={`${formId}-address`}>
				Location
				<Input
					id={`${formId}-address`}
					value={draft.address}
					onChange={(e) => setDraft({ ...draft, address: e.target.value })}
					required
				/>
			</label>
			<div className="field-row">
				<label htmlFor={`${formId}-email`}>
					Email
					<Input
						type="email"
						id={`${formId}-email`}
						value={draft.email}
						onChange={(e) => setDraft({ ...draft, email: e.target.value })}
						required
					/>
				</label>
				<label htmlFor={`${formId}-phone`}>
					Phone
					<Input
						id={`${formId}-phone`}
						value={draft.phone}
						onChange={(e) => setDraft({ ...draft, phone: e.target.value })}
					/>
				</label>
			</div>
			{draft.weeklyHours ? (
				<fieldset className="hours-editor">
					<legend>Opening hours</legend>
					{weekDays.map((day) => {
						const range = draft.weeklyHours?.[day];
						const setDay = (next: WeeklyHours[typeof day]) =>
							setDraft({
								...draft,
								weeklyHours: { ...draft.weeklyHours, [day]: next },
							});
						return (
							<div className="hours-row" key={day}>
								<label className="hours-day">
									<input
										type="checkbox"
										checked={Boolean(range)}
										onChange={(e) =>
											setDay(
												e.target.checked
													? { open: "09:00", close: "17:00" }
													: undefined,
											)
										}
									/>
									{dayLabels[day]}
								</label>
								{range ? (
									<span className="hours-times">
										<Input
											type="time"
											aria-label={`${dayLabels[day]} opening time`}
											value={range.open}
											required
											onChange={(e) =>
												setDay({ ...range, open: e.target.value })
											}
										/>
										<span aria-hidden="true">–</span>
										<Input
											type="time"
											aria-label={`${dayLabels[day]} closing time`}
											value={range.close}
											required
											onChange={(e) =>
												setDay({ ...range, close: e.target.value })
											}
										/>
									</span>
								) : (
									<span className="hours-closed">Closed</span>
								)}
							</div>
						);
					})}
				</fieldset>
			) : (
				<div className="hours-editor">
					<label htmlFor={`${formId}-hours`}>
						Opening hours
						<Input
							id={`${formId}-hours`}
							value={draft.hours}
							onChange={(e) => setDraft({ ...draft, hours: e.target.value })}
						/>
					</label>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className="list-add"
						onClick={() =>
							setDraft({
								...draft,
								weeklyHours: Object.fromEntries(
									weekDays
										.slice(0, 5)
										.map((day) => [day, { open: "09:00", close: "17:00" }]),
								),
							})
						}
					>
						<Clock3 />
						Set hours for each day
					</Button>
				</div>
			)}
			{serviceCardFields && (
				<div className="field-row">
					<label htmlFor={`${formId}-currency`}>
						Currency
						<Input
							id={`${formId}-currency`}
							value={draft.currency ?? "EUR"}
							maxLength={3}
							pattern="[A-Za-z]{3}"
							title="A three-letter currency code, such as EUR, GBP or USD"
							autoCapitalize="characters"
							onChange={(e) =>
								setDraft({ ...draft, currency: e.target.value.toUpperCase() })
							}
							required
						/>
					</label>
					<label htmlFor={`${formId}-booking-label`}>
						Booking button text
						<Input
							id={`${formId}-booking-label`}
							value={draft.bookingLabel ?? ""}
							placeholder="Book"
							maxLength={40}
							onChange={(e) =>
								setDraft({ ...draft, bookingLabel: e.target.value })
							}
						/>
					</label>
				</div>
			)}
			<h3>Services & pricing</h3>
			<div className="service-list">
				{draft.services.map((service, i) => {
					const label = service.name.trim() || `Service ${i + 1}`;
					return (
						<div className="service-row" key={serviceKeys[i]}>
							<span className="service-icon">
								<Sparkles />
							</span>
							<div>
								<Input
									aria-label={`Service ${i + 1} name`}
									placeholder="Service name"
									maxLength={100}
									required
									value={service.name}
									onChange={(e) => setService(i, { name: e.target.value })}
								/>
								<Input
									aria-label={`${label} length`}
									placeholder="Length, for example 50 min (optional)"
									maxLength={40}
									value={service.duration}
									onChange={(e) => setService(i, { duration: e.target.value })}
								/>
								{serviceCardFields && (
									<Input
										aria-label={`${label} description`}
										placeholder="Short description (optional)"
										maxLength={300}
										value={service.description ?? ""}
										onChange={(e) =>
											setService(i, { description: e.target.value })
										}
									/>
								)}
								{serviceBookingLabels && (
									<Input
										aria-label={`${label} booking button text`}
										placeholder={`Booking button text (optional, otherwise “${draft.bookingLabel?.trim() || "Book"}”)`}
										maxLength={40}
										value={service.bookingLabel ?? ""}
										onChange={(e) =>
											setService(i, { bookingLabel: e.target.value })
										}
									/>
								)}
							</div>
							<label
								className="price-input"
								htmlFor={`${formId}-service-price-${i}`}
							>
								<span>{currencySymbol(draft.currency)}</span>
								<Input
									id={`${formId}-service-price-${i}`}
									aria-label={`${label} price`}
									type="number"
									min="0"
									max="100000"
									step="0.01"
									required
									value={service.price}
									onChange={(e) =>
										setService(i, { price: Number(e.target.value) })
									}
								/>
							</label>
							<IconButton
								label={`Remove ${label}`}
								disabled={draft.services.length === 1}
								onClick={() => {
									setServiceKeys(serviceKeys.filter((_, j) => j !== i));
									setDraft({
										...draft,
										services: draft.services.filter((_, j) => j !== i),
									});
								}}
							>
								<Trash2 />
							</IconButton>
						</div>
					);
				})}
			</div>
			<Button
				type="button"
				variant="ghost"
				size="sm"
				className="list-add"
				disabled={draft.services.length >= 50}
				onClick={() => {
					setServiceKeys([...serviceKeys, rowKey()]);
					setDraft({
						...draft,
						services: [...draft.services, { name: "", price: 0, duration: "" }],
					});
				}}
			>
				<Plus />
				Add service
			</Button>
			<h3>Team</h3>
			{draft.team.length > 0 && (
				<div className="service-list">
					{draft.team.map((person, i) => {
						const label = person.name.trim() || `Team member ${i + 1}`;
						return (
							<div className="service-row" key={teamKeys[i]}>
								<span className="service-icon">
									<UserRound />
								</span>
								<div>
									<Input
										aria-label={`Team member ${i + 1} name`}
										placeholder="Name"
										maxLength={100}
										required
										value={person.name}
										onChange={(e) => setPerson(i, { name: e.target.value })}
									/>
									<Input
										aria-label={`${label} role`}
										placeholder="Role, for example physiotherapist"
										maxLength={100}
										value={person.role}
										onChange={(e) => setPerson(i, { role: e.target.value })}
									/>
									{teamBios && (
										<Textarea
											aria-label={`${label} bio`}
											placeholder="Short bio, a sentence or two (optional)"
											maxLength={300}
											rows={3}
											value={person.bio ?? ""}
											onChange={(e) => setPerson(i, { bio: e.target.value })}
										/>
									)}
								</div>
								<IconButton
									label={`Remove ${label}`}
									onClick={() => {
										setTeamKeys(teamKeys.filter((_, j) => j !== i));
										setDraft({
											...draft,
											team: draft.team.filter((_, j) => j !== i),
										});
									}}
								>
									<Trash2 />
								</IconButton>
							</div>
						);
					})}
				</div>
			)}
			<Button
				type="button"
				variant="ghost"
				size="sm"
				className="list-add"
				disabled={draft.team.length >= 30}
				onClick={() => {
					setTeamKeys([...teamKeys, rowKey()]);
					setDraft({
						...draft,
						team: [...draft.team, { name: "", role: "" }],
					});
				}}
			>
				<Plus />
				Add team member
			</Button>
			<div className="kit-note">
				<ShieldCheck />
				<span>
					Booking, contact forms, and business data are managed by Site Studio.
				</span>
			</div>
			<Button type="submit" disabled={saving}>
				{saving ? <Loader2 className="spin" /> : saved ? <Check /> : null}
				{saved ? "Saved" : "Save business details"}
			</Button>
		</form>
	);
}
function VersionRow({
	version,
	site,
	onSelect,
	onPublish,
}: {
	version: Version;
	site: Site;
	onSelect: () => void;
	onPublish: () => void;
}) {
	const published = site.publishedVersionId === version.id;
	const ready = version.qa?.status === "passed" && !version.failure;
	const line = versionLine(site, version);
	return (
		<div className="version-row">
			<div className="version-symbol">
				<History />
			</div>
			<div className="version-copy">
				<strong>{version.label}</strong>
				<time dateTime={version.createdAt}>
					{viewerTime(version.createdAt)}
				</time>
				<span className={cn("status-badge", ready && "success")}>
					{published
						? "Published"
						: version.failure?.advisory
							? "Improved automatically"
							: version.failure || version.qa?.status === "failed"
								? "Not ready"
								: ready
									? "Ready to publish"
									: ["building", "checking"].includes(site.phase) &&
											site.buildVersionId === version.id
										? "Getting ready"
										: "Draft"}
				</span>
				{line && <p className="version-summary">{line}</p>}
			</div>
			<div className="version-actions">
				{(version.buildId || site.versions.at(-1)?.id === version.id) && (
					<Button size="sm" variant="ghost" onClick={onSelect}>
						Preview
					</Button>
				)}
				{ready && !published && (
					<Button size="sm" variant="outline" onClick={onPublish}>
						Review release
					</Button>
				)}
			</div>
		</div>
	);
}
/** A date and time in the viewer's own language and time zone. */
function viewerTime(iso: string) {
	return new Date(iso).toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}
function initials(name: string) {
	return (
		name
			.split(/\s+/)
			.filter((word) => /\p{L}|\p{N}/u.test(word))
			.slice(0, 2)
			.map((word) => [...word][0]?.toUpperCase())
			.join("") || "B"
	);
}
function showDialog(element: HTMLDialogElement | null) {
	if (element && !element.open) element.showModal();
}
function subscribeDesktop(listener: () => void) {
	const query = window.matchMedia("(min-width: 901px)");
	query.addEventListener("change", listener);
	return () => query.removeEventListener("change", listener);
}
function desktopSnapshot() {
	return window.matchMedia("(min-width: 901px)").matches;
}
function serverDesktopSnapshot() {
	return true;
}
export function Studio({
	selectedConversationId = null,
}: {
	selectedConversationId?: string | null;
}) {
	return (
		<Suspense
			fallback={<output className="studio-shell" aria-label="Loading studio" />}
		>
			<StudioContent selectedConversationId={selectedConversationId} />
		</Suspense>
	);
}
function StudioContent({
	selectedConversationId,
}: {
	selectedConversationId: string | null;
}) {
	const router = useRouter();
	const businessPage = usePathname() === "/business";
	const onboardingTitleId = useId();
	const {
		data,
		error: loadError,
		mutate,
	} = useSWR<StudioState>("/api/state", request, {
		refreshInterval: 2000,
		revalidateOnFocus: true,
	});
	const desktop = useSyncExternalStore(
		subscribeDesktop,
		desktopSnapshot,
		serverDesktopSnapshot,
	);
	const [sidebarOverride, setSidebar] = useState<boolean | null>(null);
	const sidebar = sidebarOverride ?? desktop;
	const [tab, setTab] = useState<"preview" | "history">("preview");
	const [device, setDevice] = useState<"desktop" | "tablet" | "mobile">(
		"desktop",
	);
	const [path, setPath] = useState("/");
	const [revision, setRevision] = useState(0);
	const [error, setError] = useState("");
	const [deleteError, setDeleteError] = useState("");
	const [deleting, setDeleting] = useState<string | null>(null);
	const [releaseReview, setReleaseReview] = useState<{
		siteId: string;
		versionId?: string;
		id: string;
		expectedVersionId: string | null;
		action: "publish" | "rollback";
	} | null>(null);
	const [publishing, setPublishing] = useState(false);
	const [help, setHelp] = useState(false);
	const [mobilePane, setMobilePane] = useState<"chat" | "preview">("preview");
	const [suggestion, setSuggestion] = useState("");
	const [previewVersion, setPreviewVersion] = useState<string | undefined>();
	const [loadedFrame, setLoadedFrame] = useState<string | null>(null);
	// Each organisation has one website; conversations are changes to it.
	const site = data?.site ?? undefined;
	const conversations = site?.conversations ?? [];
	const conversation =
		selectedConversationId === "new"
			? undefined
			: (conversations.find((item) => item.id === selectedConversationId) ??
				conversations.find((item) => item.id === site?.conversationId) ??
				conversations[0]);
	const workingConversationId = site?.generations?.find(
		(generation) => generation.id === site.generationId,
	)?.conversationId;
	// A change's error and retry belong to the conversation that asked for it,
	// or to every conversation when that one was deleted.
	const ownsChange =
		workingConversationId === conversation?.id ||
		!conversations.some((item) => item.id === workingConversationId);
	// "Try again" clears the old failure at once, not on the next poll.
	const [retrying, setRetrying] = useState(false);
	const changeError = ownsChange && !retrying ? site?.error : undefined;
	const lastActivity = useRef<{ siteId: string; at: number } | null>(null);
	const onboardingDraft = useRef<Business | null>(null);
	function editorActivity() {
		if (!site?.threadId) return;
		const previous = lastActivity.current;
		if (previous?.siteId === site.id && Date.now() - previous.at < 30_000)
			return;
		lastActivity.current = { siteId: site.id, at: Date.now() };
		// Real activity also wakes a paused preview (the server throttles it).
		void request("/api/site/activity", { wake: true }).catch(() => {
			void mutate();
		});
	}
	const busy =
		site !== undefined &&
		["generating", "building", "checking"].includes(site.phase);
	// One version per change: an automatic repair replaces its candidate.
	const shownVersions = site ? ownerVersions(site) : [];
	const latest = shownVersions.at(-1);
	const versionLabels = new Map(
		site?.versions.map((version) => [version.id, version.label] as const) ?? [],
	);
	const publishOpen =
		releaseReview !== null && releaseReview.siteId === site?.id;
	const release = site?.versions.find(
		(version) => version.id === releaseReview?.versionId,
	);
	const publishable = release?.qa?.status === "passed" && !release.failure;
	// Accurate dialog state: still being prepared, failed, or never finished.
	const releasePreparing =
		busy && release !== undefined && release.id === latest?.id;
	const releaseFailed =
		!publishable &&
		!releasePreparing &&
		(Boolean(release?.failure) || release?.qa?.status === "failed");
	const releaseRetry = releaseFailed && rebuildable(release?.failure);
	const checkedInBrowsers = publishable && release?.qa?.browserChecks !== false;
	const businessName = data?.business.name || "Your business";
	const buildingDraft =
		site !== undefined && ["building", "checking"].includes(site.phase);
	const retryLabel = "Try again";
	async function retryChange() {
		setRetrying(true);
		try {
			await handleOperation(request("/api/site/retry", {}));
		} finally {
			setRetrying(false);
		}
	}
	const proposal =
		site?.businessProposal &&
		(site.businessProposal.conversationId === conversation?.id ||
			!conversations.some(
				(item) => item.id === site.businessProposal?.conversationId,
			))
			? site.businessProposal
			: undefined;
	const [proposalBusy, setProposalBusy] = useState(false);
	const [proposalSaved, setProposalSaved] = useState("");
	async function answerProposal(action: "apply" | "dismiss") {
		if (!proposal || proposalBusy) return;
		setProposalBusy(true);
		setError("");
		try {
			await request("/api/site/business-proposal", {
				id: proposal.id,
				action,
			});
			if (action === "apply") {
				setProposalSaved(
					"Saved. Your website now shows the new details; nothing needs publishing.",
				);
				// Site Kit reads the saved details live: reload the preview.
				setRevision((v) => v + 1);
			}
			await mutate();
		} catch (e) {
			setError(e instanceof Error ? e.message : "That didn’t work.");
			await mutate();
		} finally {
			setProposalBusy(false);
		}
	}
	// The agent has sent nothing for a long time: offer a plain way out.
	const stalled = ownsChange && site?.stall === "stalled";
	async function stopChange() {
		await handleOperation(request("/api/site/stop", {}));
	}
	async function cancelQueued() {
		await handleOperation(request("/api/site/unqueue", {}));
	}
	const queued =
		site?.queuedChange && site.queuedChange.conversationId === conversation?.id
			? site.queuedChange
			: undefined;
	const conversationRef = useRef<HTMLDivElement | null>(null);
	// A stable ref callback, so following is set up once per chat element.
	const [followChat] = useState(() => (element: HTMLDivElement | null) => {
		conversationRef.current = element;
		return followLatest(element);
	});
	const releaseGoingLive =
		site && release
			? releaseChanges(site, release.id, releaseReview?.action ?? "publish")
			: [];
	const releaseChecks = release ? checkSummary(release) : undefined;
	const releaseScreenshots = new Map<number, string>();
	for (const file of release?.qa?.screenshots ?? []) {
		const match = file.match(
			/(?:^|\/)(?:route-0-|home-)(1440|768|390)(?:-\d+)?\.png$/,
		);
		if (!match) continue;
		const width = Number(match[1]);
		const previous = releaseScreenshots.get(width);
		if (
			!previous ||
			(file.includes("/artifact/") && !previous.includes("/artifact/"))
		)
			releaseScreenshots.set(width, file);
	}
	function openReleaseReview(
		version: Version | undefined,
		action: "publish" | "rollback" = "publish",
	) {
		if (!site) return;
		setError("");
		setReleaseReview({
			siteId: site.id,
			versionId: version?.id,
			id: crypto.randomUUID(),
			expectedVersionId: site.publishedVersionId ?? null,
			action,
		});
	}
	async function handleOperation<Result>(operation: Promise<Result>) {
		setError("");
		try {
			await operation;
			await mutate();
		} catch (e) {
			setError(e instanceof Error ? e.message : "Something went wrong.");
		}
	}
	async function removeConversation(id: string) {
		setDeleteError("");
		setDeleting(id);
		try {
			await request(
				`/api/site/conversations/${encodeURIComponent(id)}`,
				undefined,
				"DELETE",
			);
			if (conversation?.id === id) router.push("/");
			await mutate((current) =>
				current?.site
					? {
							...current,
							site: {
								...current.site,
								conversations: current.site.conversations?.filter(
									(item) => item.id !== id,
								),
							},
						}
					: current,
			);
		} catch (e) {
			setDeleteError(
				e instanceof Error ? e.message : "Conversation could not be deleted.",
			);
		} finally {
			setDeleting(null);
		}
	}
	async function send(prompt: string) {
		setError("");
		try {
			const draft = onboardingDraft.current;
			// The website is written from saved details; save pending edits first.
			if (
				!site &&
				draft &&
				JSON.stringify(draft) !== JSON.stringify(data?.business)
			) {
				await request("/api/business", draft);
				onboardingDraft.current = null;
			}
			const result = await request<{ conversationId: string | null }>(
				site ? "/api/site/messages" : "/api/site",
				site
					? { prompt, conversationId: conversation?.id ?? null }
					: { prompt },
			);
			// The owner just wrote: always bring the newest message into view.
			jumpToLatest(conversationRef.current);
			router.push(
				result.conversationId
					? `/?conversation=${encodeURIComponent(result.conversationId)}`
					: "/",
			);
			setTab("preview");
			setPreviewVersion(undefined);
			await mutate();
		} catch (e) {
			setError(e instanceof Error ? e.message : "Message not sent");
			throw e;
		}
	}
	async function saveBusiness(body: Business) {
		setError("");
		try {
			await request("/api/business", body);
			setRevision((v) => v + 1);
			await mutate();
		} catch (e) {
			setError(e instanceof Error ? e.message : "Details were not saved");
			throw e;
		}
	}
	async function publishOrBuild() {
		if (
			!site ||
			!release ||
			!releaseReview ||
			releaseReview.siteId !== site.id ||
			publishing
		)
			return;
		setError("");
		setPublishing(true);
		try {
			await request(
				`/api/site/${publishable ? "publish" : "build"}`,
				publishable
					? {
							versionId: release.id,
							operationId: releaseReview.id,
							expectedPublishedVersionId: releaseReview.expectedVersionId,
							action: releaseReview.action,
						}
					: { versionId: release.id },
			);
			if (publishable)
				setReleaseReview((current) =>
					current?.id === releaseReview.id ? null : current,
				);
			await mutate();
		} catch (e) {
			setError(e instanceof Error ? e.message : "Request failed");
		} finally {
			setPublishing(false);
		}
	}
	function openConversation(id: string) {
		router.push(`/?conversation=${encodeURIComponent(id)}`);
		jumpToLatest(conversationRef.current);
		setError("");
		if (window.innerWidth < 900) {
			setSidebar(false);
			setMobilePane("chat");
		}
	}
	// After a failure (or a set-aside repair) the workspace no longer matches
	// the ready version, so the preview shows that saved version instead.
	const shownVersion =
		previewVersion ??
		(site?.phase === "failed" || (site?.restartFromReady && !busy)
			? site.activeVersionId
			: undefined);
	// The page picker lists the pages this version actually has, plus the
	// booking page every website links to.
	const previewPages = [
		...new Set([
			...((shownVersion
				? site?.versions.find((version) => version.id === shownVersion)
				: latest
			)?.routes ?? ["/"]),
			"/book",
		]),
	];
	const previewPath = previewPages.includes(path) ? path : "/";
	// Nothing to show yet: the first change never started, so no preview
	// exists. Say so instead of an endless loading state.
	const noPreview =
		site !== undefined &&
		site.phase === "failed" &&
		!shownVersion &&
		!site.threadId;
	const iframe =
		site && data
			? `${data.previewOrigin}/__open?site=${encodeURIComponent(site.id)}&version=${encodeURIComponent(shownVersion || "")}&revision=${site.previewRevision + revision}&gateway=${data?.previewGatewayId || ""}&path=${encodeURIComponent(previewPath)}`
			: "";
	// A workspace archived while the tab sat open remounts the frame, which
	// then shows the paused page with its "Wake preview" button.
	const paused = !shownVersion && data?.previewState === "paused";
	const frameKey = `${site?.id}-${shownVersion || "live"}-${site?.previewRevision}-${revision}-${previewPath}-${data?.previewGatewayId}${paused ? "-paused" : ""}`;
	return (
		<div
			className="studio-shell"
			onPointerDownCapture={editorActivity}
			onKeyDownCapture={editorActivity}
		>
			<aside
				className={cn("studio-sidebar", !sidebar && "closed")}
				aria-label="Workspace sidebar"
			>
				<div className="sidebar-top">
					<button
						type="button"
						className="team-button"
						onClick={() => setHelp(true)}
					>
						<Mark />
						<span>
							Site Studio<span>{businessName}</span>
						</span>
						<ChevronDown />
					</button>
					<IconButton label="Close sidebar" onClick={() => setSidebar(false)}>
						<PanelLeftClose />
					</IconButton>
				</div>
				{site && (
					<Button
						className="new-chat"
						variant="secondary"
						onClick={() => {
							router.push("/?conversation=new");
							setError("");
							if (!desktop) {
								setSidebar(false);
								setMobilePane("chat");
							}
						}}
					>
						<Plus />
						New change
					</Button>
				)}
				<div className="sidebar-nav">
					<Link
						href="/"
						className={!businessPage && !conversation ? "selected" : ""}
						aria-current={!businessPage && !conversation ? "page" : undefined}
						onClick={() => {
							if (!desktop) setSidebar(false);
						}}
					>
						<PanelsTopLeft />
						Your website
					</Link>
					<Link
						href="/business"
						className={businessPage ? "selected" : ""}
						aria-current={businessPage ? "page" : undefined}
						onClick={() => {
							if (!desktop) setSidebar(false);
						}}
					>
						<Building2 />
						Business details
					</Link>
				</div>
				{conversations.length > 0 && (
					<div className="sidebar-caption">CHANGES</div>
				)}
				<div className="recent-sites">
					{conversations.map((c) => (
						<div
							className={cn(
								"recent-site",
								!businessPage && c.id === conversation?.id && "selected",
							)}
							key={c.id}
						>
							<button
								type="button"
								className="recent-site-open"
								onClick={() => openConversation(c.id)}
							>
								<MessageSquare />
								<span>{c.title}</span>
								{busy && c.id === workingConversationId ? (
									<Loader2 className="spin" />
								) : null}
							</button>
							<Menu.Root>
								<Menu.Trigger
									className="thread-menu-trigger"
									aria-label={`More options for ${c.title}`}
								>
									{deleting === c.id ? (
										<Loader2 className="spin" />
									) : (
										<MoreHorizontal />
									)}
								</Menu.Trigger>
								<Menu.Portal>
									<Menu.Positioner
										sideOffset={5}
										align="start"
										className="thread-menu-positioner"
									>
										<Menu.Popup className="thread-menu surface-float">
											<Menu.Item
												className="thread-delete"
												disabled={Boolean(deleting) || busy}
												onClick={() => void removeConversation(c.id)}
											>
												<Trash2 /> Delete conversation
											</Menu.Item>
											<p className="thread-menu-hint">
												{busy
													? "Available when the current change finishes."
													: "Your website and its versions stay as they are."}
											</p>
										</Menu.Popup>
									</Menu.Positioner>
								</Menu.Portal>
							</Menu.Root>
						</div>
					))}
					{deleteError && (
						<p className="error-message" role="alert">
							{deleteError}
						</p>
					)}
				</div>
				<div className="sidebar-bottom">
					<div className="workspace-note">
						<span className="small-orbit">
							<Mark small />
						</span>
						<strong>A website that feels like you.</strong>
						<p>
							Your business. Your brand.
							<br />A little help getting it out there.
						</p>
					</div>
					<button
						type="button"
						className="account"
						onClick={() => setHelp(true)}
					>
						<span className="avatar">{initials(businessName)}</span>
						<span>
							{businessName}
							<small>{data?.business.category || "Your business"}</small>
						</span>
						<CircleHelp />
					</button>
				</div>
			</aside>
			<main
				className={cn(
					"studio-main",
					(businessPage || !site) && "studio-main-home",
				)}
			>
				{businessPage ? (
					<>
						<header className="home-header">
							{!sidebar && (
								<IconButton
									label="Open sidebar"
									onClick={() => setSidebar(true)}
								>
									<PanelLeftOpen />
								</IconButton>
							)}
							<span>Workspace</span>
						</header>
						<div className="business-page">
							{data ? (
								<>
									<BusinessPanel
										value={data.business}
										onSave={saveBusiness}
										serviceCardFields={
											!site || (site.foundationRevision ?? 1) >= 2
										}
										teamBios={!site || (site.foundationRevision ?? 1) >= 3}
										serviceBookingLabels={
											!site || site.foundationRevision === 4
										}
									/>
									<BrandPanel
										request={request}
										websiteCreated={Boolean(site)}
									/>
								</>
							) : (
								!loadError && <output>Loading business details…</output>
							)}
							{(error || loadError) && (
								<p role="alert" className="error-message">
									{error || loadError?.message}
								</p>
							)}
						</div>
					</>
				) : !site ? (
					<>
						<header className="home-header">
							{!sidebar && (
								<IconButton
									label="Open sidebar"
									onClick={() => setSidebar(true)}
								>
									<PanelLeftOpen />
								</IconButton>
							)}
							<span>{data ? "Get started" : "Your website"}</span>
						</header>
						{data ? (
							<div className="business-page onboarding">
								<div className="home-title">
									<span className="home-orbit">
										<Mark />
									</span>
									<h1>
										Make something
										<br />
										that feels like <em>you.</em>
									</h1>
									<p>
										Set up your website in three short steps. We’ll take care of
										the design and writing.
									</p>
								</div>
								<BusinessPanel
									onboarding
									value={data.business}
									onSave={saveBusiness}
									onDraft={(draft) => {
										onboardingDraft.current = draft;
									}}
								/>
								<BrandPanel request={request} onboarding />
								<section
									className="brand-panel business-form"
									aria-labelledby={onboardingTitleId}
								>
									<div className="panel-intro">
										<span className="section-kicker">
											STEP 3 · YOUR WEBSITE
										</span>
										<h2 id={onboardingTitleId}>Create your website</h2>
										<p>
											Tell us what your website should help with, or leave this
											empty. We’ll use your saved business details.
										</p>
									</div>
									<Composer
										key={suggestion}
										large
										businessName={businessName}
										initial={suggestion}
										busy={false}
										onSend={send}
									/>
									<div className="suggestion-row">
										{[
											"Help more people book with us",
											"Show people what we offer",
										].map((text) => (
											<button
												type="button"
												key={text}
												onClick={() => setSuggestion(text)}
											>
												<Sparkles />
												{text}
											</button>
										))}
									</div>
									{(error || loadError) && (
										<p role="alert" className="error-message">
											{error || loadError?.message}
										</p>
									)}
								</section>
							</div>
						) : (
							<div className="home-content">
								{loadError ? (
									<p role="alert" className="error-message">
										{loadError.message}
									</p>
								) : (
									<output className="creation-note">
										Loading your website…
									</output>
								)}
							</div>
						)}
						<footer className="home-footer">
							Your ideas. Site Studio’s business tools.
						</footer>
					</>
				) : (
					<>
						<header className="workspace-header">
							<div className="workspace-title">
								{!sidebar && (
									<IconButton
										label="Open sidebar"
										onClick={() => setSidebar(true)}
									>
										<PanelLeftOpen />
									</IconButton>
								)}
								<span className="title-name">{site.name}</span>
								<Badge className="draft-label">
									{site.publishedVersionId &&
									site.publishedVersionId === latest?.id
										? "Published"
										: site.publishedVersionId
											? "Unpublished changes"
											: "Draft"}
								</Badge>
							</div>
							<div
								className="workspace-tabs"
								role="tablist"
								aria-label="Workspace view"
							>
								{(["preview", "history"] as const).map((t) => (
									<button
										type="button"
										role="tab"
										aria-label={t === "preview" ? "Preview" : "Versions"}
										aria-selected={tab === t}
										key={t}
										className={cn(tab === t && "active")}
										onClick={() => setTab(t)}
									>
										{t === "preview" ? <Monitor /> : <History />}
										<span>{t === "preview" ? "Preview" : "Versions"}</span>
									</button>
								))}
							</div>
							<Button
								size="sm"
								// A version still being prepared cannot be published yet.
								disabled={busy}
								title={
									busy ? "Available when this version is ready" : undefined
								}
								onClick={() => openReleaseReview(latest)}
							>
								<Globe />
								<span>Publish</span>
							</Button>
						</header>
						<div className="mobile-pane-tabs">
							<button
								type="button"
								className={mobilePane === "chat" ? "active" : ""}
								onClick={() => setMobilePane("chat")}
							>
								Chat
							</button>
							<button
								type="button"
								className={mobilePane === "preview" ? "active" : ""}
								onClick={() => setMobilePane("preview")}
							>
								Website
							</button>
						</div>
						<div className="workspace-body" ref={watchOwnerReturn}>
							<section
								className={cn(
									"chat-pane",
									mobilePane !== "chat" && "mobile-hidden",
								)}
								aria-label="Website conversation"
							>
								<div className="conversation" ref={followChat}>
									<div className="assistant-avatar">
										<Mark small />
										<span>Site Studio</span>
									</div>
									<p className="welcome-message">
										A website built around your business.
									</p>
									<p className="muted-message">
										We’ll use your business details and handle the design and
										writing. Tell us what matters to you in your own words.
									</p>
									<div className="context-card">
										<div>
											<ShieldCheck />
											<strong>Connected to your business</strong>
										</div>
										<p>
											Live services & pricing
											<br />
											Booking & contact forms
											<br />
											Your contact details & opening hours
										</p>
										<Link href="/business">
											View business details <ArrowUpRight />
										</Link>
									</div>
									{site.messages
										.filter(
											(message) =>
												conversation !== undefined &&
												message.conversationId === conversation.id,
										)
										.filter(
											(message, index, messages) =>
												message.content.trim() !== "" &&
												(message.role !== "assistant" ||
													message.content !== messages[index - 1]?.content),
										)
										.map((m) =>
											m.role === "system" ? (
												// A neutral status line, never words the owner didn't write.
												<p className="muted-message" key={m.id}>
													{m.content}
												</p>
											) : (
												<div className={cn("chat-message", m.role)} key={m.id}>
													{m.role === "assistant" && (
														<div className="assistant-avatar">
															<Mark small />
															<span>Site Studio</span>
														</div>
													)}
													{m.role === "assistant" ? (
														<Markdown text={m.content} />
													) : (
														<p>{m.content}</p>
													)}
												</div>
											),
										)}
									{proposal && (
										<section
											className="proposal-card"
											aria-label="Suggested update to your business details"
										>
											<strong>{proposal.title}?</strong>
											<ul>
												{proposal.changes.map((change) => (
													<li key={change}>{change}</li>
												))}
											</ul>
											<div>
												<Button
													size="sm"
													disabled={proposalBusy}
													onClick={() => void answerProposal("apply")}
												>
													{proposalBusy ? (
														<Loader2 className="spin" />
													) : (
														<Check />
													)}
													Update
												</Button>
												<Button
													size="sm"
													variant="ghost"
													disabled={proposalBusy}
													onClick={() => void answerProposal("dismiss")}
												>
													Not now
												</Button>
											</div>
											<p>You can also change these in Business details.</p>
										</section>
									)}
									{!proposal && proposalSaved && (
										<output className="proposal-saved">
											<Check /> {proposalSaved}
										</output>
									)}
									{busy && (
										<output
											className="working-message"
											aria-label="Working"
											aria-live="polite"
										>
											<Loader2 className="spin" />
											{workingConversationId !== conversation?.id
												? "Finishing another change to your website."
												: progressLabel(site)}
										</output>
									)}
									{stalled && (
										<div className="stall-note">
											<p>
												This is taking much longer than it should. You can start
												this change again, or stop it. Your website is safe.
											</p>
											<Button
												variant="outline"
												size="sm"
												onClick={() => void retryChange()}
											>
												{retryLabel}
											</Button>
											<Button
												variant="ghost"
												size="sm"
												onClick={() => void stopChange()}
											>
												Stop this change
											</Button>
										</div>
									)}
									{queued && (
										<>
											<div className="chat-message user queued">
												<p>{queued.prompt}</p>
											</div>
											<p className="queued-note">
												<Clock3 />
												<span>
													{busy
														? "Queued — I’ll start this after the current change."
														: "Queued — I’ll start this once the current change is sorted out."}
												</span>
												<button
													type="button"
													className="link-button"
													onClick={() => void cancelQueued()}
												>
													Cancel
												</button>
											</p>
										</>
									)}
									{latest && (
										<button
											type="button"
											className="release-card"
											onClick={() => {
												setTab("history");
											}}
										>
											<span className="release-icon">
												<PanelsTopLeft />
											</span>
											<span>
												<strong>{latest.label}</strong>
												<small>
													{latest.id === site.publishedVersionId
														? "Published"
														: latest.qa?.status === "passed" && !latest.failure
															? "Ready to publish"
															: (buildingDraft &&
																		site.buildVersionId === latest.id) ||
																	// Being polished by its one automatic repair.
																	latest.failure?.advisory
																? "Getting ready…"
																: latest.failure ||
																		latest.qa?.status === "failed"
																	? "Not ready yet"
																	: "Draft"}
												</small>
											</span>
											<ChevronRight />
										</button>
									)}
									{(changeError || site.workspaceError || error) && (
										<p role="alert" className="error-message">
											{error || changeError || site.workspaceError}
										</p>
									)}
									{ownsChange &&
										site.phase === "failed" &&
										site.generationId && (
											<Button
												variant="outline"
												size="sm"
												onClick={() => void retryChange()}
											>
												{retryLabel}
											</Button>
										)}
								</div>
								<div className="chat-composer">
									<Composer
										key={conversation?.id ?? "new"}
										busy={busy}
										businessName={businessName}
										onSend={send}
									/>
									<p>
										<ShieldCheck />
										Changes stay private until you publish.
									</p>
								</div>
							</section>
							<section
								className={cn(
									"preview-section",
									mobilePane !== "preview" && "mobile-hidden",
								)}
								aria-label="Website workspace"
							>
								{tab === "preview" ? (
									<>
										<div className="preview-toolbar">
											<div className="device-switcher">
												<IconButton
													label="Desktop preview"
													active={device === "desktop"}
													onClick={() => setDevice("desktop")}
												>
													<Monitor />
												</IconButton>
												<IconButton
													label="Tablet preview"
													active={device === "tablet"}
													onClick={() => setDevice("tablet")}
												>
													<Tablet />
												</IconButton>
												<IconButton
													label="Mobile preview"
													active={device === "mobile"}
													onClick={() => setDevice("mobile")}
												>
													<Smartphone />
												</IconButton>
											</div>
											<div className="preview-address">
												<span className="connection-dot" />
												<select
													aria-label="Preview page"
													value={previewPath}
													onChange={(e) => setPath(e.target.value)}
												>
													{previewPages.map((route) => (
														<option key={route} value={route}>
															{route === "/book"
																? "Booking page"
																: `${routeLabel(route)}${route === "/" ? "" : ` · ${route}`}`}
														</option>
													))}
												</select>
											</div>
											<div className="preview-tools">
												<IconButton
													label="Refresh preview"
													onClick={() => setRevision((v) => v + 1)}
												>
													<RotateCcw />
												</IconButton>
												<a
													href={iframe}
													target="_blank"
													rel="noreferrer"
													aria-label="Open preview in new tab"
													title="Open preview in new tab"
												>
													<ExternalLink />
												</a>
											</div>
										</div>
										{buildingDraft && (
											<output className="preview-banner">
												<Loader2 className="spin" />
												<span>
													This is your new version. We’re still getting it
													ready; you can publish it as soon as it’s ready.
												</span>
											</output>
										)}
										{ownsChange && site.phase === "failed" && changeError && (
											// The Website tab carries the error and retry too, so a
											// phone user never waits on a preview that won't come.
											<output className="preview-banner failed">
												<span>{changeError}</span>
												{site.generationId && (
													<Button
														variant="outline"
														size="sm"
														onClick={() => void retryChange()}
													>
														{retryLabel}
													</Button>
												)}
											</output>
										)}
										{stalled && (
											<output className="preview-banner failed">
												<span>
													This change is taking much longer than it should. Your
													website is safe.
												</span>
												<Button
													variant="outline"
													size="sm"
													onClick={() => void retryChange()}
												>
													{retryLabel}
												</Button>
												<Button
													variant="ghost"
													size="sm"
													onClick={() => void stopChange()}
												>
													Stop this change
												</Button>
											</output>
										)}
										<div className={cn("preview-canvas", device)}>
											{noPreview ? (
												<output className="preview-placeholder">
													<p>
														Your website will appear here once your first change
														is under way.
													</p>
												</output>
											) : (
												(loadError || loadedFrame !== frameKey) && (
													<output className="preview-placeholder">
														<Loader2 className="spin preview-loading" />
														<p>Loading preview…</p>
													</output>
												)
											)}
											{!loadError && !noPreview && (
												// Opening a preview first starts the workspace; until the
												// frame's first page arrives, show the loading state rather
												// than an empty white frame.
												<iframe
													title={`${site.name} website preview`}
													key={frameKey}
													src={iframe}
													className={cn(loadedFrame !== frameKey && "loading")}
													ref={(frame) => {
														const loaded = () => setLoadedFrame(frameKey);
														frame?.addEventListener("load", loaded);
														return () =>
															frame?.removeEventListener("load", loaded);
													}}
													sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
												/>
											)}
										</div>
										<div className="preview-status">
											<span>
												<span className="connection-dot" />
												{shownVersion
													? "Saved version"
													: site.threadId
														? buildingDraft
															? "New version, getting ready"
															: data?.previewState === "waking"
																? "Waking your preview…"
																: data?.previewState === "paused"
																	? "Preview paused"
																	: "Live preview"
														: site.phase === "failed"
															? "No preview yet"
															: "Waiting for first preview"}
											</span>
											<span>
												{device === "mobile"
													? "Phone · 390px"
													: device === "tablet"
														? "Tablet · 768px"
														: "Full width"}
											</span>
										</div>
									</>
								) : (
									<div className="details-scroll">
										<div className="history-panel">
											<span className="section-kicker">
												YOUR WEBSITE, OVER TIME
											</span>
											<h2>Every version. Always yours.</h2>
											<p>
												Look over a saved version, or put an earlier one back
												live.
											</p>
											{!shownVersions.length ? (
												<div className="empty-versions">
													<Clock3 />
													<h3>
														Your first version starts with a conversation.
													</h3>
													<p>Ask for a change to save your first draft.</p>
												</div>
											) : (
												shownVersions.toReversed().map((v) => (
													<VersionRow
														key={v.id}
														version={v}
														site={site}
														onSelect={() => {
															setPreviewVersion(v.buildId ? v.id : undefined);
															setTab("preview");
														}}
														onPublish={() =>
															openReleaseReview(
																v,
																site.publishedVersionId && v.id !== latest?.id
																	? "rollback"
																	: "publish",
															)
														}
													/>
												))
											)}
											{site.publications?.length ? (
												<section
													className="publication-history"
													aria-label="Publishing history"
												>
													<h3>Publishing history</h3>
													<ol>
														{site.publications.toReversed().map((event) => (
															<li key={event.id}>
																<strong>
																	{event.action === "rollback"
																		? "Restored"
																		: "Published"}{" "}
																	{versionLabels.get(event.versionId) ||
																		"saved release"}
																</strong>
																<span>
																	{event.actor} ·{" "}
																	<time dateTime={event.createdAt}>
																		{viewerTime(event.createdAt)}
																	</time>
																</span>
															</li>
														))}
													</ol>
												</section>
											) : null}
										</div>
									</div>
								)}
							</section>
						</div>
					</>
				)}
			</main>
			{(publishOpen || help) && (
				<dialog
					className={cn("studio-dialog", !help && "publish-dialog")}
					ref={showDialog}
					onClose={() => {
						setReleaseReview(null);
						setHelp(false);
					}}
					aria-label={help ? "About this workspace" : "Publish your website"}
				>
					<button
						type="button"
						className="dialog-close"
						aria-label="Close dialog"
						onClick={() => {
							setReleaseReview(null);
							setHelp(false);
						}}
					>
						<X />
					</button>
					{help ? (
						<>
							<Mark />
							<h2>Your site studio.</h2>
							<p>
								Chat to change your website, preview it on any screen, and
								publish when you’re ready.
							</p>
							<div className="dialog-note">
								Online booking and enquiries stay in test mode until your
								booking system is connected.
							</div>
							<Button onClick={() => setHelp(false)}>Got it</Button>
						</>
					) : (
						<>
							{/* The summary scrolls; the publish button stays in view. */}
							<div className="dialog-scroll">
								<span className="publish-icon">
									<Globe />
								</span>
								<h2>
									{releaseReview?.action === "rollback" && publishable
										? "Restore this version?"
										: publishable
											? "Ready to publish?"
											: !release
												? "Nothing to publish yet"
												: releasePreparing
													? "Still getting this ready"
													: "This version isn’t ready"}
								</h2>
								<p>
									{!release
										? "Make your first change to create a version you can publish."
										: publishable
											? `${release.label}${
													releaseReview?.action === "rollback"
														? " will replace the published website. Your latest draft stays saved."
														: " will become the website your visitors see."
												}`
											: releasePreparing
												? `We’re still preparing ${release.label}. You can publish it as soon as it’s ready.`
												: releaseRetry
													? `We couldn’t finish getting ${release.label} ready because of a temporary problem on our side. Choose “Try again” to finish it.`
													: releaseFailed
														? `${release.label} couldn’t be finished. Describe the change again in the chat and we’ll make a new version.`
														: `${release.label} was never finished, so it can’t be published.`}
								</p>
								{release && (
									<div className="release-summary">
										{releaseGoingLive.length > 1 ? (
											// Everything going live since the published version.
											releaseGoingLive.map((change) => (
												<div className="release-change" key={change.id}>
													<strong>{change.label}</strong>
													<Markdown text={change.summary} />
												</div>
											))
										) : (
											<Markdown
												text={
													releaseGoingLive[0]?.summary ||
													"Saved website version."
												}
											/>
										)}
									</div>
								)}
								{site &&
									publishable &&
									release?.qa &&
									release.qa.screenshots.length > 0 && (
										<section
											className="release-screenshots"
											aria-label="Checked screenshots"
										>
											{[...releaseScreenshots].map(([width, file]) => (
												<a
													key={file}
													href={`/api/site/versions/${release.id}/evidence?file=${encodeURIComponent(file)}`}
													target="_blank"
													rel="noreferrer"
												>
													<Image
														src={`/api/site/versions/${release.id}/evidence?file=${encodeURIComponent(file)}`}
														width={1440}
														height={900}
														unoptimized
														alt={`Open checked ${width}px screenshot`}
													/>
												</a>
											))}
										</section>
									)}
								{release && (
									<div className="publish-check">
										{releasePreparing ? (
											<Loader2 className="spin" />
										) : (
											<ShieldCheck />
										)}
										<span>
											{checkedInBrowsers
												? "Checked on phones, tablets and computers"
												: publishable
													? "Ready to publish"
													: releasePreparing
														? "Getting this version ready…"
														: "Not ready to publish"}
										</span>
										{publishable && <Check />}
									</div>
								)}
								{error && (
									<p role="alert" className="error-message">
										{error}
									</p>
								)}
								{site && checkedInBrowsers && release?.qa?.checks.length ? (
									<details className="qa-details">
										<summary>See what we checked</summary>
										{release.repairSummary && (
											<p>
												Fixed automatically before release:{" "}
												{release.repairSummary}
											</p>
										)}
										{releaseChecks && (
											<>
												<p>
													{releaseChecks.pages}. {releaseChecks.devices}.
												</p>
												<ul>
													{releaseChecks.tried.map((item) => (
														<li key={item}>
															<Check />
															{item}
														</li>
													))}
												</ul>
												<p>{releaseChecks.issues}</p>
											</>
										)}
										{data?.staff && (
											// The raw report is a staff and developer tool.
											<a
												href={`/api/site/versions/${release.id}/evidence`}
												target="_blank"
												rel="noreferrer"
											>
												Staff: open the raw check report <ArrowUpRight />
											</a>
										)}
									</details>
								) : null}
								{site?.publishedVersionId && (
									<a
										className="published-link"
										href={`${data?.sitesOrigin ?? ""}/`}
										target="_blank"
										rel="noreferrer"
									>
										View published website <ArrowUpRight />
									</a>
								)}
								{publishable && (
									<div className="dialog-note">
										Your saved versions stay available if you want to roll back.
									</div>
								)}
							</div>
							{release && (publishable || releaseRetry || releasePreparing) && (
								<div className="dialog-actions">
									{/* Raw website files are a staff and developer tool. */}
									{site && data?.staff && publishable && release.buildId && (
										<a
											className="download-link"
											href={`/api/site/versions/${release.id}/artifact`}
										>
											<Download />
											Download website files
										</a>
									)}
									<Button
										disabled={
											publishing ||
											busy ||
											release.id === site?.publishedVersionId
										}
										onClick={publishOrBuild}
									>
										{publishing || releasePreparing ? (
											<Loader2 className="spin" />
										) : publishable ? (
											<Globe />
										) : (
											<RotateCcw />
										)}{" "}
										{publishing
											? "Publishing…"
											: publishable
												? releaseReview?.action === "rollback"
													? "Restore website"
													: "Publish website"
												: releasePreparing
													? "Getting ready…"
													: retryLabel}
									</Button>
								</div>
							)}
						</>
					)}
				</dialog>
			)}
		</div>
	);
}
