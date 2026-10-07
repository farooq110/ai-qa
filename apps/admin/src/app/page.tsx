"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Activity, Bot, Boxes, Building2, CircleAlert, Cpu, KeyRound, Layers3, LifeBuoy, LogIn, RefreshCw, Shield
} from "lucide-react";

const apiBase = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
const tokenKey = "proofline.adminToken";

interface Overview { organizations: number; users: number; projects: number; testCases: number; activeExecutions: number; aiTokensThisMonth: number; billingAttention: Array<{ status: string; count: number }> }
interface OrgRow { id: string; name: string; industry: string | null; createdAt: string; members: number; projects: number; subscriptionStatus: string; plan: string | null }
interface PlanRow { id: string; key: string; name: string; monthlyPriceUsd: number; tokenQuotaMonthly: number; executionSlotLimit: number; retentionDays: number; isActive: boolean; _count: { subscriptions: number } }
interface WorkersInfo { queuedExecutions: number; runningExecutions: number; aiCalls24h: number; configuredWorkerConcurrency: number }
interface AuditRow { id: string; action: string; actorEmail: string | null; organizationId: string | null; targetType: string | null; targetId: string | null; metadata: Record<string, unknown> | null; createdAt: string }
interface SupportQueryRow { id: string; title: string; description: string; email: string; imageUrl: string | null; status: string; createdAt: string }

type Section = "overview" | "organizations" | "plans" | "workers" | "audit" | "support";

const statusTone = (status: string) => ["ACTIVE", "TRIALING", "RESOLVED"].includes(status) ? "ok" : ["PAST_DUE", "PAYMENT_WARNING", "OPEN"].includes(status) ? "warn" : "bad";
const supportStatuses = ["OPEN", "RESOLVED", "REJECTED"];

