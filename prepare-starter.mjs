// Writes the files a preinstalled "starter version 2" sandbox image needs into
// an empty directory: the pinned package manifest and lockfile, the manifest of
// Studio-owned files the runtime verifies, and the runtime command itself.
// Hoplite builds custom sandbox images on request; see README.md, "Custom
// sandbox image". Run with: pnpm --filter site-studio starter:prepare <dir>
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("./", import.meta.url));
if (!process.argv[2] || process.argv.length !== 3)
	throw new Error("Usage: prepare-starter.mjs /absolute/runtime/directory");
const directory = resolve(process.argv[2]);
process.chdir(join(root, "apps/studio"));
const { seedFiles } = await import("./apps/studio/lib/service.ts");
const files = await seedFiles(undefined, "2", "blank", 4);
// Websites saved with earlier foundation revisions keep their original owned
// bytes, so the image accepts every revision's version of each owned file.
const previous = [
	await seedFiles(undefined, "2", "blank", 3),
	await seedFiles(undefined, "2", "blank", 2),
	await seedFiles(undefined, "2", "blank"),
];
const hash = (file) =>
	createHash("sha256")
		.update(Buffer.from(file.content, "base64"))
		.digest("hex");
const protectedFiles = files.filter(
	(file) => !file.path.endsWith(".astro") && file.path !== "public/site.css",
);
const manifest = Object.fromEntries(
	protectedFiles.map((file) => {
		const accepted = [
			...new Set([
				hash(file),
				...previous.flatMap((revision) =>
					revision
						.filter((item) => item.path === file.path)
						.map((item) => hash(item)),
				),
			]),
		];
		return [file.path, accepted.length === 1 ? accepted[0] : accepted];
	}),
);
const runtimeFiles = new Map([
	["package.json", await readFile("starter-v2/package.json")],
	["package-lock.json", await readFile("starter-v2/package-lock.json")],
	["protected-files.json", Buffer.from(JSON.stringify(manifest, null, 2))],
	["site-runtime.mjs", await readFile(join(root, "site-runtime.mjs"))],
]);
await mkdir(directory, { recursive: true });
for (const [name, content] of runtimeFiles)
	await writeFile(join(directory, name), content, { flag: "wx" });
process.stdout.write(`${directory}\n`);
