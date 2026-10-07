"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, CircleHelp, X } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { api, fmtDate, statusLabels } from "@/lib/api";
import { useMe, useToast } from "@/lib/hooks";

type Interval = "MONTHLY" | "QUARTERLY" | "YEARLY";
const intervals: Array<{ key: Interval; label: string; suffix: string }> = [
  { key: "MONTHLY", label: "Monthly", suffix: "/mo" },
  { key: "QUARTERLY", label: "Quarterly", suffix: "/quarter" },
  { key: "YEARLY", label: "Yearly", suffix: "/yr" }
];

interface BillingSummary {
  subscription: { status: string; currentPeriodEnd: string | null; trialEndsAt: string | null; cancelAtPeriodEnd: boolean; interval: Interval | null; hasStripeSubscription: boolean; trialEligible: boolean } | null;
  plan: { key: string; name: string; warningThresholdPct: number } | null;
  usage: { totalTokens: number };
  remainingTokens: number;
  tokenQuotaMonthly: number;
  executionSlotLimit: number;
  availablePlans: Array<{ key: string; name: string; tokenQuotaMonthly: number; executionSlotLimit: number; prices: Array<{ interval: Interval; unitAmountCents: number }> }>;
}

export default function BillingPage() {
  const me = useMe();
  const { toast, notify } = useToast();
  const [billing, setBilling] = useState<BillingSummary | null>(null);
  const [interval, setInterval] = useState<Interval>("MONTHLY");
  const [busy, setBusy] = useState<string | null>(null);
  const isAdmin = me?.role === "ADMIN";
  const [wantedPlan, setWantedPlan] = useState<string | null>(null);

  // Carried over from the landing page pricing links: /signup?plan=team&interval=YEARLY.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const wanted = params.get("interval")?.toUpperCase();
    if (intervals.some((i) => i.key === wanted)) setInterval(wanted as Interval);
    setWantedPlan(params.get("plan"));
  }, []);

  const reload = useCallback(async () => {
    try { const summary = await api<BillingSummary>("/v1/billing/summary"); setBilling(summary); return summary; }
    catch (error) { notify(error instanceof Error ? error.message : "Unable to load billing", "error"); return null; }
  }, [notify]);

  useEffect(() => { void reload(); }, [reload]);

  // Returning from Checkout: the webhook, not the redirect, activates the org, so poll until it lands.
  useEffect(() => {
    const checkout = new URLSearchParams(window.location.search).get("checkout");
    if (!checkout) return;
    window.history.replaceState({}, "", "/billing");
    if (checkout === "canceled") { notify("Checkout was canceled. No charge was made.", "info"); return; }
    notify("Payment details received. Activating your plan…", "success");
    let attempts = 0;
    const timer = window.setInterval(async () => {
      const summary = await reload();
      if ((summary && summary.subscription?.status !== "INCOMPLETE") || ++attempts >= 8) window.clearInterval(timer);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [notify, reload]);

  async function go(label: string, path: string, body?: unknown) {
    setBusy(label);
    try { window.location.assign((await api<{ url: string }>(path, { method: "POST", body })).url); }
    catch (error) { notify(error instanceof Error ? error.message : "The action failed", "error"); setBusy(null); }
  }

  const sub = billing?.subscription;
  const live = Boolean(sub?.hasStripeSubscription) && !["CANCELED", "EXPIRED", "INCOMPLETE"].includes(sub?.status ?? "");
  const usagePct = billing && billing.tokenQuotaMonthly > 0 ? Math.min(100, Math.round((billing.usage.totalTokens / billing.tokenQuotaMonthly) * 100)) : 0;
  const suffix = intervals.find((i) => i.key === interval)?.suffix;
  const dateNote = !sub ? "" : sub.status === "TRIALING" && sub.trialEndsAt ? `Trial ends ${fmtDate(sub.trialEndsAt)}`
    : sub.cancelAtPeriodEnd && sub.currentPeriodEnd ? `Cancels ${fmtDate(sub.currentPeriodEnd)}`
    : sub.currentPeriodEnd ? `Renews ${fmtDate(sub.currentPeriodEnd)}` : "";

  return (
    <AppShell activePath="/billing">
      <header className="page-header">
        <div>
          <p className="eyebrow">BILLING</p>
          <h1>{live ? `${billing?.plan?.name} plan` : "Choose a plan"}</h1>
          <p className="muted">{live ? dateNote : "Start a 14-day trial. Add a card now; you are not charged until the trial ends."}</p>
        </div>
        {sub && <span className={`status ${["ACTIVE", "TRIALING"].includes(sub.status) ? "approved" : "needs-review"}`}>{sub.status === "INCOMPLETE" ? "No plan" : statusLabels[sub.status] ?? sub.status}</span>}
      </header>

      {billing && (
        <section className="panel">
          {live && (
            <>
              <div className="usage-meter">
                <div className="usage-row"><span>AI tokens this month</span><strong>{billing.usage.totalTokens.toLocaleString()} / {billing.tokenQuotaMonthly.toLocaleString()}</strong></div>
                <div className="progress"><span className={usagePct >= (billing.plan?.warningThresholdPct ?? 80) ? "has-failures" : ""} style={{ width: `${usagePct}%` }} /></div>
                <small>{billing.remainingTokens.toLocaleString()} remaining · {billing.executionSlotLimit} concurrent execution slots</small>
              </div>
              {isAdmin
                ? <button className="primary-button" disabled={busy !== null} onClick={() => go("portal", "/v1/billing/portal")}>{busy === "portal" ? "Opening…" : "Manage billing"}</button>
                : <p className="dim">Only organization admins can change or cancel the plan.</p>}
              <p className="dim">Change plan or interval, update your card, view invoices or cancel in the billing portal. Cancelling keeps access until the period ends.</p>
            </>
          )}

          {!live && (
            <>
              <div className="split-action" role="tablist" aria-label="Billing interval">
                {intervals.map((i) => <button key={i.key} role="tab" aria-selected={interval === i.key} className={interval === i.key ? "run-button" : "secondary-button"} onClick={() => setInterval(i.key)}>{i.label}</button>)}
              </div>
              <div className="plan-list" style={{ marginTop: 14 }}>
                {billing.availablePlans.map((plan) => {
                  const price = plan.prices.find((p) => p.interval === interval);
                  return (
                    <div className={`plan-option ${wantedPlan === plan.key ? "current" : ""}`} key={plan.key}>
                      <div><strong>{plan.name}</strong><small>{plan.tokenQuotaMonthly.toLocaleString()} tokens/mo · {plan.executionSlotLimit} slots{price ? ` · $${(price.unitAmountCents / 100).toLocaleString()}${suffix}` : ""}</small></div>
                      {isAdmin
                        ? <button className="primary-button" disabled={busy !== null || !price} onClick={() => go(plan.key, "/v1/billing/checkout", { planKey: plan.key, interval })}>{busy === plan.key ? "Redirecting…" : sub?.trialEligible ? "Start 14-day trial" : "Subscribe"}</button>
                        : <small className="dim">Ask an admin</small>}
                    </div>
                  );
                })}
              </div>
              {!isAdmin && <p className="dim">Only organization admins can start a plan. Until then generation and execution are paused.</p>}
              {sub?.status === "CANCELED" && <p className="dim">Your previous subscription ended. Pick a plan to resume.</p>}
            </>
          )}
        </section>
      )}
      {toast && <div className={`toast ${toast.tone}`}>{toast.tone === "success" ? <Check size={17} /> : toast.tone === "error" ? <X size={17} /> : <CircleHelp size={17} />}{toast.message}</div>}
    </AppShell>
  );
}
