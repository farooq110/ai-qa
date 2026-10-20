"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, CircleHelp, X } from "lucide-react";
import { ConfirmDialog, type ConfirmRequest } from "@/components/confirm-dialog";
import { AppShell } from "@/components/app-shell";
import { Select } from "@/components/select";
import { api, fmtDate, statusLabels } from "@/lib/api";
import { can, useMe, useToast } from "@/lib/hooks";
import { PERMISSIONS } from "@ai-qa/domain";

type Interval = "MONTHLY" | "QUARTERLY" | "YEARLY";
const intervals: Array<{ key: Interval; label: string; suffix: string }> = [
  { key: "MONTHLY", label: "Monthly", suffix: "/mo" },
  { key: "QUARTERLY", label: "Quarterly", suffix: "/quarter" },
  { key: "YEARLY", label: "Yearly", suffix: "/yr" }
];

interface BillingSummary {
  subscription: { status: string; startedAt: string | null; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean; interval: Interval | null; hasStripeSubscription: boolean; trialEligible: boolean; plan: { key: string; name: string } | null } | null;
  plan: { key: string; name: string; warningThresholdPct: number } | null;
  usage: { totalTokens: number };
  remainingTokens: number;
  tokenQuotaMonthly: number;
  executionSlotLimit: number;
  availablePlans: Array<{ key: string; name: string; tokenQuotaMonthly: number; executionSlotLimit: number; prices: Array<{ interval: Interval; unitAmountCents: number }> }>;
}

interface InvoiceDetails {
  paymentMethod: { brand: string; last4: string; expMonth: number; expYear: number } | null;
  upcoming: { amountDue: number; currency: string; date: string | null } | null;
  invoices: Array<{ id: string; number: string | null; createdAt: string; amount: number; currency: string; status: string | null; viewUrl: string | null; pdfUrl: string | null }>;
}

const money = (cents: number, currency: string) => new Intl.NumberFormat(undefined, { style: "currency", currency: currency.toUpperCase() }).format(cents / 100);
const cap = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

