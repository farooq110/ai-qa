import { SiteHeader } from "@/components/layout/site-header";
import { SiteFooter } from "@/components/layout/site-footer";
import { ScrollGutter } from "@/components/motion/scroll-gutter";
import { Hero } from "@/components/sections/hero";
import { Lifecycle } from "@/components/sections/lifecycle";
import { Evidence } from "@/components/sections/evidence";
import { Capabilities } from "@/components/sections/capabilities";
import { Regeneration } from "@/components/sections/regeneration";
import { Ci } from "@/components/sections/ci";
import { Scale } from "@/components/sections/scale";
import { Testimonials } from "@/components/sections/testimonials";
import { Pricing } from "@/components/sections/pricing";
import { FaqSection } from "@/components/sections/faq";
import { Closing } from "@/components/sections/closing";
import { JsonLd, landingStructuredData } from "@/lib/structured-data";
import { sectionIds, sections } from "@/config/site";


export default function HomePage() {
  return (
    <>
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
