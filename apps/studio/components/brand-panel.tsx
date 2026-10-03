"use client";
import { Check, Image as ImageIcon, Loader2, Palette } from "lucide-react";
import { useId, useState } from "react";
import useSWR from "swr";
import type { VisualBrief } from "../lib/brand-scan";
import type { JsonValue } from "../lib/types";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

type BrandState = {
	brief: VisualBrief | null;
	activeBrief: VisualBrief | null;
	selected: { id: string; importId: string; assetIds: string[] } | null;
};
type Request = <T>(path: string, body?: JsonValue) => Promise<T>;
export function BrandPanel({
	request,
	onboarding = false,
	websiteCreated = false,
}: {
	request: Request;
	onboarding?: boolean;
	/** The reference is copied into the website when it is created. */
	websiteCreated?: boolean;
}) {
	const { data, error, mutate } = useSWR<BrandState>("/api/brand", request);
	const [url, setUrl] = useState("");
	const [importing, setImporting] = useState(false);
	const [failure, setFailure] = useState("");
	const id = useId();
	return (
		<section className="brand-panel business-form">
			<div className="panel-intro">
				<span className="section-kicker">
					{onboarding ? "STEP 2 · OPTIONAL" : "YOUR VISUAL REFERENCE"}
				</span>
				<h2>Bring your brand with you</h2>
				<p>
					{onboarding
						? "Already have a website? Use its colours, typography and images as a starting point. You can skip this step."
						: "Use your existing website’s colours, typography and images as a starting point."}{" "}
					Your business details stay authoritative.
				</p>
			</div>
			<form
				className="brand-import-form"
				action={async () => {
					setImporting(true);
					setFailure("");
					try {
						await request("/api/brand/import", { url });
						await mutate();
					} catch (error) {
						setFailure(
							error instanceof Error
								? error.message
								: "The website could not be imported.",
						);
					} finally {
						setImporting(false);
					}
				}}
			>
				<label htmlFor={id}>
					Existing website
					<Input
						id={id}
						type="url"
						placeholder="https://your-website.com"
						value={url}
						onChange={(event) => setUrl(event.target.value)}
						required
						disabled={importing}
					/>
				</label>
				<Button
					type="submit"
					variant="outline"
					disabled={importing || !url.trim()}
				>
					{importing ? <Loader2 className="spin" /> : <Palette />}
					{importing ? "Reading website…" : "Import website"}
				</Button>
			</form>
			{(failure || error) && (
				<p role="alert" className="error-message">
					{failure || error.message}
				</p>
			)}
			{data?.activeBrief && data.activeBrief.id !== data.brief?.id && (
				<section aria-label="Current approved reference">
					<h3>Currently selected</h3>
					<BrandSelection
						key={`${data.activeBrief.id}:${data.selected?.id}`}
						brief={data.activeBrief}
						selected={data.selected}
						request={request}
						websiteCreated={websiteCreated}
						refresh={async () => {
							await mutate();
						}}
					/>
				</section>
			)}
			{data?.brief && (
				<section aria-label="Latest imported reference">
					{data.selected?.importId !== data.brief.id && (
						<h3>New import — not applied</h3>
					)}
					<BrandSelection
						key={`${data.brief.id}:${data.selected?.importId === data.brief.id ? data.selected.id : "unapproved"}`}
						brief={data.brief}
						selected={data.selected}
						request={request}
						websiteCreated={websiteCreated}
						refresh={async () => {
							await mutate();
						}}
					/>
				</section>
			)}
		</section>
	);
}
function BrandSelection({
	brief,
	selected,
	request,
	websiteCreated,
	refresh,
}: {
	brief: VisualBrief;
	selected: BrandState["selected"];
	request: Request;
	websiteCreated: boolean;
	refresh: () => Promise<void>;
}) {
	const applied = selected?.importId === brief.id;
	const [assets, setAssets] = useState(
		applied ? selected.assetIds : ([] as string[]),
	);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState("");
	const savedAssets = new Set(selected?.assetIds);
	const chosenAssets = new Set(assets);
	const unchanged =
		applied &&
		assets.length === selected.assetIds.length &&
		assets.every((id) => savedAssets.has(id));
	const image = (path: string) =>
		`/api/brand/${brief.id}/file?path=${encodeURIComponent(path)}`;
	return (
		<div className="brand-reference">
			<img
				className="brand-reference-screen"
				src={image("reference.png")}
				alt={`Saved reference from ${brief.title}`}
				width={1440}
				height={900}
			/>
			<div className="brand-reference-heading">
				<strong>{brief.title || new URL(brief.sourceUrl).hostname}</strong>
				<span>
					{new URL(brief.sourceUrl).hostname} · Saved once, never hotlinked
				</span>
			</div>
			<ul className="brand-palette" aria-label="Imported colour palette">
				{brief.palette.map((sample) => (
					<li
						key={sample.color}
						style={{ backgroundColor: sample.color }}
						title={sample.color}
					/>
				))}
			</ul>
			<p className="brand-type-note">
				{[
					...new Set(
						brief.typography.map((font) =>
							font.family.split(",")[0].replaceAll('"', ""),
						),
					),
				]
					.slice(0, 3)
					.join(" · ")}
				. Fonts guide the look; the site uses approved local fonts.
			</p>
			{brief.assets.length > 0 ? (
				<>
					<h3>Choose images to reuse</h3>
					<p>Only select images you have permission to use.</p>
					<div className="brand-asset-grid">
						{brief.assets.map((asset) => (
							<label className="brand-asset" key={asset.id}>
								<img
									src={image(asset.path)}
									alt={asset.label}
									width={asset.width}
									height={asset.height}
								/>
								<span>
									<input
										type="checkbox"
										checked={chosenAssets.has(asset.id)}
										disabled={saving}
										onChange={(event) =>
											setAssets(
												event.target.checked
													? [...assets, asset.id]
													: assets.filter((id) => id !== asset.id),
											)
										}
									/>
									{asset.label}
								</span>
							</label>
						))}
					</div>
				</>
			) : (
				<div className="kit-note">
					<ImageIcon />
					<span>
						No reusable images were found. You can still use this visual
						reference.
					</span>
				</div>
			)}
			{brief.warnings.map((warning) => (
				<p className="brand-type-note" key={warning}>
					{warning}
				</p>
			))}
			{error && (
				<p className="error-message" role="alert">
					{error}
				</p>
			)}
			<Button
				disabled={saving || unchanged}
				onClick={async () => {
					setSaving(true);
					setError("");
					try {
						await request("/api/brand/approve", {
							importId: brief.id,
							assetIds: assets,
						});
						await refresh();
					} catch (error) {
						setError(
							error instanceof Error
								? error.message
								: "The reference could not be saved.",
						);
					} finally {
						setSaving(false);
					}
				}}
			>
				{saving ? (
					<Loader2 className="spin" />
				) : unchanged ? (
					<Check />
				) : (
					<Palette />
				)}
				{unchanged ? "Ready for your website" : "Use for my website"}
			</Button>
			<p className="brand-type-note">
				{websiteCreated
					? "Your website keeps the reference it was created with. To change its look, ask in the chat."
					: applied
						? "Your website will be created with this reference and your selected images."
						: "Apply this import when you want your website to use it. Your current reference stays selected until then."}
			</p>
		</div>
	);
}
