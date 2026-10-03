import type * as React from "react";

import { cn } from "@/lib/utils";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
	return (
		<textarea
			data-slot="textarea"
			className={cn(
				/* Sheet recessed well, matching Input; focus is a border step. */
				"surface-well flex field-sizing-content min-h-16 w-full rounded-lg px-3 py-2 text-body transition-[border-color] outline-none placeholder:text-placeholder focus-visible:border-ring disabled:cursor-not-allowed disabled:opacity-60 aria-invalid:border-destructive",
				className,
			)}
			{...props}
		/>
	);
}

export { Textarea };
