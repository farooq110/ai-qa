import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

type Variant = "approve" | "secondary" | "ghost";

const variants: Record<Variant, string> = {
  approve:
    "bg-approve text-approve-ink shadow-[0_1px_0_0_rgb(255_255_255/0.35)_inset,0_10px_30px_-10px_rgb(53_208_143/0.55)] hover:bg-[#4fe0a1] active:translate-y-px",
  secondary: "border border-line-strong bg-raised text-fg hover:border-[#3b4950] hover:bg-[#1a2228]",
  ghost: "text-dim hover:text-fg"
};

type ButtonLinkProps = ComponentProps<"a"> & {
  variant?: Variant;
  icon?: ReactNode;
  size?: "md" | "lg";
};

export function ButtonLink({ variant = "approve", icon, size = "md", className = "", href, children, ...rest }: ButtonLinkProps) {
  const sizing = size === "lg" ? "h-12 px-5 text-[15px]" : "h-9 px-3.5 text-sm";
  return (
    <Link
      className={`group inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg font-semibold transition-[background-color,border-color,color,transform] duration-200 ease-out ${sizing} ${variants[variant]} ${className}`}
      href={href as string}
      {...rest}
    >
      {icon}
      {children}
    </Link>
  );
}
