import { resolve } from "node:path";
import type { NextConfig } from "next";

const config: NextConfig = {
	turbopack: { root: resolve(import.meta.dirname, "../..") },
	devIndicators: false,
	poweredByHeader: false,
};
export default config;
