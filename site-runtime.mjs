#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Installed alongside the pinned dependencies and manifest in the custom sandbox image.
// This command deliberately has no package installation or fallback path.
const runtime = dirname(await realpath(fileURLToPath(import.meta.url)));
const mode = process.argv[2];
if (!["dev", "check", "build"].includes(mode) || process.argv.length !== 3)
	throw new Error("Usage: studio-site-v2 dev|check|build");
const manifest = JSON.parse(
	await readFile(join(runtime, "protected-files.json"), "utf8"),
);
// A path may list several accepted revisions of the same Studio-owned file.
for (const [path, expected] of Object.entries(manifest)) {
	const file = await readFile(join(process.cwd(), path));
	if (
		![expected].flat().includes(createHash("sha256").update(file).digest("hex"))
	)
		throw new Error(`The Studio-owned ${path} was changed.`);
}
const dependencies = join(runtime, "node_modules");
const localDependencies = join(process.cwd(), "node_modules");
try {
	await lstat(localDependencies);
	if ((await realpath(localDependencies)) !== (await realpath(dependencies)))
		throw new Error(
			"Use the preinstalled Site Studio dependencies; remove the local installation.",
		);
} catch (error) {
	if (error.code !== "ENOENT") throw error;
	await symlink(dependencies, localDependencies, "dir");
}
const env = {
	PATH: process.env.PATH,
	HOME: process.env.HOME,
	TMPDIR: process.env.TMPDIR,
	LANG: process.env.LANG || "C.UTF-8",
	ASTRO_TELEMETRY_DISABLED: "1",
};
// Generated source receives no model credentials or control-plane environment.
for (const command of mode === "build" ? ["check", "build"] : [mode]) {
	const child = spawn(
		process.execPath,
		[join(dependencies, "astro/bin/astro.mjs"), command],
		{ env, stdio: "inherit" },
	);
	const interrupt = () => child.kill("SIGINT");
	const terminate = () => child.kill("SIGTERM");
	process.once("SIGINT", interrupt);
	process.once("SIGTERM", terminate);
	const code = await new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code) => resolve(code ?? 1));
	});
	process.removeListener("SIGINT", interrupt);
	process.removeListener("SIGTERM", terminate);
	if (code !== 0) process.exit(code);
}
