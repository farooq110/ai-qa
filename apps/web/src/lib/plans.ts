export type Interval = "MONTHLY" | "QUARTERLY" | "YEARLY";
export type ApiPlan = { key: string; name: string; executionSlotLimit: number; tokenQuotaMonthly: number; prices: Array<{ interval: Interval; unitAmountCents: number }> };

/** Live plans from the control plane. Null on any failure so the section falls back to the static cards. */
export async function fetchPlans(): Promise<ApiPlan[] | null> {
  const base = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
  try {
    const response = await fetch(`${base}/v1/billing/plans`, { next: { revalidate: 300 } });
    if (!response.ok) return null;
    const plans = (await response.json()) as ApiPlan[];
    return plans.length ? plans : null;
  } catch {
    return null;
  }
}
