import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
	link,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { addAbortSignal, Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
	GetObjectCommand,
	PutObjectCommand,
	S3Client,
	S3ServiceException,
} from "@aws-sdk/client-s3";
import { c as archive } from "tar";
import type { SourceFile } from "./hoplite";
import { bytes, containsPrivateCredential, sha256 } from "./safety";
import { dataRoot } from "./store";
import type { Version } from "./types";

type Entry = { path: string; sha256: string; size: number };
type Manifest = {
	siteId?: string;
	versionId?: string;
	importId?: string;
	files: Entry[];
};
type Configuration = {
	bucket: string;
	prefix: string;
	region: string;
	endpoint?: string;
};
export type ReleaseObjects = Configuration & {
	manifestKey: string;
	manifestSha256: string;
};

function safePath(path: string) {
	return (
		Boolean(path) &&
		!/[\\\0]/.test(path) &&
		!path.split("/").some((part) => !part || part === "." || part === "..")
	);
}
function configuration(): Configuration | undefined {
	const bucket = process.env.STUDIO_RELEASE_BUCKET;
	if (!bucket) {
		if (
			process.env.STUDIO_RELEASE_ENDPOINT ||
			process.env.STUDIO_RELEASE_PREFIX
		)
			throw new Error(
				"STUDIO_RELEASE_BUCKET is required when release storage is configured.",
			);
		return;
	}
	const prefix = process.env.STUDIO_RELEASE_PREFIX || "studio";
	if (!safePath(prefix)) throw new Error("Invalid release storage prefix");
	const endpoint = process.env.STUDIO_RELEASE_ENDPOINT;

	return {
		bucket,
		prefix,
		region:
			process.env.STUDIO_RELEASE_REGION ||
			process.env.AWS_REGION ||
			"us-east-1",
		...(endpoint ? { endpoint } : {}),
	};
}

