import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SourceFile } from "../lib/hoplite";
import { bytes, sourceGates } from "../lib/safety";

test("new sites pin the controlled starter in their own app while legacy sources keep their original contract", async () => {
	const root = await mkdtemp(join(tmpdir(), "studio-starter-"));
	process.env.STUDIO_DATA_DIR = root;
	process.env.STUDIO_STARTER_IMAGE = "im-starter-fixture";
	const { database } = await import("../lib/store");
	const {
		createSite,
		hoplite,
		seedFiles,
		previewGrant,
		workspacePolicy,
		sendMessage,
	} = await import("../lib/service");
	await database();
	Object.defineProperty(hoplite, "configured", { value: true });
	const apps: string[] = [];
	let imported = 0;
	const paths: string[] = [];
	hoplite.json = async <T>(
		path: string,
		body?: Parameters<typeof hoplite.json>[1],
		key?: string,
	): Promise<T> => {
		paths.push(path);
		if (path === "/api/platform/v1/apps") {
			assert.ok(body && typeof body === "object" && !Array.isArray(body));
			// One app per website, found again by its site id.
			assert.equal(key, `studio-app-${body.externalId}`);
			assert.equal(body.defaultModel, "claude-opus-5-5");
			assert.equal(body.previewPort, 3000);
			assert.equal(
				body &&
					typeof body === "object" &&
					!Array.isArray(body) &&
					body.runScript,
				"studio-site-v2 dev",
			);
			apps.push(String(body.externalId));
			return { app: { id: `app-${body.externalId}` } } as T;
		}
		if (path.endsWith("/sources")) {
			assert.ok(path.startsWith("/api/platform/v1/apps/app-"));
			assert.ok(body && typeof body === "object" && !Array.isArray(body));
			const files = body.files as SourceFile[];
			// No website starts with a photograph: the seed ships fonts only.
			assert.ok(
				!files.some((file) =>
					/\.(jpe?g|png|webp|avif|gif)$/i.test(file.path),
				),
			);
			const initial = files.find(
				(file) => file.path === "src/pages/index.astro",
			);
			assert.ok(initial);
			assert.match(bytes(initial).toString(), /data-studio-blank/);
			assert.doesNotMatch(
				bytes(initial).toString(),
				/harbour|hero-panel|Move well/i,
			);
			assert.equal(
				files.filter((file) => file.path.endsWith(".astro")).length,
				1,
			);
			imported++;
			return { source: { id: `source-${imported}` } } as T;
		}
		if (path.endsWith("/threads")) {
			assert.ok(body && typeof body === "object" && !Array.isArray(body));
			assert.match(String(body.prompt), /studio-site-v2 build/);
			assert.doesNotMatch(String(body.prompt), /npm install/);
			assert.match(String(body.prompt), /INITIAL WEBSITE/);
			assert.match(String(body.prompt), /consent with value="yes"/);
			assert.match(
				String(body.prompt),
				/no technical or website-design knowledge/,
			);
			assert.doesNotMatch(
				String(body.prompt),
				/Use the existing starter style/,
			);
			return {
				thread: { id: `thread-${imported}` },
				run: { id: `run-${imported}` },
			} as T;
		}
		if (path.endsWith("/messages")) {
			assert.ok(body && typeof body === "object" && !Array.isArray(body));
			assert.match(String(body.content), /EDIT: Update this website/);
			assert.doesNotMatch(String(body.content), /INITIAL WEBSITE/);
			return { run: { id: "edit-run" } } as T;
		}
		if (path.includes("/preview"))
			return { preview: { status: "stopped" } } as T;
		if (path.endsWith("/workspace/policy")) return { policy: null } as T;
		throw new Error(`Unexpected request ${path}`);
	};
	try {
		// Each organisation has one website: a repeated create cannot add another.
		const [created, repeated] = await Promise.allSettled([
			createSite("Create a site"),
			createSite("Create another"),
		]);
		assert.ok(created.status === "fulfilled");
		assert.ok(repeated.status === "rejected");
		assert.match(String(repeated.reason), /already exists/);
		const first = created.value;
		assert.deepEqual(apps, [first.id]);
		assert.equal((await database()).sites.length, 1);
		for (const site of [first]) {
			assert.equal(site.starterVersion, "2");
			assert.equal(site.designSeed, "blank");
			assert.equal(site.appId, `app-${site.id}`);
			await previewGrant(site);
			assert.ok(
				paths.at(-1)?.startsWith(`/api/platform/v1/apps/app-${site.id}/`),
			);
			await workspacePolicy(site);
		}
		const legacy = {
			...first,
			starterVersion: undefined,
			appId: "legacy-app",
		};
		await previewGrant(legacy);
		assert.ok(paths.at(-1)?.includes("legacy-app"));
		const saved = JSON.parse(
			await readFile(join(root, "metadata.json"), "utf8"),
		);
		assert.equal(saved.sites[0].starterVersion, "2");
		assert.equal(saved.sites[0].appId, `app-${saved.sites[0].id}`);
		first.phase = "idle";
		first.activeVersionId = "ready-version";
		await sendMessage(first, "Make the heading friendlier");
		const blank = await seedFiles(undefined, "2", "blank");
		assert.deepEqual(sourceGates(blank, blank), [
			"Replace the unfinished website placeholder in src/pages/index.astro",
		]);
		const old = await seedFiles();
		const current = await seedFiles(undefined, "2");
		const workspace = join(root, "export-workspace");
		await mkdir(workspace);
		execFileSync("git", ["init", "-q", workspace]);
		const ignore = current.find((file) => file.path === ".gitignore");
		assert.ok(ignore);
		await writeFile(join(workspace, ".gitignore"), bytes(ignore));
		await writeFile(
			join(workspace, "index.astro"),
			"<h1>Preserve this source</h1>",
		);
		await symlink(
			"/opt/studio-site-v2/node_modules",
			join(workspace, "node_modules"),
			"dir",
		);
		const exported = execFileSync(
			"git",
			["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
			{ cwd: workspace, encoding: "utf8" },
		)
			.split("\0")
			.filter(Boolean);
		assert.deepEqual(
			exported.sort(),
			[".gitignore", "index.astro"],
			"Source export must exclude the preinstalled dependency link without hiding website source",
		);
		assert.deepEqual(sourceGates(old, old), []);
		assert.deepEqual(sourceGates(current, current), []);
		for (const seed of [old, current]) {
			assert.ok(
				sourceGates(
					[
						...seed,
						{ path: "public/custom.js", content: "alert('unapproved')" },
					],
					seed,
				).some((error) => error.includes("public/custom.js")),
			);
			assert.ok(
				sourceGates(
					seed.map((file) =>
						file.path === "public/assets/geist.woff2"
							? { path: file.path, content: "changed asset" }
							: file,
					),
					seed,
				).some((error) => error.includes("public/assets/geist.woff2")),
			);
			// The sample website is typography and colour only.
			assert.deepEqual(
				seed
					.map((file) => file.path)
					.filter((path) => /\.(jpe?g|png|webp|avif|gif)$/i.test(path)),
				[],
			);
			for (const page of seed.filter((file) => file.path.endsWith(".astro")))
				assert.doesNotMatch(bytes(page).toString(), /<img\b|\/assets\/[^"']+\.jpg/);
		}
		const contact = current.find(
			(file) => file.path === "src/pages/contact.astro",
		);
		assert.ok(contact);
		for (const value of ["", 'value="on"', 'value="true"', 'value={"yes"}']) {
			const candidate = current.filter((file) => file.path !== contact.path);
			candidate.push({
				path: contact.path,
				content: bytes(contact).toString().replace('value="yes"', value),
			});
			assert.ok(
				sourceGates(candidate, current).some((error) =>
					error.includes(
						'Set the consent input in src/pages/contact.astro to value="yes"',
					),
				),
				`Reject consent values the real lead endpoint cannot accept: ${value}`,
			);
		}
		const page = current.find((file) => file.path === "src/pages/index.astro");
		assert.ok(page);
		const markup = bytes(page)
			.toString()
			.replace(/^---[\s\S]*?---\n/, "");
		for (const frontmatter of [
			"",
			'// import "../styles/tailwind.css";',
			'/* import "../styles/tailwind.css"; */',
			'const example = `import "../styles/tailwind.css";`;',
			'import "../styles/other.css";',
			'import("../styles/tailwind.css");',
		]) {
			for (const path of [page.path, "src/pages/new.astro"]) {
				const changed = current.filter((file) => file.path !== path);
				changed.push({
					path,
					content: `---\n${frontmatter}\n---\n${markup}<!-- import "../styles/tailwind.css"; -->`,
				});
				assert.ok(
					sourceGates(changed, current).some((error) =>
						error.includes(`Start the frontmatter of ${path}`),
					),
					`Reject missing or spoofed import: ${frontmatter}`,
				);
			}
		}
		for (const frontmatter of [
			'import "../styles/tailwind.css";',
			"  import '../styles/tailwind.css';\nconst title = 'Home';",
			'import "../styles/tailwind.css"',
		]) {
			assert.deepEqual(
				sourceGates(
					current.map(
						(file): SourceFile =>
							file.path === page.path
								? {
										path: file.path,
										content: `---\n${frontmatter}\n---\n${markup}`,
									}
								: file,
					),
					current,
				),
				[],
			);
		}
		const legacyPackage = old.find((file) => file.path === "package.json");
		assert.ok(legacyPackage);
		assert.equal(
			JSON.parse(bytes(legacyPackage).toString()).dependencies.astro,
			"5.13.5",
		);
		for (const path of [
			"package-lock.json",
			".gitignore",
			"tsconfig.json",
			"src/styles/tailwind.css",
			"studio-starter.json",
		]) {
			const changed = current.map((file) =>
				file.path === path
					? { ...file, encoding: "utf8" as const, content: "changed" }
					: file,
			);
			assert.ok(
				sourceGates(changed, current).some((error) =>
					error.includes(`owned ${path}`),
				),
			);
			assert.ok(
				sourceGates(
					current.filter((file) => file.path !== path),
					current,
				).some((error) => error.includes(`owned ${path}`)),
			);
		}
		for (const path of [
			".npmrc",
			"pnpm-lock.yaml",
			"src/pages/api/test.ts",
			"public/track.js",
		]) {
			assert.ok(
				sourceGates([...current, { path, content: "" }], current).some(
					(error) => error.includes("Unapproved starter file"),
				),
			);
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
