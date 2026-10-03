/**
 * Where the studio, the private preview gateway and the published websites
 * are reached, and which local sockets serve them.
 *
 * Locally (no configuration) each role has its own loopback port:
 * studio 4320, preview 4321, published websites 4322. Hosted, the three
 * public origins are usually three hostnames that all arrive on one internal
 * port behind a TLS proxy (Fly's proxy routes by port, not by name), so a
 * listener serving several roles picks the role from the Host header.
 */
export type Role = "studio" | "preview" | "sites";
export type Endpoint = {
	role: Role;
	/** Browser origin, e.g. https://preview.example.invalid */
	origin: string;
	/** Host header value that selects this endpoint (URL.host form). */
	host: string;
};
export type Listener = { host: string; port: number; endpoints: Endpoint[] };
export type Hosting = {
	studioOrigin: string;
	previewOrigin: string;
	sitesOrigin: string;
	/**
	 * Preview-gateway origin used by the in-process browser checks. Loopback
	 * only; hosted, it is a separate listener bound to 127.0.0.1.
	 */
	checkOrigin: string;
	/** Exact HTTPS origin sent to the platform when requesting preview grants. */
	frameOrigin: string;
	listeners: Listener[];
	/** Honour Fly-Client-IP and X-Forwarded-Proto (set by Fly's proxy only). */
	trustProxy: boolean;
};

const defaultPorts: Record<Role, number> = {
	studio: 4320,
	preview: 4321,
	sites: 4322,
};
const envNames: Record<Role, { origin: string; port: string }> = {
	studio: { origin: "STUDIO_ORIGIN", port: "STUDIO_PORT" },
	preview: { origin: "STUDIO_PREVIEW_ORIGIN", port: "STUDIO_PREVIEW_PORT" },
	sites: { origin: "STUDIO_SITES_ORIGIN", port: "STUDIO_SITES_PORT" },
};
/** Used for grant framing when the studio itself is served over plain HTTP. */
const localFrameOrigin = "https://studio.example.invalid";

function port(name: string, value: string | undefined, fallback: number) {
	if (value === undefined || value === "") return fallback;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535)
		throw new Error(`${name} must be a TCP port`);
	return parsed;
}

function origin(name: string, value: string) {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`${name} must be an origin such as https://example.com`);
	}
	if (
		(url.protocol !== "http:" && url.protocol !== "https:") ||
		url.username ||
		url.password ||
		url.pathname !== "/" ||
		url.search ||
		url.hash
	)
		throw new Error(`${name} must be an origin such as https://example.com`);
	return url;
}

export function readHosting(
	env: Partial<Record<string, string>> = process.env,
): Hosting {
	const listenHost = env.STUDIO_LISTEN_HOST || "127.0.0.1";
	const shared = port("STUDIO_LISTEN_PORT", env.STUDIO_LISTEN_PORT, 0);
	const roles = (["studio", "preview", "sites"] as const).map((role) => {
		const names = envNames[role];
		const listen = port(
			names.port,
			env[names.port],
			shared || defaultPorts[role],
		);
		const url = origin(
			names.origin,
			env[names.origin] || `http://127.0.0.1:${listen}`,
		);
		return {
			role,
			listen,
			endpoint: { role, origin: url.origin, host: url.host },
		};
	});
	const hosts = new Set(roles.map(({ endpoint }) => endpoint.host));
	if (hosts.size !== roles.length)
		throw new Error(
			"The studio, preview and published website origins need distinct hosts",
		);
	const listeners: Listener[] = [];
	for (const { listen, endpoint } of roles) {
		const existing = listeners.find((listener) => listener.port === listen);
		if (existing) existing.endpoints.push(endpoint);
		else
			listeners.push({ host: listenHost, port: listen, endpoints: [endpoint] });
	}
	const [studio, preview, sites] = roles;
	// Browser checks run in this process and reach the gateway over loopback.
	// When the public preview origin is not that loopback address, a separate
	// loopback-only listener serves the gateway for them.
	let checkOrigin = preview.endpoint.origin;
	const loopbackReachable =
		listenHost === "127.0.0.1" || listenHost === "0.0.0.0";
	if (
		preview.endpoint.origin !== `http://127.0.0.1:${preview.listen}` ||
		!loopbackReachable
	) {
		const checkPort = port(
			"STUDIO_CHECK_PORT",
			env.STUDIO_CHECK_PORT,
			defaultPorts.preview,
		);
		if (listeners.some((listener) => listener.port === checkPort))
			throw new Error(
				"STUDIO_CHECK_PORT must differ from the public listening ports",
			);
		checkOrigin = `http://127.0.0.1:${checkPort}`;
		listeners.push({
			host: "127.0.0.1",
			port: checkPort,
			endpoints: [
				{
					role: "preview",
					origin: checkOrigin,
					host: `127.0.0.1:${checkPort}`,
				},
			],
		});
	}
	const trust = env.STUDIO_TRUST_PROXY || "";
	if (trust !== "" && trust !== "fly")
		throw new Error('STUDIO_TRUST_PROXY must be unset or "fly"');
	return {
		studioOrigin: studio.endpoint.origin,
		previewOrigin: preview.endpoint.origin,
		sitesOrigin: sites.endpoint.origin,
		checkOrigin,
		frameOrigin: studio.endpoint.origin.startsWith("https:")
			? studio.endpoint.origin
			: localFrameOrigin,
		listeners,
		trustProxy: trust === "fly",
	};
}

/** The endpoint a request's Host header selects on this listener, if any. */
export function endpointFor(
	listener: Listener,
	hostHeader: string | undefined,
) {
	if (!hostHeader) return;
	return listener.endpoints.find((endpoint) => {
		try {
			// Normalizes case and an explicit default port (host:443).
			return (
				new URL(`${new URL(endpoint.origin).protocol}//${hostHeader}`).host ===
				endpoint.host
			);
		} catch {
			return false;
		}
	});
}

/** Plain HTTP reached a public HTTPS origin through the trusted proxy. */
export function needsHttps(
	hosting: Hosting,
	endpoint: Endpoint,
	headers: Record<string, string | string[] | undefined>,
) {
	return (
		hosting.trustProxy &&
		endpoint.origin.startsWith("https:") &&
		headers["x-forwarded-proto"] === "http"
	);
}

/** The client's address; the proxy's header is used only when trusted. */
export function clientAddress(
	hosting: Hosting,
	headers: Record<string, string | string[] | undefined>,
	socketAddress: string | undefined,
) {
	const forwarded = headers["fly-client-ip"];
	if (hosting.trustProxy && typeof forwarded === "string" && forwarded)
		return forwarded;
	return socketAddress ?? "unknown";
}
