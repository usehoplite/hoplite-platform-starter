import { randomUUID } from "node:crypto";
import { scanBrand, type VisualBrief } from "./brand-scan";
import type { SourceFile } from "./hoplite";
import { releaseStorage } from "./release-storage";
import { database, save, saveBrandReference } from "./store";

let importing = false;
export async function migrateBrandStorage() {
	const db = await database();
	const records = db.brandImports || [];
	const updated: typeof records = [];
	for (const record of records)
		updated.push({
			...record,
			storage: await releaseStorage.migrateBrand(record),
		});
	if (!records.some((record) => !record.storage) || !releaseStorage.config)
		return;
	db.brandImports = updated;
	try {
		await save();
	} catch (error) {
		db.brandImports = records;
		throw error;
	}
}
export async function importBrand(url: string) {
	if (importing)
		throw new Error("A website reference is already being imported.");
	if (!url || url.length > 2048) throw new Error("Enter a website address.");
	importing = true;
	try {
		const { brief, files } = await scanBrand(url);
		const storage = await releaseStorage.saveBrand(brief.id, files);
		const db = await database();
		const previous = db.brandImports;
		db.brandImports = [
			...(previous || []),
			{
				id: brief.id,
				sourceUrl: brief.sourceUrl,
				createdAt: brief.capturedAt,
				storage,
			},
		];
		try {
			await save();
		} catch (error) {
			db.brandImports = previous;
			throw error;
		}
		return brief;
	} finally {
		importing = false;
	}
}
export async function brandBrief(importId: string): Promise<VisualBrief> {
	const record = (await database()).brandImports?.find(
		(item) => item.id === importId,
	);
	if (!record) throw new Error("Website reference not found.");
	return JSON.parse(
		(await releaseStorage.readBrand(record, "visual-brief.json")).toString(),
	);
}
export async function approveBrand(importId: string, assetIds: string[]) {
	const brief = await brandBrief(importId);
	if (
		assetIds.length > 12 ||
		new Set(assetIds).size !== assetIds.length ||
		assetIds.some((id) => !brief.assets.some((asset) => asset.id === id))
	)
		throw new Error("Choose assets from this saved website reference.");
	const reference = {
		id: randomUUID(),
		importId,
		assetIds,
		createdAt: new Date().toISOString(),
	};
	await saveBrandReference(reference);
	return reference;
}
export async function brandState() {
	const db = await database();
	const latest = db.brandImports?.at(-1);
	const selected = db.brandReferences?.find(
		(item) => item.id === db.brandReferenceId,
	);
	return {
		brief: latest ? await brandBrief(latest.id) : null,
		activeBrief: selected ? await brandBrief(selected.importId) : null,
		selected: selected || null,
	};
}
export async function brandContext(referenceId?: string) {
	if (!referenceId) return;
	const db = await database();
	const reference = db.brandReferences?.find((item) => item.id === referenceId);
	if (!reference) throw new Error("Saved brand reference is unavailable.");
	const brief = await brandBrief(reference.importId);
	const selected = new Set(reference.assetIds);
	return {
		reference,
		brief,
		assets: brief.assets.filter((asset) => selected.has(asset.id)),
	};
}
export async function brandFiles(referenceId?: string): Promise<SourceFile[]> {
	const context = await brandContext(referenceId);
	if (!context) return [];
	const db = await database();
	const record = db.brandImports?.find(
		(item) => item.id === context.reference.importId,
	);
	if (!record) throw new Error("Saved brand reference is unavailable.");
	return Promise.all(
		context.assets.map(async (asset) => ({
			path: `public/brand-assets/${asset.id}.png`,
			encoding: "base64" as const,
			content: (await releaseStorage.readBrand(record, asset.path)).toString(
				"base64",
			),
		})),
	);
}
