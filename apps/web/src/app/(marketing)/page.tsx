import { SiteHeader } from "@/components/marketing/layout/site-header";
import { SiteFooter } from "@/components/marketing/layout/site-footer";
import { ScrollGutter } from "@/components/marketing/motion/scroll-gutter";
import { Hero } from "@/components/marketing/sections/hero";
import { Lifecycle } from "@/components/marketing/sections/lifecycle";
import { Evidence } from "@/components/marketing/sections/evidence";
import { Capabilities } from "@/components/marketing/sections/capabilities";
import { Regeneration } from "@/components/marketing/sections/regeneration";
import { Ci } from "@/components/marketing/sections/ci";
import { Scale } from "@/components/marketing/sections/scale";
import { Testimonials } from "@/components/marketing/sections/testimonials";
import { Pricing } from "@/components/marketing/sections/pricing";
import { FaqSection } from "@/components/marketing/sections/faq";
import { Closing } from "@/components/marketing/sections/closing";
import { JsonLd, landingStructuredData } from "@/lib/structured-data";
import { sectionIds, sections } from "@/config/site";
import { SignedInRedirect } from "@/components/marketing/signed-in-redirect";

export default function HomePage() {
  return (
    <>
      {/* Signed-in visitors came here for the app, not the pitch — bounce them. */}
      <SignedInRedirect />
      <JsonLd data={landingStructuredData()} />
      {/* Sequenced panels start hidden for their animation; reveal them when scripts are off. */}
      <noscript>
        <style>{`[class*="opacity-0"]{opacity:1!important;transform:none!important;filter:none!important}`}</style>
      </noscript>
      <a
        href="#main"
        className="fixed left-4 top-3 z-50 -translate-y-20 rounded-lg bg-approve px-3 py-2 text-sm font-semibold text-approve-ink focus:translate-y-0"
      >
        Skip to content
      </a>
      <ScrollGutter sections={sections} ids={sectionIds} />
      <div className="lg:pl-16">
        <SiteHeader />
        <main id="main">
          <Hero />
          <Lifecycle />
          <Evidence />
          <Capabilities />
          <Regeneration />
          <Ci />
          <Scale />
          <Testimonials />
          <Pricing />
          <FaqSection />
          <Closing />
        </main>
        <SiteFooter />
      </div>
    </>
  );
}
