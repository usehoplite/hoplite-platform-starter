import { useId } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export const metadata = { title: "Sign in — Site Studio" };

const errors: Record<string, string> = {
	invalid: "That password isn’t right. Please try again.",
	limited: "Too many attempts. Please wait a few minutes and try again.",
};

function LoginForm({ message, next }: { message?: string; next: string }) {
	const passwordId = useId();
	return (
		<form className="business-form login-form" method="post" action="/login">
			<img
				className="brand-mark"
				src="/studio-logo.svg"
				alt=""
				width={29}
				height={29}
			/>
			<div className="panel-intro">
				<span className="section-kicker">SITE STUDIO</span>
				<h1>Sign in</h1>
				<p>Enter the access password to open your website studio.</p>
			</div>
			{message && (
				<p className="error-message" role="alert">
					{message}
				</p>
			)}
			<input type="hidden" name="next" value={next} />
			<label htmlFor={passwordId}>
				Password
				<Input
					id={passwordId}
					name="password"
					type="password"
					autoComplete="current-password"
					required
				/>
			</label>
			<Button type="submit" variant="action">
				Sign in
			</Button>
		</form>
	);
}

/**
 * Shared-password sign-in for a hosted demo. The server only serves this
 * page when STUDIO_ACCESS_PASSWORD is set, and handles the form post itself.
 */
export default async function LoginPage({ searchParams }: PageProps<"/login">) {
	const { error, next } = await searchParams;
	return (
		<main className="details-scroll">
			<LoginForm
				message={typeof error === "string" ? errors[error] : undefined}
				next={typeof next === "string" ? next : "/"}
			/>
		</main>
	);
}