export default function BillingPage() {
  const me = useMe();
  const { toast, notify } = useToast();
  const [billing, setBilling] = useState<BillingSummary | null>(null);
  const [interval, setInterval] = useState<Interval>("MONTHLY");
  const [busy, setBusy] = useState<string | null>(null);
  const isAdmin = can(me, PERMISSIONS.BILLING_MANAGE);
  const [wantedPlan, setWantedPlan] = useState<string | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [comment, setComment] = useState("");
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  // Loaded separately from the summary: it calls Stripe, and a failure here must not blank the rest of the page.
  const [details, setDetails] = useState<InvoiceDetails | null>(null);
  const [detailsError, setDetailsError] = useState<string | null>(null);

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

  const loadDetails = useCallback(async () => {
    try { setDetails(await api<InvoiceDetails>("/v1/billing/invoices")); setDetailsError(null); }
    catch (error) { setDetailsError(error instanceof Error ? error.message : "Unable to load invoices"); }
  }, []);

  const hasStripe = Boolean(billing?.subscription?.hasStripeSubscription);
  // Start the toggle on the interval the org is already billed at, unless the landing page passed one.
  const currentInterval = billing?.subscription?.interval ?? null;
  useEffect(() => {
    if (currentInterval && !new URLSearchParams(window.location.search).get("interval")) setInterval(currentInterval);
  }, [currentInterval]);
  useEffect(() => { if (hasStripe) void loadDetails(); }, [hasStripe, loadDetails]);

  // Returning from the hosted card form: the webhook sets the new default card, so re-read a few times.
  useEffect(() => {
    const card = new URLSearchParams(window.location.search).get("card");
    if (!card) return;
    window.history.replaceState({}, "", "/billing");
    if (card === "canceled") { notify("Card update was canceled. Nothing changed.", "info"); return; }
    notify("Saving your new card…", "success");
    let attempts = 0;
    const timer = window.setInterval(() => { void loadDetails(); if (++attempts >= 4) window.clearInterval(timer); }, 2500);
    return () => window.clearInterval(timer);
  }, [notify, loadDetails]);

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

  async function switchPlan(planKey: string, planName: string) {
    setBusy(planKey);
    try {
      await api("/v1/billing/change-plan", { method: "POST", body: { planKey, interval } });
      notify(`Switched to ${planName}.`, "success");
      await Promise.all([reload(), loadDetails()]);
    } catch (error) { notify(error instanceof Error ? error.message : "The action failed", "error"); }
    finally { setBusy(null); }
  }

  async function changeCancellation(path: "cancel" | "resume", success: string) {
    setBusy(path);
    try {
      await api(`/v1/billing/${path}`, { method: "POST", body: path === "cancel" ? { reason: [reason, comment.trim()].filter(Boolean).join(": ") || undefined } : undefined });
      notify(success, "success");
      setCancelOpen(false); setReason(""); setComment("");
      await reload();
    } catch (error) { notify(error instanceof Error ? error.message : "The action failed", "error"); }
    finally { setBusy(null); }
  }

  const sub = billing?.subscription;
  const isTrial = billing?.plan?.key === "trial" && sub !== null;
  const trialEnd = sub?.status === "TRIALING" ? sub.currentPeriodEnd : null;
  const trialDaysLeft = trialEnd ? Math.ceil((new Date(trialEnd).getTime() - Date.now()) / 86400000) : null;
  const isTrialLive = isTrial && (trialDaysLeft === null || trialDaysLeft > 0);
  const live = isTrialLive || (Boolean(sub?.hasStripeSubscription) && !["CANCELED", "EXPIRED", "INCOMPLETE"].includes(sub?.status ?? ""));
  const livePaid = Boolean(sub?.hasStripeSubscription) && !["CANCELED", "EXPIRED", "INCOMPLETE"].includes(sub?.status ?? "");
  const usagePct = billing && billing.tokenQuotaMonthly > 0 ? Math.min(100, Math.round((billing.usage.totalTokens / billing.tokenQuotaMonthly) * 100)) : 0;
  const suffix = intervals.find((i) => i.key === interval)?.suffix;
  const dateNote = !sub ? "" : (sub.startedAt ? `Subscribed ${fmtDate(sub.startedAt)} · ` : "") + (trialEnd ? `Trial ends ${fmtDate(trialEnd)}`
    : sub.cancelAtPeriodEnd && sub.currentPeriodEnd ? `Cancels ${fmtDate(sub.currentPeriodEnd)}`
    : sub.currentPeriodEnd ? `Renews ${fmtDate(sub.currentPeriodEnd)}` : "");

  // Until the summary loads, guess the layout from the cached profile so the skeleton matches what replaces it.
  const expectLive = ["TRIALING", "ACTIVE", "PAYMENT_WARNING", "PAST_DUE"].includes(me?.organization?.subscription?.status ?? "");

  return (
    <AppShell activePath="/billing">
      <header className="page-header">
        <div>
          {billing ? <>
            <h1>{isTrial ? "Free Trial plan" : live ? `${billing.plan?.name} plan` : "Choose a plan"}</h1>
            <p className="muted">{isTrial ? (isTrialLive ? <>Free Trial plan — <strong>{trialDaysLeft} day(s) remaining</strong>. Subscribe any time to keep everything running after the trial ends.{billing.subscription?.startedAt && trialEnd && <> Started {fmtDate(billing.subscription.startedAt)}; ends {fmtDate(trialEnd)}.</>}</> : <>Your 7-day free trial has ended — the organization is read-only. Subscribe below to unfreeze it.</>) : live ? dateNote : "Pick a plan below — every plan starts with everything included."}</p>
          </> : <>
            <span className="skel" style={{ width: 220, height: 30, margin: "6px 0 10px" }} />
            <span className="skel" style={{ width: 340, maxWidth: "100%", height: 14 }} />
          </>}
        </div>
      </header>

      <div className="billing-stack">
      {billing && ["PAST_DUE", "BILLING_LOCKED"].includes(sub?.status ?? "") && (
        <section className="panel" role="alert">
          <div className="panel-heading"><div><h2>{sub?.status === "PAST_DUE" ? "Your last payment failed" : "Billing is locked"}</h2></div></div>
          <p className="muted">Generating and running tests is paused until the payment goes through. {isAdmin ? "Update your card below, or pay the open invoice in Invoice history, and access resumes right away." : "Ask an organization admin to update the payment method."}</p>
        </section>
      )}
      {!billing && (
        <section className="panel" aria-busy="true" aria-label="Loading billing">
          {expectLive ? (
            <div style={{ display: "grid", gap: 12 }}>
              <div className="usage-row"><span className="skel" style={{ width: 150, height: 14 }} /><span className="skel" style={{ width: 120, height: 14 }} /></div>
              <span className="skel" style={{ width: "100%", height: 8, borderRadius: 999 }} />
              <span className="skel" style={{ width: 260, height: 12 }} />
              <div className="split-action"><span className="skel" style={{ width: 130, height: 38, borderRadius: 8 }} /><span className="skel" style={{ width: 100, height: 38, borderRadius: 8 }} /></div>
              <span className="skel" style={{ width: "80%", height: 12 }} />
            </div>
          ) : (
            <>
              <div className="split-action">{[0, 1, 2].map((i) => <span key={i} className="skel" style={{ width: 84, height: 28, borderRadius: 6 }} />)}</div>
              <div className="plan-grid">
                {[0, 1, 2].map((i) => (
                  <div className="plan-column" key={i}>
                    <span className="skel" style={{ width: 90, height: 14 }} />
                    <span className="skel" style={{ width: 110, height: 30 }} />
                    <span className="skel" style={{ width: "70%", height: 10 }} />
                    <span className="skel" style={{ width: "100%", height: 64 }} />
                    <span className="skel" style={{ width: "100%", height: 32 }} />
                  </div>
                ))}
              </div>
            </>
          )}
        </section>
      )}

      {billing && livePaid && (
        <div className="billing-grid">
          <div className="billing-col">
          <section className="panel">
            <div className="panel-heading"><div><p className="eyebrow">CURRENT PLAN</p><h2>{billing.plan?.name}</h2></div>
              {sub && <span className={`status ${["ACTIVE", "TRIALING"].includes(sub.status) ? "approved" : "needs-review"}`}>{statusLabels[sub.status] ?? sub.status}</span>}
            </div>
            <dl className="detail-grid stacked">
              <div><dt>Billing</dt><dd>{sub?.interval ? cap(sub.interval.toLowerCase()) : "—"}</dd></div>
              <div><dt>Subscribed</dt><dd>{sub?.startedAt ? fmtDate(sub.startedAt) : "—"}</dd></div>
              <div><dt>{sub?.cancelAtPeriodEnd ? "Access ends" : "Renews"}</dt><dd>{sub?.currentPeriodEnd ? fmtDate(sub.currentPeriodEnd) : "—"}</dd></div>
              <div><dt>Execution slots</dt><dd>{billing.executionSlotLimit}</dd></div>
            </dl>
            {sub?.cancelAtPeriodEnd && <p className="dim">Cancellation is scheduled. Everything keeps working until {sub.currentPeriodEnd ? fmtDate(sub.currentPeriodEnd) : "the period ends"}.</p>}
            {isAdmin
              ? <div className="split-action">
                  {sub?.cancelAtPeriodEnd
                    ? <button className="primary-button" disabled={busy !== null} onClick={() => setConfirm({ title: "Keep your plan?", body: "Your subscription will continue and renew as normal.", confirmLabel: "Resume subscription", danger: false, action: () => changeCancellation("resume", "Subscription resumed.") })}>Resume subscription</button>
                    : <button className="mini-button danger" disabled={busy !== null} onClick={() => setCancelOpen(true)}>Cancel plan</button>}
                </div>
              : <p className="dim">Only organization admins can change or cancel the plan.</p>}
          </section>
          <section className="panel">
            <div className="panel-heading"><div><p className="eyebrow">NEXT INVOICE</p><h2>{details?.upcoming ? money(details.upcoming.amountDue, details.upcoming.currency) : sub?.cancelAtPeriodEnd ? "None" : "—"}</h2></div></div>
            {detailsError ? <p className="dim">{detailsError}</p>
              : !details ? <span className="skel" style={{ width: 180, height: 14 }} />
              : details.upcoming ? <p className="muted">Charged {details.upcoming.date ? fmtDate(details.upcoming.date) : "at the next renewal"}.</p>
              : <p className="muted">{sub?.cancelAtPeriodEnd ? `No further invoices. Access ends ${sub.currentPeriodEnd ? fmtDate(sub.currentPeriodEnd) : "at the period end"}.` : "No upcoming invoice."}</p>}
          </section>
          </div>
          <div className="billing-col">
          <section className="panel">
            <div className="panel-heading"><div><p className="eyebrow">USAGE</p><h2>AI tokens this month</h2></div></div>
            <div className="usage-meter">
              <div className="usage-row"><span>Used</span><strong>{billing.usage.totalTokens.toLocaleString()} / {billing.tokenQuotaMonthly.toLocaleString()}</strong></div>
              <div className="progress"><span className={usagePct >= (billing.plan?.warningThresholdPct ?? 80) ? "has-failures" : ""} style={{ width: `${usagePct}%` }} /></div>
              <small>{billing.remainingTokens.toLocaleString()} remaining · resets on the 1st</small>
            </div>
          </section>
          <section className="panel">
            <div className="panel-heading"><div><p className="eyebrow">PAYMENT METHOD</p><h2>{details ? (details.paymentMethod ? `${cap(details.paymentMethod.brand)} ending ${details.paymentMethod.last4}` : "No card on file") : "Card"}</h2></div></div>
            {detailsError ? <p className="dim">{detailsError}</p>
              : !details ? <span className="skel" style={{ width: 180, height: 14 }} />
              : <p className="muted">{details.paymentMethod ? `Expires ${String(details.paymentMethod.expMonth).padStart(2, "0")}/${details.paymentMethod.expYear}` : "Add a card so renewals are not interrupted."}</p>}
            {isAdmin && <button className="secondary-button" disabled={busy !== null} onClick={() => go("card", "/v1/billing/payment-method")}>{busy === "card" ? "Opening…" : "Update card"}</button>}
          </section>
          </div>
        </div>
      )}

      {billing && hasStripe && (
      <section className="panel">
            <div className="panel-heading"><div><p className="eyebrow">INVOICES</p><h2>Invoice history</h2></div></div>
            {detailsError ? <p className="dim">{detailsError}</p>
              : !details ? <span className="skel" style={{ width: "100%", height: 80 }} />
              : details.invoices.length === 0 ? <p className="muted">No invoices yet.</p>
              : (
                <div className="invoice-table">
                  {details.invoices.map((invoice) => (
                    <div className="invoice-row" key={invoice.id}>
                      <span><strong>{invoice.number ?? "Draft"}</strong><small>{fmtDate(invoice.createdAt)}</small></span>
                      <span>{money(invoice.amount, invoice.currency)}</span>
                      <span><span className={`status ${invoice.status === "paid" ? "approved" : "needs-review"}`}>{cap(invoice.status ?? "unknown")}</span></span>
                      <span className="split-action">
                        {invoice.viewUrl && <a className="text-button" href={invoice.viewUrl} target="_blank" rel="noreferrer">{invoice.status === "open" ? "Pay" : "View"}</a>}
                        {invoice.pdfUrl && <a className="text-button" href={invoice.pdfUrl}>Download PDF</a>}
                      </span>
                    </div>
                  ))}
                </div>
              )}
          </section>
      )}

      {billing && isTrialLive && (
        <section className="panel">
          <div className="panel-heading"><div><p className="eyebrow">USAGE</p><h2>AI tokens this month</h2></div></div>
          <div className="usage-meter">
            <div className="usage-row"><span>Used</span><strong>{billing.usage.totalTokens.toLocaleString()} / {billing.tokenQuotaMonthly.toLocaleString()}</strong></div>
            <div className="progress"><span className={usagePct >= (billing.plan?.warningThresholdPct ?? 80) ? "has-failures" : ""} style={{ width: `${usagePct}%` }} /></div>
            <small>{billing.remainingTokens.toLocaleString()} remaining · {billing.executionSlotLimit} concurrent execution slots</small>
          </div>
          <p className="dim">On the free trial — no card on file. Subscribe to a plan below when you're ready.</p>
        </section>
      )}

      {billing && (
        <section className="panel">
          <div className="panel-heading"><div><p className="eyebrow">PLANS</p><h2>{livePaid ? "Change plan" : "Choose a plan"}</h2></div></div>
          <div className="view-toggle" role="tablist" aria-label="Billing interval">
            {intervals.map((i) => <button key={i.key} role="tab" aria-selected={interval === i.key} className={interval === i.key ? "seg on" : "seg"} onClick={() => setInterval(i.key)}>{i.label}</button>)}
          </div>
          <div className="plan-grid">
            {billing.availablePlans.map((plan) => {
              // The plan carried over from the landing page wins; otherwise Team carries the weight.
              const featured = (billing.availablePlans.some((p) => p.key === wantedPlan) ? wantedPlan : "team") === plan.key;
              const price = plan.prices.find((p) => p.interval === interval);
              const monthly = plan.prices.find((p) => p.interval === "MONTHLY");
              const months = interval === "QUARTERLY" ? 3 : interval === "YEARLY" ? 12 : 1;
              const perMonth = price ? price.unitAmountCents / 100 / months : null;
              const saving = price && monthly && months > 1 ? Math.round((1 - price.unitAmountCents / (monthly.unitAmountCents * months)) * 100) : 0;
              const isCurrent = livePaid && billing.plan?.key === plan.key && sub?.interval === interval;
              return (
                <article className={`plan-column${featured ? " featured" : ""}`} key={plan.key}>
                  <header>
                    <h2>{plan.name}</h2>
                    {isCurrent ? <span className="status approved">current</span> : featured && <span className="status approved">{wantedPlan === plan.key ? "selected" : "recommended"}</span>}
                  </header>
                  <div className="plan-price">
                    {price ? <><strong>${(price.unitAmountCents / 100).toLocaleString()}</strong><span>{suffix}</span></> : <span className="dim">No {interval.toLowerCase()} price</span>}
                  </div>
                  <p className="plan-note">{perMonth !== null && months > 1 ? <>${perMonth.toLocaleString(undefined, { maximumFractionDigits: 2 })}/mo billed {interval.toLowerCase()}{saving > 0 ? <b> · save {saving}%</b> : null}</> : "billed monthly"}</p>
                  <dl className="plan-specs">
                    <div><dt>Concurrent test slots</dt><dd>{plan.executionSlotLimit}</dd></div>
                    <div><dt>AI tokens / month</dt><dd>{plan.tokenQuotaMonthly.toLocaleString()}</dd></div>
                  </dl>
                  {isAdmin
                    ? <button className={featured ? "run-button" : "secondary-button"} disabled={busy !== null || !price || isCurrent}
                        onClick={() => livePaid
                          ? setConfirm({ title: `Switch to ${plan.name} (${interval.toLowerCase()})?`, body: "The change applies immediately. Stripe prorates the difference on your next invoice.", confirmLabel: "Switch plan", danger: false, action: () => switchPlan(plan.key, plan.name) })
                          : void go(plan.key, "/v1/billing/checkout", { planKey: plan.key, interval })}>
                        {busy === plan.key ? (livePaid ? "Switching…" : "Redirecting…") : !price ? "Unavailable" : isCurrent ? "Current plan" : livePaid ? `Switch to ${plan.name}` : isTrialLive ? `Upgrade to ${plan.name}` : "Subscribe"}
                      </button>
                    : <small className="dim">Ask an admin to start this plan</small>}
                </article>
              );
            })}
          </div>
          {!isAdmin && <p className="dim">Only organization admins can start a plan. Until then generation and execution are paused.</p>}
          {sub?.status === "CANCELED" && <p className="dim">Your previous subscription ended. Pick a plan to resume.</p>}
        </section>
      )}
      </div>
      {confirm && <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />}
      {cancelOpen && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={() => busy === null && setCancelOpen(false)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <header><div><h2>Cancel your {billing?.plan?.name} plan?</h2></div><button className="icon-button" aria-label="Close" onClick={() => setCancelOpen(false)}><X size={16} /></button></header>
            <div className="modal-body">
              <p className="muted" style={{ margin: 0, lineHeight: 1.6 }}>You keep full access until {sub?.currentPeriodEnd ? fmtDate(sub.currentPeriodEnd) : "the end of the current period"}. After that, generation and execution pause. You can resume any time before then.</p>
              <label>Why are you leaving? (optional)
                <Select value={reason} onChange={setReason} placeholder="Select a reason" options={["Too expensive", "Missing features", "Not using it enough", "Switching to another tool", "Other"].map((option) => ({ value: option, label: option }))} />
              </label>
              <label>Anything we should know? (optional)<textarea rows={3} value={comment} maxLength={400} onChange={(event) => setComment(event.target.value)} /></label>
            </div>
            <footer>
              <button className="modal-cancel" onClick={() => setCancelOpen(false)} disabled={busy !== null}>Keep plan</button>
              <button className="primary-button danger" onClick={() => void changeCancellation("cancel", "Cancellation scheduled. Access continues until the period ends.")} disabled={busy !== null}>{busy === "cancel" ? "Cancelling…" : "Cancel at period end"}</button>
            </footer>
          </div>
        </div>
      )}
      {toast && <div className={`toast ${toast.tone}`}>{toast.tone === "success" ? <Check size={17} /> : toast.tone === "error" ? <X size={17} /> : <CircleHelp size={17} />}{toast.message}</div>}
    </AppShell>
  );
}
