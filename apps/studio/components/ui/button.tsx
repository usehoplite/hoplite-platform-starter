/* eslint-disable react-doctor/only-export-components -- the CVA variant factory is part of this UI primitive's public styling contract */
import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
	"inline-flex shrink-0 items-center justify-center gap-2 rounded-lg text-body font-medium whitespace-nowrap transition-[color,background-color,filter] disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0",
	{
		variants: {
			variant: {
				/* Sheet recipes (see /demos/components → Button). Solid chips
           can't take a grey focus fill, so they brighten instead; the
           whole set presses down 0.5px on :active — the letterpress
           "key click". */
				default:
					"surface-chip-dark hover:brightness-125 focus-visible:brightness-125 active:translate-y-[0.5px]",
				destructive:
					"surface-chip-destructive hover:brightness-110 focus-visible:brightness-110 active:translate-y-[0.5px]",
				/* The one saturated key on a screen: New thread, send. */
				action:
					"surface-chip-action hover:brightness-110 focus-visible:brightness-110 active:translate-y-[0.5px]",
				outline:
					"border border-border text-secondary-foreground hover:bg-black/[0.03] focus-visible:bg-black/[0.05] active:translate-y-[0.5px] active:bg-black/[0.05] dark:hover:bg-white/[0.06] dark:focus-visible:bg-white/[0.08] dark:active:bg-white/[0.1]",
				secondary:
					"surface-chip text-secondary-foreground hover:bg-chip-hover focus-visible:bg-chip-hover active:translate-y-[0.5px] active:bg-chip-down",
				ghost:
					"hover:bg-black/[0.04] focus-visible:bg-black/[0.05] active:translate-y-[0.5px] active:bg-black/[0.06] dark:hover:bg-white/[0.06] dark:focus-visible:bg-white/[0.08] dark:active:bg-white/[0.12]",
				link: "text-primary underline decoration-foreground/30 underline-offset-[3px] hover:decoration-foreground focus-visible:decoration-foreground",
			},
			size: {
				default: "h-9 px-4 py-2 has-[>svg]:px-3",
				xs: "h-6 gap-1 rounded-md px-2 text-meta has-[>svg]:px-1.5",
				sm: "h-8 gap-1.5 rounded-md px-3 has-[>svg]:px-2.5",
				lg: "h-10 rounded-full px-6 has-[>svg]:px-4",
				icon: "size-9",
				"icon-xs": "size-6 rounded-md",
				"icon-sm": "size-8",
				"icon-lg": "size-10",
			},
		},
		defaultVariants: {
			variant: "default",
			size: "default",
		},
	},
);

/* Polymorphic via `render` (Base UI's asChild): the default element is a
   native <button>, but `render={<a .../>}` renders a real link — Base UI's
   Button PRIMITIVE would force role="button" onto that anchor, so we compose
   with useRender instead to keep link semantics for the many link-styled
   buttons in the app. */
function Button({
	className,
	variant = "default",
	size = "default",
	render,
	...props
}: useRender.ComponentProps<"button"> & VariantProps<typeof buttonVariants>) {
	return useRender({
		defaultTagName: "button",
		render,
		props: mergeProps<"button">(
			{
				"data-slot": "button",
				"data-variant": variant,
				"data-size": size,
				className: cn(buttonVariants({ variant, size, className })),
			} as React.ComponentProps<"button">,
			props,
		),
	});
}

export { Button, buttonVariants };
