import { nav, site } from "@/config/site";
import { Logo } from "@/components/marketing/ui/logo";

export function SiteFooter() {
  return (
    <footer className="border-t border-line">
      <div className="mkt-shell flex flex-col gap-10 py-14 md:flex-row md:items-start md:justify-between">
        <div className="flex max-w-sm flex-col gap-4">
          <Logo />
          <p className="text-sm leading-relaxed text-muted">{site.tagline}</p>
        </div>
        <nav aria-label="Footer" className="grid grid-cols-2 gap-x-14 gap-y-3 text-sm sm:grid-cols-3">
          {nav.map((item) => (
            <a key={item.href} href={item.href} className="text-dim hover:text-fg">
              {item.label}
            </a>
          ))}
          <a href={site.links.signin} className="text-dim hover:text-fg">
            Sign in
          </a>
          <a href={site.links.signup} className="text-dim hover:text-fg">
            Create organization
          </a>
        </nav>
      </div>
      <div className="mkt-shell flex flex-col justify-between gap-2 border-t border-line py-6 font-mono text-xs text-muted sm:flex-row">
        <span>© {new Date().getFullYear()} ProoflineQA</span>
        <span>Product screens use demonstration data. Testimonials are placeholders until launch.</span>
      </div>
    </footer>
  );
}
