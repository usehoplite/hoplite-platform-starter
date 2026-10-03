import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
	title: "Site Studio",
	icons: { icon: "/studio-logo.svg" },
	description: "Create a site that feels like your business.",
};
export default function RootLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	return (
		<html lang="en">
			<body>{children}</body>
		</html>
	);
}
