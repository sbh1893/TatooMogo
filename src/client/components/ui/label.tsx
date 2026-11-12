import type * as React from "react";
import { cn } from "@/lib/utils";

// shadcn's Label without the Radix dependency: a native <label> does the same job here.
function Label({ className, ...props }: React.ComponentProps<"label">) {
  return (
    <label
      data-slot="label"
      className={cn("flex items-center gap-2 text-sm leading-none font-medium select-none", className)}
      {...props}
    />
  );
}

export { Label };
