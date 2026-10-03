import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import sharp from "sharp";
import { PublicFetcher } from "./public-fetch";
import { sha256 } from "./safety";

export type VisualBrief = {
	id: string;
	sourceUrl: string;
	capturedAt: string;
	title: string;
	palette: { color: string; samples: number }[];
	typography: {
		family: string;
		size: string;
		weight: string;
		samples: number;
	}[];
	layout: {
		sections: number;
		contentWidth: number;
		viewport: { width: number; height: number };
		headingExamples: string[];
	};
	assets: {
		id: string;
		path: string;
		sourceUrl: string;
		label: string;
		width: number;
		height: number;
		sha256: string;
	}[];
	warnings: string[];
};

export async function scanBrand(input: string, fetcher = new PublicFetcher()) {
	const initialResponse = await fetcher.fetch(input);
	if (
		initialResponse.status !== 200 ||
		!initialResponse.headers["content-type"]?.includes("text/html")
	)
		throw new Error("The website did not return a public HTML page.");
	const resources = new Map<string, Promise<typeof initialResponse>>();
	resources.set(initialResponse.url, Promise.resolve(initialResponse));
	const downloaded = new Map<string, typeof initialResponse>();
	const warnings = new Set<string>();
	const browser = await chromium.launch({
		channel: "chrome",
		headless: true,
		handleSIGINT: false,
		handleSIGTERM: false,
	});
	try {
		const context = await browser.newContext({
			javaScriptEnabled: false,
			serviceWorkers: "block",
			acceptDownloads: false,
			viewport: { width: 1440, height: 900 },
		});
		await context.routeWebSocket("**/*", (socket) => socket.close());
		await context.route("**/*", async (route) => {
			const request = route.request();
			if (
				request.method() !== "GET" ||
				!["document", "stylesheet", "image", "font"].includes(
					request.resourceType(),
				)
			) {
				await route.abort();
				return;
			}
			try {
				const url = request.url();
				let pending = resources.get(url);
				if (!pending) {
					pending = fetcher.fetch(url);
					resources.set(url, pending);
				}
				const response = await pending;
				downloaded.set(response.url, response);
				resources.set(response.url, Promise.resolve(response));
				if (response.url !== url) {
					await route.fulfill({
						status: 302,
						headers: { location: response.url },
						body: "",
					});
					return;
				}
				await route.fulfill({
					status: response.status,
					headers: response.headers,
					body: response.body,
				});
			} catch {
				warnings.add(
					"Some website resources could not be imported. Review the saved reference before using it.",
				);
				await route.abort().catch(() => undefined);
			}
		});
		const page = await context.newPage();
		await page.goto(initialResponse.url, {
			waitUntil: "load",
			timeout: 30_000,
		});
		const appearance = await page.evaluate(() => {
			const colors = new Map<string, number>();
			const fonts = new Map<
				string,
				{ family: string; size: string; weight: string; samples: number }
			>();
			const images: {
				url: string;
				label: string;
				width: number;
				height: number;
			}[] = [];
			for (const element of [
				...document.querySelectorAll("body, body *"),
			].slice(0, 1200)) {
				const bounds = element.getBoundingClientRect();
				if (bounds.width < 1 || bounds.height < 1) continue;
				const style = getComputedStyle(element);
				for (const color of [style.color, style.backgroundColor])
					if (color !== "rgba(0, 0, 0, 0)")
						colors.set(color, (colors.get(color) || 0) + 1);
				if (element.textContent?.trim()) {
					const key = `${style.fontFamily}|${style.fontSize}|${style.fontWeight}`;
					const font = fonts.get(key) || {
						family: style.fontFamily,
						size: style.fontSize,
						weight: style.fontWeight,
						samples: 0,
					};
					font.samples++;
					fonts.set(key, font);
				}
				if (
					element instanceof HTMLImageElement &&
					element.currentSrc &&
					element.naturalWidth >= 40 &&
					element.naturalHeight >= 24
				)
					images.push({
						url: element.currentSrc,
						label: (element.alt || "Website image").slice(0, 100),
						width: element.naturalWidth,
						height: element.naturalHeight,
					});
				const background = style.backgroundImage.match(
					/^url\(["']?(.*?)["']?\)$/,
				)?.[1];
				if (background && bounds.width >= 80 && bounds.height >= 80)
					images.push({
						url: background,
						label: "Background image",
						width: Math.round(bounds.width),
						height: Math.round(bounds.height),
					});
			}
			return {
				title: document.title.slice(0, 160),
				palette: [...colors]
					.sort((a, b) => b[1] - a[1])
					.slice(0, 8)
					.map(([color, samples]) => ({ color, samples })),
				typography: [...fonts.values()]
					.sort((a, b) => b.samples - a.samples)
					.slice(0, 6),
				layout: {
					sections: document.querySelectorAll("main section, body > section")
						.length,
					contentWidth: Math.round(
						(
							document.querySelector("main") || document.body
						).getBoundingClientRect().width,
					),
					viewport: { width: innerWidth, height: innerHeight },
					headingExamples: [...document.querySelectorAll("h1, h2")]
						.slice(0, 8)
						.map((element) => element.textContent?.trim().slice(0, 140) || ""),
				},
				images: [
					...new Map(images.map((image) => [image.url, image])).values(),
				].slice(0, 12),
				textLength: document.body.innerText.trim().length,
			};
		});
		if (appearance.textLength < 20)
			throw new Error(
				"This website needs client-side scripts to show its content. Use a public page that renders without scripts.",
			);
		const files: { path: string; body: Buffer }[] = [
			{
				path: "reference.png",
				body: await page.screenshot({
					animations: "disabled",
					timeout: 10_000,
				}),
			},
		];
		const assets: VisualBrief["assets"] = [];
		for (const image of appearance.images) {
			try {
				const response = downloaded.get(image.url);
				if (
					!response ||
					response.status !== 200 ||
					!response.headers["content-type"]?.startsWith("image/")
				)
					continue;
				if (
					response.headers["content-type"].includes("svg") &&
					/<!DOCTYPE|<!ENTITY|<script|(?:href|url)\s*[=(]\s*["']?(?:https?:|file:|\/\/)/i.test(
						response.body.toString(),
					)
				)
					throw new Error("External references in vector image");
				const { data, info } = await sharp(response.body, {
					limitInputPixels: 24_000_000,
					failOn: "warning",
				})
					.rotate()
					.resize({
						width: 1600,
						height: 1600,
						fit: "inside",
						withoutEnlargement: true,
					})
					.png()
					.toBuffer({ resolveWithObject: true });
				if (data.length > 4 * 1024 * 1024)
					throw new Error("Image is too large");
				const hash = sha256(data);
				if (assets.some((asset) => asset.sha256 === hash)) continue;
				const path = `assets/${hash}.png`;
				files.push({ path, body: data });
				assets.push({
					id: hash,
					path,
					sourceUrl: response.url,
					label: image.label,
					width: info.width,
					height: info.height,
					sha256: hash,
				});
			} catch {
				warnings.add(`An image could not be safely copied: ${image.label}`);
			}
		}
		const brief: VisualBrief = {
			id: randomUUID(),
			sourceUrl: initialResponse.url,
			capturedAt: new Date().toISOString(),
			title: appearance.title,
			palette: appearance.palette,
			typography: appearance.typography,
			layout: appearance.layout,
			assets,
			warnings: [...warnings],
		};
		files.push({
			path: "visual-brief.json",
			body: Buffer.from(JSON.stringify(brief)),
		});
		return { brief, files };
	} finally {
		await browser.close();
	}
}
