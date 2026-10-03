import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";
export default defineConfig({
	output: "static",
	devToolbar: { enabled: false },
	server: { host: true, port: 3000 },
	vite: { plugins: [tailwindcss()], server: { allowedHosts: true } },
});
