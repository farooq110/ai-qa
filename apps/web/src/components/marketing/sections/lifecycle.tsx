import { lifecycle } from "@/content/lifecycle";
import { SectionHeading } from "@/components/marketing/ui/section-heading";
import { LifecycleScroller } from "@/components/marketing/motion/lifecycle-scroller";

export function Lifecycle() {
  return (
    <section id="review" aria-labelledby="review-title" className="border-t border-line py-24 md:py-32">
      <div className="mkt-shell">
        <SectionHeading id="review-title" title={lifecycle.heading} intro={lifecycle.intro} />
        <LifecycleScroller />
      </div>
    </section>
  );
}
