"use client";

import { useState } from "react";
import { ArrowRight } from "lucide-react";
import { site } from "@/config/site";
import { ButtonLink } from "@/components/ui/button-link";
import type { ApiPlan, Interval } from "@/lib/plans";

export type PricingCard = { id: string; name: string; slots: string; summary: string; cta: string; featured?: boolean; prices?: ApiPlan["prices"] };

const intervals: Array<{ key: Interval; label: string; suffix: string }> = [
  { key: "MONTHLY", label: "Monthly", suffix: "/mo" },
  { key: "QUARTERLY", label: "Quarterly", suffix: "/quarter" },
  { key: "YEARLY", label: "Yearly", suffix: "/yr" }
];

export function PricingGrid({ cards, showToggle }: { cards: PricingCard[]; showToggle: boolean }) {
  const [interval, setInterval] = useState<Interval>("MONTHLY");
  const suffix = intervals.find((i) => i.key === interval)?.suffix;

  return (
    <div className="flex flex-col gap-6">
      {showToggle && (
        <div role="tablist" aria-label="Billing interval" className="inline-flex w-fit gap-1 rounded-full border border-line bg-panel p-1">
          {intervals.map((i) => (
            <button key={i.key} role="tab" aria-selected={interval === i.key} onClick={() => setInterval(i.key)}
              className={`rounded-full px-4 py-1.5 text-[13.5px] font-medium transition-colors ${interval === i.key ? "bg-approve text-approve-ink" : "text-dim hover:text-fg"}`}>
              {i.label}
            </button>
          ))}
        </div>
      )}
      <ul className="grid gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-2 lg:grid-cols-4">
        {cards.map((plan) => {
          const price = plan.prices?.find((p) => p.interval === interval);
          // Enterprise has no Stripe price: it goes to signup with no interval.
          const href = `${site.links.signup}?plan=${plan.id}${price ? `&interval=${interval}` : ""}`;
          return (
            <li key={plan.id} className={`relative flex flex-col gap-6 p-6 ${plan.featured ? "bg-raised" : "bg-panel"}`}>
              {plan.featured && <span aria-hidden className="absolute inset-x-0 top-0 h-0.5 bg-approve" />}
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-lg font-semibold tracking-[-0.01em]">{plan.name}</h3>
                {plan.featured && <span className="rounded-full bg-approve-wash px-2 py-0.5 text-[11.5px] font-medium text-approve">Most teams</span>}
              </div>
              {price && (
                <p className="flex items-baseline gap-1">
                  <span className="text-[clamp(2rem,3vw,2.5rem)] font-semibold leading-none tracking-[-0.03em]">${(price.unitAmountCents / 100).toLocaleString("en-US")}</span>
                  <span className="text-[13px] text-muted">{suffix}</span>
                </p>
              )}
              <p className="flex flex-col gap-1">
                <span className={`text-[clamp(2.5rem,4vw,3.25rem)] leading-none tracking-[-0.04em] ${/^\d+$/.test(plan.slots) ? "font-mono font-medium" : "font-semibold"}`}>{plan.slots}</span>
                <span className="text-[13px] text-muted">concurrent test slots</span>
              </p>
              <p className="text-[14.5px] leading-relaxed text-dim">{plan.summary}</p>
              <ButtonLink href={href} variant={plan.featured ? "approve" : "secondary"} className="mt-auto w-full"
                icon={<ArrowRight size={15} aria-hidden className="order-last transition-transform group-hover:translate-x-0.5" />}>
                {plan.cta}
              </ButtonLink>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
