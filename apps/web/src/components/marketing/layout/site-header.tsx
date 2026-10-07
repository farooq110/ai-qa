import { CircleCheck, CreditCard, FileCode, GitPullRequest, Menu, MessageSquare } from "lucide-react";
import { nav, sectionIds, site } from "@/config/site";
import { lifecycle } from "@/content/lifecycle";
import { evidence } from "@/content/evidence";
import { ci } from "@/content/ci";
import { pricing } from "@/content/pricing";
import { faqs } from "@/content/faq";
import { ButtonLink } from "@/components/marketing/ui/button-link";
import { Logo } from "@/components/marketing/ui/logo";
import { HeaderTabs, type HeaderTab } from "@/components/marketing/motion/header-tabs";

const tabs: readonly HeaderTab[] = [
  { href: "#review", label: "Review", count: lifecycle.stages.length, icon: <GitPullRequest size={15} aria-hidden /> },
  { href: "#evidence", label: "Evidence", count: evidence.steps.length, icon: <FileCode size={15} aria-hidden /> },
  { href: "#checks", label: "Checks", count: ci.pipeline.length, icon: <CircleCheck size={15} aria-hidden /> },
  { href: "#pricing", label: "Pricing", count: pricing.plans.length, icon: <CreditCard size={15} aria-hidden /> },
  { href: "#faq", label: "FAQ", count: faqs.length, icon: <MessageSquare size={15} aria-hidden /> }
];

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-ground/85 backdrop-blur-md supports-[backdrop-filter]:bg-ground/70">
      <div className="mkt-shell flex h-16 items-center gap-5">
        <a href="#top" aria-label="Proofline home" className="rounded-md">
          <Logo />
        </a>

        <nav aria-label="Primary" className="hidden h-full md:block">
          <HeaderTabs tabs={tabs} ids={sectionIds} />
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <span className="hidden sm:contents">
            <ButtonLink href={site.links.signin} variant="ghost">
              Sign in
            </ButtonLink>
          </span>
          <ButtonLink href={site.links.signup}>Start free</ButtonLink>

          <details className="group relative md:hidden">
            <summary
              aria-label="Open menu"
              className="flex size-9 cursor-pointer list-none items-center justify-center rounded-lg border border-line-strong text-dim [&::-webkit-details-marker]:hidden"
            >
              <Menu size={18} aria-hidden />
            </summary>
            <nav aria-label="Mobile" className="mkt-panel absolute right-0 top-12 w-56 p-2">
              <ul className="flex flex-col">
                {nav.map((item) => (
                  <li key={item.href}>
                    <a href={item.href} className="block rounded-md px-3 py-2.5 text-[15px] text-dim hover:bg-raised hover:text-fg">
                      {item.label}
                    </a>
                  </li>
                ))}
                <li className="mt-1 border-t border-line pt-1">
                  <a href={site.links.signin} className="block rounded-md px-3 py-2.5 text-[15px] text-dim hover:bg-raised hover:text-fg">
                    Sign in
                  </a>
                </li>
              </ul>
            </nav>
          </details>
        </div>
      </div>
    </header>
  );
}