// A single adapter owns SDK behavior for generation, downloads and public delivery.
// Configured storage never silently falls back to local files.
export class ReleaseStorage {
	readonly config: Configuration | undefined;
	private readonly client?: S3Client;
	private readonly manifests = new Map<string, Promise<Manifest>>();
	constructor(config = configuration()) {
		if (config?.endpoint) {
			const endpoint = new URL(config.endpoint);
			if (
				endpoint.username ||
				endpoint.password ||
				endpoint.search ||
				endpoint.hash ||
				(endpoint.protocol !== "https:" &&
					!(
						endpoint.protocol === "http:" &&
						["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)
					))
			)
				throw new Error(
					"Release storage requires HTTPS outside loopback and must not embed credentials.",
				);
		}
		this.config = config;
		if (config)
			this.client = new S3Client({
				region: config.region,
				endpoint: config.endpoint,
				forcePathStyle: Boolean(config.endpoint),
				requestHandler: {
					connectionTimeout: 5_000,
					socketTimeout: 15_000,
					requestTimeout: 60_000,
					throwOnRequestTimeout: true,
				},
			});
	}
	private prefix(siteId: string, version: Version) {
		if (
			!safePath(siteId) ||
			siteId.includes("/") ||
			!safePath(version.id) ||
			version.id.includes("/")
		)
			throw new Error("Invalid release identity");
		return `${this.config?.prefix}/microsites/${siteId}/releases/${version.id}`;
	}
	private async readObject<T>(
		key: string,
		consume: (body: Readable) => Promise<T>,
	): Promise<T> {
		if (!this.client || !this.config)
			throw new Error("Release object storage is not configured");
		for (let attempt = 0; ; attempt++) {
			// SDK request timers stop at response headers. Keep the same deadline
			// attached to the stream until every byte has been consumed.
			const signal = AbortSignal.timeout(30_000);
			let body: Readable | undefined;
			try {
				const response = await this.client.send(
					new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
					{ abortSignal: signal },
				);
				if (!(response.Body instanceof Readable))
					throw new Error("Release object is not a readable Node stream");
				body = addAbortSignal(signal, response.Body);
				return await consume(body);
			} catch (error) {
				const retryable =
					error instanceof Error &&
					(["AbortError", "TimeoutError"].includes(error.name) ||
						[
							"ECONNRESET",
							"ETIMEDOUT",
							"EPIPE",
							"ERR_STREAM_PREMATURE_CLOSE",
						].includes((error as NodeJS.ErrnoException).code || ""));
				if (attempt !== 0 || !retryable) throw error;
			} finally {
				body?.destroy();
			}
		}
	}
	private async object(key: string) {
		return this.readObject(key, async (body) => {
			const chunks: Buffer[] = [];
			for await (const chunk of body) {
				if (!Buffer.isBuffer(chunk))
					throw new Error("Release object returned a non-binary chunk");
				chunks.push(chunk);
			}
			return Buffer.concat(chunks);
		});
	}
	private async put(key: string, body: Buffer) {
		if (!this.client || !this.config)
			throw new Error("Release object storage is not configured");
		try {
			await this.client.send(
				new PutObjectCommand({
					Bucket: this.config.bucket,
					Key: key,
					Body: body,
					IfNoneMatch: "*",
					ContentType: "application/octet-stream",
				}),
			);
		} catch (error) {
			if (
				!(error instanceof S3ServiceException) ||
				error.$metadata.httpStatusCode !== 412
			)
				throw error;
			if (!(await this.object(key)).equals(body))
				throw new Error(
					"Saved release object differs from the immutable candidate.",
				);
		}
	}
	private async manifestAt(
		prefix: string,
		pointer: ReleaseObjects | undefined,
	): Promise<Manifest> {
		const config = this.config;
		if (
			!pointer ||
			!config ||
			pointer.bucket !== config.bucket ||
			pointer.prefix !== config.prefix ||
			pointer.region !== config.region ||
			pointer.endpoint !== config.endpoint
		)
			throw new Error(
				"Release storage configuration does not match the saved release.",
			);
		if (
			pointer.manifestKey !==
				`${prefix}/manifests/${pointer.manifestSha256}.json` ||
			!/^[a-f0-9]{64}$/.test(pointer.manifestSha256)
		)
			throw new Error("Invalid release manifest pointer");
		const cached = this.manifests.get(pointer.manifestKey);
		if (cached) return cached;
		const pending = (async () => {
			const body = await this.object(pointer.manifestKey);
			if (sha256(body) !== pointer.manifestSha256)
				throw new Error("Release manifest hash mismatch");
			const manifest: Manifest = JSON.parse(body.toString());
			if (
				!Array.isArray(manifest.files) ||
				manifest.files.some(
					(entry) =>
						typeof entry.path !== "string" ||
						!safePath(entry.path) ||
						!/^[a-f0-9]{64}$/.test(entry.sha256) ||
						!Number.isSafeInteger(entry.size) ||
						entry.size < 0,
				) ||
				new Set(manifest.files.map((entry) => entry.path)).size !==
					manifest.files.length
			)
				throw new Error("Invalid release manifest");
			return manifest;
		})();
		this.manifests.set(pointer.manifestKey, pending);
		if (this.manifests.size > 64) {
			const oldest = this.manifests.keys().next().value;
			if (oldest) this.manifests.delete(oldest);
		}
		try {
			return await pending;
		} catch (error) {
			this.manifests.delete(pointer.manifestKey);
			throw error;
		}
	}
	private async manifest(siteId: string, version: Version) {
		const manifest = await this.manifestAt(
			this.prefix(siteId, version),
			version.storage,
		);
		if (manifest.siteId !== siteId || manifest.versionId !== version.id)
			throw new Error("Invalid release manifest identity");
		return manifest;
	}
	async saveBrand(id: string, files: { path: string; body: Buffer }[]) {
		if (!safePath(id) || id.includes("/"))
			throw new Error("Invalid brand import identity");
		if (new Set(files.map((file) => file.path)).size !== files.length)
			throw new Error("Duplicate brand import path");
		const prefix = `${this.config?.prefix}/brand-imports/${id}`;
		const entries: Entry[] = [];
		for (const file of files) {
			if (!safePath(file.path)) throw new Error("Invalid brand import path");
			const path = join(dataRoot, "brand-imports", id, file.path);
			await mkdir(dirname(path), { recursive: true });
			await immutableFile(path, file.body);
			if (this.config) await this.put(`${prefix}/${file.path}`, file.body);
			entries.push({
				path: file.path,
				sha256: sha256(file.body),
				size: file.body.length,
			});
		}
		if (!this.config) return;
		const body = Buffer.from(JSON.stringify({ importId: id, files: entries }));
		const hash = sha256(body);
		const key = `${prefix}/manifests/${hash}.json`;
		await this.put(key, body);
		return { ...this.config, manifestKey: key, manifestSha256: hash };
	}
	async migrateBrand(record: { id: string; storage?: ReleaseObjects }) {
		if (!safePath(record.id) || record.id.includes("/"))
			throw new Error("Invalid brand import identity");
		if (record.storage) {
			await this.readBrand(record, "visual-brief.json");
			return record.storage;
		}
		if (!this.config) return;
		const root = join(dataRoot, "brand-imports", record.id);
		const paths = ["visual-brief.json", "reference.png"];
		try {
			for (const entry of await readdir(join(root, "assets"), {
				withFileTypes: true,
			})) {
				if (!entry.isFile() || !/^[a-f0-9]{64}\.png$/.test(entry.name))
					throw new Error("Invalid saved brand asset");
				paths.push(`assets/${entry.name}`);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		return this.saveBrand(
			record.id,
			await Promise.all(
				paths.map(async (path) => ({
					path,
					body: await readFile(join(root, path)),
				})),
			),
		);
	}
	async readBrand(
		record: { id: string; storage?: ReleaseObjects },
		path: string,
	) {
		if (!safePath(record.id) || record.id.includes("/") || !safePath(path))
			throw new Error("Invalid brand import path");
		if (!record.storage && !this.config)
			return readFile(join(dataRoot, "brand-imports", record.id, path));
		const prefix = `${this.config?.prefix}/brand-imports/${record.id}`;
		const manifest = await this.manifestAt(prefix, record.storage);
		if (manifest.importId !== record.id)
			throw new Error("Invalid brand import manifest identity");
		const entry = manifest.files.find((file) => file.path === path);
		if (!entry) throw new Error("Brand reference file not found");
		const body = await this.object(`${prefix}/${path}`);
		if (body.length !== entry.size || sha256(body) !== entry.sha256)
			throw new Error("Brand reference object hash mismatch");
		return body;
	}
	async sync(siteId: string, version: Version) {
		if (!this.config) {
			if (version.storage)
				throw new Error(
					"Configure object storage to access this saved release.",
				);
			return;
		}
		const prefix = this.prefix(siteId, version);
		const previous = version.storage
			? await this.manifest(siteId, version)
			: undefined;
		const entries = new Map(
			previous?.files.map((entry) => [entry.path, entry]),
		);
		const root = join(dataRoot, "versions", version.id);
		let quarantine = false;
		try {
			const sourceBody = await readFile(join(root, "source.json"));
			const saved = entries.get("source.json");
			if (saved && sha256(sourceBody) !== saved.sha256)
				throw new Error("Immutable release changed: source.json");
			const source: { files: SourceFile[] } = JSON.parse(sourceBody.toString());
			quarantine = source.files.some((file) =>
				containsPrivateCredential(bytes(file).toString()),
			);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !previous)
				throw error;
		}
		if (quarantine) {
			entries.clear();
			await immutableFile(
				join(root, "source-quarantine.json"),
				JSON.stringify({
					sourceId: version.sourceId,
					reason:
						"Source contains a possible private credential and was not uploaded.",
				}),
			);
		}
		if (!quarantine && version.sourceChecked && !entries.has("source.tar.gz"))
			await sourceArchive(root);
		async function files(directory: string, base = ""): Promise<string[]> {
			const result: string[] = [];
			for (const item of await readdir(directory, { withFileTypes: true })) {
				const path = base + item.name;
				if (!safePath(path)) throw new Error("Unsafe release file path");
				if (item.name.endsWith(".tmp")) continue;
				if (item.isDirectory())
					result.push(...(await files(join(directory, item.name), `${path}/`)));
				else if (item.isFile()) result.push(path);
				else
					throw new Error(
						"Release storage does not accept links or special files",
					);
			}
			return result;
		}
		let paths: string[];
		try {
			paths = await files(root);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !previous)
				throw error;
			paths = [];
		}
		if (quarantine) paths = ["source-quarantine.json"];
		// Bound upload concurrency; a release can contain hundreds of screenshots.
		for (let offset = 0; offset < paths.length; offset += 4) {
			await Promise.all(
				paths.slice(offset, offset + 4).map(async (path) => {
					const body = await readFile(join(root, path));
					const entry = { path, sha256: sha256(body), size: body.length };
					const saved = entries.get(path);
					if (
						saved &&
						(saved.sha256 !== entry.sha256 || saved.size !== entry.size)
					)
						throw new Error(`Immutable release changed: ${path}`);
					if (!saved) await this.put(`${prefix}/${path}`, body);
					entries.set(path, entry);
				}),
			);
		}
		if (!entries.has("source.json") && !entries.has("source-quarantine.json"))
			throw new Error("Release source has not been persisted");
		const manifest: Manifest = {
			siteId,
			versionId: version.id,
			files: [...entries.values()].sort((a, b) => a.path.localeCompare(b.path)),
		};
		const body = Buffer.from(JSON.stringify(manifest));
		const hash = sha256(body);
		const key = `${prefix}/manifests/${hash}.json`;
		await this.put(key, body);
		version.storage = {
			...this.config,
			manifestKey: key,
			manifestSha256: hash,
		};
	}
	async read(
		siteId: string,
		version: Version,
		path: string,
	): Promise<Buffer | undefined> {
		if (!safePath(path)) throw new Error("Invalid release path");
		if (!version.storage && !this.config) {
			try {
				return await readFile(join(dataRoot, "versions", version.id, path));
			} catch (error) {
				if (
					(error as NodeJS.ErrnoException).code === "ENOENT" ||
					(error as NodeJS.ErrnoException).code === "EISDIR"
				)
					return;
				throw error;
			}
		}
		const manifest = await this.manifest(siteId, version);
		const entry = manifest.files.find((file) => file.path === path);
		if (!entry) return;
		const body = await this.object(`${this.prefix(siteId, version)}/${path}`);
		if (body.length !== entry.size || sha256(body) !== entry.sha256)
			throw new Error(`Release object hash mismatch: ${path}`);
		return body;
	}
	async materialize(siteId: string, version: Version, path: string) {
		if (!safePath(path)) throw new Error("Invalid release path");
		if (!version.storage && !this.config) {
			const file = join(dataRoot, "versions", version.id, path);
			const info = await stat(file);
			if (!info.isFile()) throw new Error("Release file is unavailable");
			return { file, size: info.size, dispose: async () => undefined };
		}
		const manifest = await this.manifest(siteId, version);
		const entry = manifest.files.find((item) => item.path === path);
		if (!entry || !this.client || !this.config)
			throw new Error(`Release file is unavailable: ${path}`);
		const directory = await mkdtemp(join(tmpdir(), "studio-download-"));
		const file = join(directory, "object");
		try {
			return await this.readObject(
				`${this.prefix(siteId, version)}/${path}`,
				async (body) => {
					const hash = createHash("sha256");
					let size = 0;
					await pipeline(
						body,
						new Transform({
							transform(chunk: Buffer, _encoding, callback) {
								size += chunk.length;
								if (size > entry.size) {
									callback(
										new Error("Release object size exceeds its manifest"),
									);
									return;
								}
								hash.update(chunk);
								callback(null, chunk);
							},
						}),
						// A retry replaces only this private, unexposed partial download.
						createWriteStream(file, { flags: "w", mode: 0o600 }),
					);
					if (size !== entry.size || hash.digest("hex") !== entry.sha256)
						throw new Error(`Release object hash mismatch: ${path}`);
					return {
						file,
						size,
						dispose: () => rm(directory, { recursive: true, force: true }),
					};
				},
			);
		} catch (error) {
			await rm(directory, { recursive: true, force: true });
			throw error;
		}
	}
	async require(siteId: string, version: Version, path: string) {
		const body = await this.read(siteId, version, path);
		if (!body) throw new Error(`Release file is unavailable: ${path}`);
		return body;
	}
}
export const releaseStorage = new ReleaseStorage();

async function sourceArchive(root: string) {
	const source: { files: SourceFile[] } = JSON.parse(
		await readFile(join(root, "source.json"), "utf8"),
	);
	if (
		!Array.isArray(source.files) ||
		!source.files.length ||
		source.files.some((file) => !safePath(file.path)) ||
		new Set(source.files.map((file) => file.path)).size !== source.files.length
	)
		throw new Error("Cannot archive unsafe or duplicate source paths");
	const directory = await mkdtemp(join(tmpdir(), "studio-source-"));
	try {
		const files: Entry[] = [];
		for (const file of [...source.files].sort((a, b) =>
			a.path.localeCompare(b.path),
		)) {
			const body = bytes(file);
			await mkdir(dirname(join(directory, "source", file.path)), {
				recursive: true,
			});
			await writeFile(join(directory, "source", file.path), body, {
				flag: "wx",
				mode: 0o600,
			});
			files.push({ path: file.path, sha256: sha256(body), size: body.length });
		}
		await archive(
			{
				cwd: join(directory, "source"),
				file: join(directory, "source.tar.gz"),
				gzip: true,
				portable: true,
				mtime: new Date(0),
			},
			files.map((file) => file.path),
		);
		await immutableFile(
			join(root, "source.tar.gz"),
			await readFile(join(directory, "source.tar.gz")),
		);
		await immutableFile(
			join(root, "source-manifest.json"),
			JSON.stringify({ files }),
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

export async function immutableFile(path: string, content: string | Buffer) {
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, content, {
			flag: "wx",
			mode: 0o600,
			flush: true,
		});
		await link(temporary, path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		if (!(await readFile(path)).equals(Buffer.from(content)))
			throw new Error(
				"Saved release evidence differs from the immutable candidate.",
			);
	} finally {
		await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
		});
	}
}
