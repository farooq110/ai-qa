import { Check } from "lucide-react";
import { pricing } from "@/content/pricing";
import { fetchPlans } from "@/lib/plans";
import { PricingGrid, type PricingCard } from "./pricing-grid";
import { SectionHeading } from "@/components/marketing/ui/section-heading";

export async function Pricing() {
  const live = await fetchPlans();
  // Live plans (price, slots) override the static copy by key; Enterprise and any API outage keep the static card.
  const cards: PricingCard[] = pricing.plans.map((plan) => {
    const api = live?.find((p) => p.key === plan.id);
    return api ? { ...plan, slots: String(api.executionSlotLimit), prices: api.prices } : { ...plan };
  });
  return (
    <section id="pricing" aria-labelledby="pricing-title" className="border-t border-line bg-sunken py-24 md:py-32">
      <div className="mkt-shell flex flex-col gap-14">
        <SectionHeading id="pricing-title" title={pricing.heading} intro={pricing.intro} />

        <PricingGrid cards={cards} showToggle={Boolean(live)} />

        <div className="grid gap-6 lg:grid-cols-12">
          <h3 className="text-[15px] font-semibold lg:col-span-3">Included in every plan</h3>
          <ul className="grid gap-x-8 gap-y-3 sm:grid-cols-2 lg:col-span-9">
            {pricing.included.map((item) => (
              <li key={item} className="flex gap-3 text-[15px] text-dim">
                <Check size={16} className="mt-0.5 shrink-0 text-approve" aria-hidden />
                {item}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
