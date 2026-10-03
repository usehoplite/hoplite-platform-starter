import { lookup } from "node:dns/promises";
import {
	type ClientRequest,
	request as httpRequest,
	type IncomingMessage,
	type RequestOptions,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import ipaddr from "ipaddr.js";

type Address = { address: string; family: number };
type Response = {
	url: string;
	status: number;
	headers: Record<string, string>;
	body: Buffer;
};
type Transport = (
	url: URL,
	options: RequestOptions,
	callback: (response: IncomingMessage) => void,
) => ClientRequest;

export function publicAddress(address: string) {
	try {
		return ipaddr.process(address).range() === "unicast";
	} catch {
		return false;
	}
}

// All importer browser resources and asset downloads use this same bounded,
// DNS-pinned transport. The browser never fetches a supplied URL itself.
export class PublicFetcher {
	private requests = 0;
	private bytes = 0;
	private readonly deadline = Date.now() + 60_000;
	constructor(
		private readonly dependencies: {
			resolve?: (hostname: string) => Promise<Address[]>;
			request?: Transport;
		} = {},
	) {}
	async fetch(input: string, redirects = 0): Promise<Response> {
		if (++this.requests > 80 || Date.now() >= this.deadline)
			throw new Error("Website import reached its request or time limit.");
		const url = new URL(input);
		if (
			!["http:", "https:"].includes(url.protocol) ||
			url.username ||
			url.password ||
			(url.port && url.port !== "80" && url.port !== "443")
		)
			throw new Error(
				"Use a public HTTP or HTTPS website without credentials or a custom port.",
			);
		url.hash = "";
		const hostname = url.hostname.replace(/^\[|\]$/g, "");
		const resolveHost =
			this.dependencies.resolve ||
			((host: string) => lookup(host, { all: true, verbatim: true }));
		const timeout = Math.min(12_000, this.deadline - Date.now());
		const signal = AbortSignal.timeout(Math.max(1, timeout));
		const addresses = isIP(hostname)
			? [{ address: hostname, family: isIP(hostname) }]
			: await new Promise<Address[]>((resolve, reject) => {
					const abort = () =>
						reject(new Error("Website DNS lookup timed out."));
					signal.addEventListener("abort", abort, { once: true });
					void resolveHost(hostname)
						.then(resolve, reject)
						.finally(() => signal.removeEventListener("abort", abort));
				});
		if (
			!addresses.length ||
			addresses.some((address) => !publicAddress(address.address))
		)
			throw new Error(
				"Website import cannot access private or reserved network addresses.",
			);
		const pinned = addresses[0];
		const request: Transport =
			this.dependencies.request ||
			(url.protocol === "https:" ? httpsRequest : httpRequest);
		const result = await new Promise<Response>((resolve, reject) => {
			const req = request(
				url,
				{
					method: "GET",
					agent: false,
					signal,
					family: pinned.family,
					lookup: (_hostname, options, callback) =>
						callback(
							null,
							options.all ? addresses : pinned.address,
							pinned.family,
						),
					headers: {
						"user-agent": "SiteStudioWebsiteImport/1.0",
						accept: "*/*",
						"accept-encoding": "identity",
					},
				},
				(res) => {
					const chunks: Buffer[] = [];
					let size = 0;
					res.on("data", (chunk: Buffer) => {
						size += chunk.length;
						this.bytes += chunk.length;
						if (size > 6 * 1024 * 1024 || this.bytes > 40 * 1024 * 1024) {
							req.destroy(
								new Error("Website import exceeded its download limit."),
							);
							return;
						}
						chunks.push(chunk);
					});
					res.once("error", reject);
					res.once("end", () => {
						try {
							let body = Buffer.concat(chunks);
							const encoding = res.headers["content-encoding"];
							const options = { maxOutputLength: 6 * 1024 * 1024 };
							if (encoding === "gzip") body = gunzipSync(body, options);
							else if (encoding === "deflate")
								body = inflateSync(body, options);
							else if (encoding === "br")
								body = brotliDecompressSync(body, options);
							else if (encoding && encoding !== "identity")
								throw new Error("Unsupported website content encoding");
							this.bytes += Math.max(0, body.length - size);
							if (this.bytes > 40 * 1024 * 1024)
								throw new Error("Website import exceeded its download limit.");
							const headers: Record<string, string> = {};
							for (const name of ["content-type", "location"]) {
								const value = res.headers[name];
								if (typeof value === "string") headers[name] = value;
							}
							resolve({
								url: url.href,
								status: res.statusCode || 502,
								headers,
								body,
							});
						} catch (error) {
							reject(error);
						}
					});
				},
			);
			req.once("error", reject);
			req.end();
		});
		if ([301, 302, 303, 307, 308].includes(result.status)) {
			if (redirects >= 4 || !result.headers.location)
				throw new Error(
					"Website has too many redirects or an invalid redirect.",
				);
			return this.fetch(
				new URL(result.headers.location, url).href,
				redirects + 1,
			);
		}
		return result;
	}
}
