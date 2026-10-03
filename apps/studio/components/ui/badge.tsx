/* eslint-disable react-doctor/only-export-components -- the CVA variant factory is part of this UI primitive's public styling contract */
import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
	/* Sheet chips/pills (see /demos/components → StatusTag/TagChip). Border
	   and radius live on the variants — surface-chip carries its own. */
	"inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden px-2 py-0.5 text-meta font-medium whitespace-nowrap transition-[color,box-shadow] outline-none aria-invalid:border-destructive [&>svg]:pointer-events-none",
	{
		variants: {
			variant: {
				default:
					"surface-chip rounded-lg text-secondary-foreground [a&]:hover:bg-chip-hover",
				secondary:
					"surface-chip rounded-lg text-secondary-foreground [a&]:hover:bg-chip-hover",
				destructive:
					"rounded-full border-[0.714px] border-tag-accent bg-card bg-[image:radial-gradient(130%_170%_at_50%_0%,color-mix(in_srgb,var(--tag-accent)_20%,transparent),transparent_70%)] text-foreground dark:bg-destructive/20 dark:bg-none",
				outline:
					"rounded-full border-[0.714px] border-border text-foreground [a&]:hover:bg-accent [a&]:hover:text-accent-foreground",
				ghost:
					"rounded-full border-[0.714px] border-transparent [a&]:hover:bg-accent [a&]:hover:text-accent-foreground",
				link: "text-primary underline-offset-4 [a&]:hover:underline",
			},
		},
		defaultVariants: {
			variant: "default",
		},
	},
);

function Badge({
	className,
	variant = "default",
	render,
	...props
}: useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
	return useRender({
		defaultTagName: "span",
		render,
		props: mergeProps<"span">(
			{
				"data-slot": "badge",
				"data-variant": variant,
				className: cn(badgeVariants({ variant }), className),
			} as React.ComponentProps<"span">,
			props,
		),
	});
}

export { Badge, badgeVariants };