export default function AdminPage() {
  const [token, setToken] = useState<string | null>(null);
  const [email, setEmail] = useState("superadmin@proofline.local");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [section, setSection] = useState<Section>("overview");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [orgs, setOrgs] = useState<OrgRow[] | null>(null);
  const [plans, setPlans] = useState<PlanRow[] | null>(null);
  const [workers, setWorkers] = useState<WorkersInfo | null>(null);
  const [audit, setAudit] = useState<AuditRow[] | null>(null);
  const [supportQueries, setSupportQueries] = useState<SupportQueryRow[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const show = (message: string) => { setNotice(message); window.setTimeout(() => setNotice(null), 3200); };

  useEffect(() => {
    const stored = window.localStorage.getItem(tokenKey);
    if (stored) setToken(stored);
  }, []);

  const load = useCallback(async (target: Section) => {
    if (!token) return;
    setBusy(true);
    try {
      if (target === "overview") setOverview(await get<Overview>("/v1/admin/overview", token));
      if (target === "organizations") setOrgs(await get<OrgRow[]>("/v1/admin/organizations", token));
      if (target === "plans") setPlans(await get<PlanRow[]>("/v1/admin/plans", token));
      if (target === "workers") setWorkers(await get<WorkersInfo>("/v1/admin/workers", token));
      if (target === "audit") setAudit(await get<AuditRow[]>("/v1/admin/audit?take=60", token));
      if (target === "support") setSupportQueries(await get<SupportQueryRow[]>("/v1/admin/support-queries", token));
    } catch (cause) {
      show(cause instanceof Error ? cause.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }, [token]);

  useEffect(() => { if (token) void load(section); }, [token, section, load]);

  async function signIn() {
    setError("");
    try {
      const response = await fetch(`${apiBase}/v1/auth/signin`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
      const result = await response.json() as { accessToken?: string; isSuperadmin?: boolean; message?: string };
      if (!response.ok || !result.accessToken) throw new Error(result.message ?? "Sign-in failed");
      if (!result.isSuperadmin) throw new Error("This account is not a platform superadmin");
      window.localStorage.setItem(tokenKey, result.accessToken);
      setToken(result.accessToken);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Sign-in failed");
    }
  }

  function signOut() {
    window.localStorage.removeItem(tokenKey);
    setToken(null);
    setPassword("");
  }

  async function setSubscriptionStatus(org: OrgRow, status: string) {
    try {
      await patch(`/v1/admin/organizations/${org.id}/subscription`, { status }, token!);
      show(`${org.name} subscription set to ${status.replace(/_/g, " ").toLowerCase()}.`);
      await load("organizations");
    } catch (cause) {
      show(cause instanceof Error ? cause.message : "Update failed");
    }
  }

  async function setSupportQueryStatus(query: SupportQueryRow, status: string) {
    try {
      await patch(`/v1/admin/support-queries/${query.id}`, { status }, token!);
      show(`"${query.title}" marked ${status.toLowerCase()}.`);
      await load("support");
    } catch (cause) {
      show(cause instanceof Error ? cause.message : "Update failed");
    }
  }

  if (!token) {
    return (
      <main className="admin-login">
        <form onSubmit={(event) => { event.preventDefault(); void signIn(); }}>
          <div className="admin-brand standalone"><Shield size={20} />proofline <span>PLATFORM</span></div>
          <p className="eyebrow-line">RESTRICTED AREA</p>
          <h1>Superadmin sign-in</h1>
          <p className="hint">Platform operations require a superadmin account with MFA in production. Local seed: <code>superadmin@proofline.local</code></p>
          <label>Email<input value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" /></label>
          <label>Password<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="superadmin-password-123" autoComplete="current-password" /></label>
          {error && <p className="form-error">{error}</p>}
          <button type="submit"><LogIn size={16} />Sign in</button>
        </form>
      </main>
    );
  }

  const nav = [
    [Layers3, "Overview", "overview"],
    [Building2, "Organizations", "organizations"],
    [Boxes, "Plans & quotas", "plans"],
    [Cpu, "Workers & queue", "workers"],
    [KeyRound, "Audit log", "audit"],
    [LifeBuoy, "Support queries", "support"]
  ] as const;

  return (
    <main className="admin-shell">
      <aside>
        <div className="admin-brand"><Shield size={20} />proofline <span>PLATFORM</span></div>
        <nav>{nav.map(([Icon, label, key]) => (
          <button key={key} className={section === key ? "selected" : ""} onClick={() => setSection(key)}><Icon size={17} />{label}</button>
        ))}</nav>
        <div className="admin-footer"><span>SA</span><div><strong>System Admin</strong><small>superadmin session</small></div><button className="admin-signout" onClick={signOut} title="Sign out">Exit</button></div>
      </aside>
      <section>
        <header>
          <div><p>PLATFORM OPERATIONS</p><h1>{nav.find(([, , key]) => key === section)?.[1]}</h1></div>
          <div style={{ display: "flex", gap: 9 }}>
            <button onClick={() => load(section)} disabled={busy}><RefreshCw size={16} />{busy ? "Loading…" : "Refresh"}</button>
          </div>
        </header>

        {section === "overview" && overview && (
          <>
            <div className="cards">
              <Card label="Active organizations" value={String(overview.organizations)} detail={`${overview.users} user accounts`} icon={Building2} />
              <Card label="Test cases" value={String(overview.testCases)} detail={`${overview.projects} projects connected`} icon={Bot} />
              <Card label="Active executions" value={String(overview.activeExecutions)} detail="queued or running now" icon={Activity} />
              <Card label="Billing attention" value={String(overview.billingAttention.reduce((sum, entry) => sum + entry.count, 0))} detail={overview.billingAttention.map((entry) => `${entry.status.replace(/_/g, " ").toLowerCase()}: ${entry.count}`).join(" · ") || "all clear"} icon={CircleAlert} />
            </div>
            <div className="grid">
              <section className="panel">
                <div className="title"><div><p>PLATFORM TOTALS</p><h2>AI tokens this month</h2></div></div>
                <div className="queue"><strong>{overview.aiTokensThisMonth.toLocaleString()}</strong><span>input + output tokens across all organizations</span></div>
                <small>Tokens are recorded per generation job and reconciled against provider usage reports.</small>
              </section>
              <section className="panel">
                <div className="title"><div><p>QUEUE</p><h2>Execution demand</h2></div><Activity size={18} /></div>
                <div className="queue"><strong>{overview.activeExecutions}</strong><span>runs in flight</span></div>
                <small>All plan limits and fair-use reservations are enforced before workers claim a job.</small>
              </section>
            </div>
          </>
        )}

        {section === "organizations" && orgs && (
          <div className="grid single">
            <section className="panel">
              <div className="title"><div><p>TENANTS</p><h2>{orgs.length} organizations</h2></div></div>
              <div className="admin-table">
                <div className="admin-tr head"><span>Organization</span><span>Members</span><span>Projects</span><span>Plan</span><span>Subscription</span><span>Set status</span></div>
                {orgs.map((org) => (
                  <div className="admin-tr" key={org.id}>
                    <span><strong>{org.name}</strong><small>{org.industry ?? "—"} · joined {new Date(org.createdAt).toLocaleDateString()}</small></span>
                    <span>{org.members}</span>
                    <span>{org.projects}</span>
                    <span>{org.plan ?? "—"}</span>
                    <span><b className={`pill ${statusTone(org.subscriptionStatus)}`}>{org.subscriptionStatus.replace(/_/g, " ")}</b></span>
                    <span>
                      <select value={org.subscriptionStatus} aria-label={`Subscription status for ${org.name}`} onChange={(event) => setSubscriptionStatus(org, event.target.value)}>
                        {["TRIALING", "ACTIVE", "PAYMENT_WARNING", "PAST_DUE", "BILLING_LOCKED", "CANCELED", "EXPIRED"].map((status) => <option key={status} value={status}>{status.replace(/_/g, " ")}</option>)}
                      </select>
                    </span>
                  </div>
                ))}
              </div>
              <small>Setting an organization to Past due or Billing locked immediately blocks generation and execution server-side, including queued CI runs.</small>
            </section>
          </div>
        )}

        {section === "plans" && plans && (
          <div className="grid single">
            <section className="panel">
              <div className="title"><div><p>PRICING</p><h2>Plans &amp; entitlements</h2></div></div>
              <div className="admin-table">
                <div className="admin-tr head"><span>Plan</span><span>Price</span><span>Token quota</span><span>Execution slots</span><span>Retention</span><span>Subscriptions</span></div>
                {plans.map((plan) => (
                  <div className="admin-tr" key={plan.id}>
                    <span><strong>{plan.name}</strong><small>{plan.key}</small></span>
                    <span>${plan.monthlyPriceUsd}/mo</span>
                    <span>{plan.tokenQuotaMonthly.toLocaleString()}</span>
                    <span>{plan.executionSlotLimit}</span>
                    <span>{plan.retentionDays} days</span>
                    <span>{plan._count.subscriptions}</span>
                  </div>
                ))}
              </div>
              <small>Plan configuration drives server-side enforcement: AI quota reserves, execution concurrency, and artifact retention.</small>
            </section>
          </div>
        )}

        {section === "workers" && workers && (
          <>
            <div className="cards">
              <Card label="Queued executions" value={String(workers.queuedExecutions)} detail="waiting for a worker" icon={Activity} />
              <Card label="Running" value={String(workers.runningExecutions)} detail="claimed by workers" icon={Cpu} />
              <Card label="AI calls 24h" value={String(workers.aiCalls24h)} detail="generation usage records" icon={Bot} />
              <Card label="Worker concurrency" value={String(workers.configuredWorkerConcurrency)} detail="per worker process (env)" icon={Cpu} />
            </div>
            <div className="grid single">
              <section className="panel">
                <div className="title"><div><p>CAPACITY</p><h2>Fair use</h2></div></div>
                <small>Plans sell concurrent execution slots, not dedicated servers. Effective concurrency is the minimum of platform, plan, and organization limits; the queue prevents duplicate plans and blocks billed-locked organizations at claim time.</small>
              </section>
            </div>
          </>
        )}

        {section === "audit" && audit && (
          <div className="grid single">
            <section className="panel">
              <div className="title"><div><p>PLATFORM AUDIT TRAIL</p><h2>Recent superadmin &amp; billing events</h2></div></div>
              <div className="admin-table">
                <div className="admin-tr head"><span>When</span><span>Action</span><span>Actor</span><span>Target</span><span>Detail</span></div>
                {audit.map((entry) => (
                  <div className="admin-tr" key={entry.id}>
                    <span><small>{new Date(entry.createdAt).toLocaleString()}</small></span>
                    <span><strong>{entry.action}</strong></span>
                    <span><small>{entry.actorEmail ?? "system"}</small></span>
                    <span><small>{entry.targetType ?? "—"}{entry.targetId ? ` · ${entry.targetId.slice(0, 10)}…` : ""}</small></span>
                    <span><small>{entry.metadata ? JSON.stringify(entry.metadata).slice(0, 90) : "—"}</small></span>
                  </div>
                ))}
                {audit.length === 0 && <div className="admin-tr"><span><small>No platform-scoped events yet.</small></span></div>}
              </div>
            </section>
          </div>
        )}

        {section === "support" && supportQueries && (
          <div className="grid single">
            <section className="panel">
              <div className="title"><div><p>CONTACT MODAL</p><h2>{supportQueries.length} support queries</h2></div></div>
              <div className="admin-table">
                <div className="admin-tr head"><span>Query</span><span>From</span><span>Attachment</span><span>Received</span><span>Status</span><span>Set status</span></div>
                {supportQueries.map((query) => (
                  <div className="admin-tr" key={query.id}>
                    <span><strong>{query.title}</strong><small>{query.description}</small></span>
                    <span><small>{query.email}</small></span>
                    <span>{query.imageUrl ? <a href={query.imageUrl} target="_blank" rel="noreferrer">View image</a> : <small>—</small>}</span>
                    <span><small>{new Date(query.createdAt).toLocaleString()}</small></span>
                    <span><b className={`pill ${statusTone(query.status)}`}>{query.status}</b></span>
                    <span>
                      <select value={query.status} aria-label={`Status for ${query.title}`} onChange={(event) => setSupportQueryStatus(query, event.target.value)}>
                        {supportStatuses.map((status) => <option key={status} value={status}>{status}</option>)}
                      </select>
                    </span>
                  </div>
                ))}
                {supportQueries.length === 0 && <div className="admin-tr"><span><small>No support queries yet.</small></span></div>}
              </div>
            </section>
          </div>
        )}
      </section>
      {notice && <div className="notice">{notice}</div>}
    </main>
  );
}

async function get<T>(path: string, token: string): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const payload = await response.json() as T & { message?: string };
  if (!response.ok) throw new Error(payload.message ?? `Request failed (${response.status})`);
  return payload;
}

async function patch(path: string, body: unknown, token: string) {
  const response = await fetch(`${apiBase}${path}`, { method: "PATCH", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { message?: string };
    throw new Error(payload.message ?? `Request failed (${response.status})`);
  }
}

function Card({ label, value, detail, icon: Icon }: { label: string; value: string; detail: string; icon: typeof Activity }) {
  return <article className="card"><Icon size={19} /><p>{label}</p><strong>{value}</strong><small>{detail}</small></article>;
}
