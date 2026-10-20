"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Activity, CreditCard, FolderKanban, GitBranch, LayoutDashboard, LogOut, Menu, Moon, Settings, ShieldCheck, Sun, TestTube2, Users, X } from "lucide-react";
import { PERMISSIONS, type Permission } from "@ai-qa/domain";
import { apiToken } from "@/lib/api";
import { can, upgradeEvent, useMe } from "@/lib/hooks";
import { useTheme } from "@/lib/theme";
import { BrandMark } from "@/components/brand-mark";

const navigation: readonly [typeof LayoutDashboard, string, string, Permission][] = [
  [LayoutDashboard, "Overview", "/dashboard", PERMISSIONS.DASHBOARD_VIEW],
  [FolderKanban, "Projects", "/projects", PERMISSIONS.PROJECTS_VIEW],
  [TestTube2, "Test cases", "/test-cases", PERMISSIONS.TEST_CASES_VIEW],
  [Activity, "Executions", "/executions", PERMISSIONS.EXECUTIONS_VIEW],
  [GitBranch, "CI / CD", "/ci-cd", PERMISSIONS.CI_CD_VIEW],
  [Users, "Team", "/team", PERMISSIONS.TEAM_VIEW],
  [ShieldCheck, "Roles", "/roles", PERMISSIONS.ROLES_VIEW],
  [CreditCard, "Billing", "/billing", PERMISSIONS.BILLING_VIEW]
];

/** Pages outside the main nav still need a gate. */
const extraRoutes: Record<string, Permission> = { "/settings": PERMISSIONS.SETTINGS_VIEW };

/** Placeholders shown until /me resolves, so the sidebar keeps its shape instead of reading "Loading…". */
export function NavSkeleton() {
  return <>{Array.from({ length: 6 }, (_, i) => <div className="nav-item skel-row" key={i}><span className="skel" style={{ width: 16, height: 16 }} /><span className="skel" style={{ width: `${50 + (i * 13) % 35}%`, height: 10 }} /></div>)}</>;
}
export function AccountSkeleton() {
  return <><span className="skel" style={{ width: 26, height: 26, borderRadius: "50%" }} /><div style={{ display: "grid", gap: 5, flex: 1 }}><span className="skel" style={{ width: "70%", height: 10 }} /><span className="skel" style={{ width: "40%", height: 9 }} /></div></>;
}

/** `switcher` replaces the org-name link at the top of the sidebar (the Overview page injects its project dropdown). */
export function AppShell({ children, activePath, switcher }: { children: React.ReactNode; activePath: string; switcher?: React.ReactNode }) {
  const me = useMe();
  const { resolved, setPreference } = useTheme();
  const [signingOut, setSigningOut] = useState(false);
  const [navOpen, setNavOpen] = useState(false);

  function signOut() {
    setSigningOut(true);
    apiToken.clear();
    window.location.assign("/signin");
  }

  // Unsubscribed orgs can browse; actions call requireSubscription(), which lands here.
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const paymentProblem = ["PAST_DUE", "BILLING_LOCKED"].includes(me?.organization?.subscription?.status ?? "");
  useEffect(() => {
    const open = () => setUpgradeOpen(true);
    window.addEventListener(upgradeEvent, open);
    return () => window.removeEventListener(upgradeEvent, open);
  }, []);

  // Block direct URL access to a module the role cannot open; send the user to the first one they can.
  useEffect(() => {
    if (!me || me.isSuperadmin && !me.role) return;
    const required = navigation.find(([, , href]) => href === activePath)?.[3] ?? extraRoutes[activePath];
    if (!required || can(me, required)) return;
    const fallback = navigation.find(([, , , permission]) => can(me, permission))?.[2] ?? "/settings";
    if (fallback !== activePath) window.location.assign(fallback);
  }, [me, activePath]);

  useEffect(() => {
    if (!navOpen) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setNavOpen(false); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [navOpen]);

  const initials = me ? me.displayName.split(/\s+/).map((part) => part[0]).slice(0, 2).join("").toUpperCase() : "…";
  const activeLabel = navigation.find(([, , href]) => href === activePath)?.[1] ?? (activePath === "/settings" ? "Settings" : "");

  return (
    <main className={navOpen ? "shell nav-open" : "shell"}>
      <header className="mobile-bar">
        <span className="brand"><BrandMark />{activeLabel || "ProoflineQA"}</span>
        <button className="icon-button" aria-label="Open navigation" aria-expanded={navOpen} onClick={() => setNavOpen(true)}><Menu size={20} /></button>
      </header>
      <div className="sidebar-scrim" onClick={() => setNavOpen(false)} />
      <aside className="sidebar" onClick={(event) => { if ((event.target as HTMLElement).closest("a")) setNavOpen(false); }}>
        <div className="brand"><BrandMark /><span>ProoflineQA</span></div>
        {switcher ?? <Link className="project-switcher" href="/projects"><span>{me ? <strong>{me.organization?.name ?? "Organization"}</strong> : <span className="skel" style={{ width: 120, height: 12 }} />}<small>{me?.organization?.subscription?.plan?.name ? `${me.organization.subscription.plan.name} plan` : "workspace"}</small></span></Link>}
        <nav aria-label="Main navigation" aria-busy={!me}>{!me ? <NavSkeleton /> : navigation.filter(([, , , permission]) => can(me, permission)).map(([Icon, label, href]) => <Link className={href === activePath ? "nav-item active" : "nav-item"} aria-current={href === activePath ? "page" : undefined} key={label} href={href}><Icon size={16} strokeWidth={1.8} />{label}</Link>)}</nav>
        <div className="sidebar-bottom">
          {can(me, PERMISSIONS.SETTINGS_VIEW) && <Link className={activePath === "/settings" ? "nav-item active" : "nav-item"} aria-current={activePath === "/settings" ? "page" : undefined} href="/settings"><Settings size={16} strokeWidth={1.8} />Settings</Link>}
          <div className="account">
            {me ? <><span>{initials}</span><div><strong>{me.displayName}</strong><small>{me.role ? me.role.charAt(0) + me.role.slice(1).toLowerCase() : ""}</small></div></> : <AccountSkeleton />}
            <button className="theme-toggle" title={resolved === "dark" ? "Switch to light theme" : "Switch to dark theme"} aria-label={resolved === "dark" ? "Switch to light theme" : "Switch to dark theme"} onClick={() => setPreference(resolved === "dark" ? "light" : "dark")}>{resolved === "dark" ? <Sun size={14} /> : <Moon size={14} />}</button>
            <button className="signout" title="Sign out" aria-label="Sign out" onClick={signOut} disabled={signingOut}><LogOut size={14} /></button>
          </div>
        </div>
      </aside>
      <section className="workspace">{children}</section>
      {upgradeOpen && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="upgrade-title" onClick={() => setUpgradeOpen(false)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <header><div><h2 id="upgrade-title">{paymentProblem ? "Payment needed to continue" : "Start a plan to use this"}</h2><p className="meta">{paymentProblem ? "your last payment did not go through" : "organization has no active plan"}</p></div><button className="icon-button" aria-label="Close" onClick={() => setUpgradeOpen(false)}><X size={16} /></button></header>
            <div className="modal-body"><p className="muted" style={{ lineHeight: 1.6 }}>{paymentProblem ? "Generating and running tests are paused until the payment succeeds. Update your card or pay the open invoice in Billing and everything resumes right away." : "Connecting providers, creating projects, generating and running tests need an active plan. Start a 14-day trial to unlock them."}</p></div>
            <footer>
              <button className="modal-cancel" onClick={() => setUpgradeOpen(false)}>Not now</button>
              {can(me, PERMISSIONS.BILLING_VIEW) ? <Link className="primary-button" href="/billing">{paymentProblem ? "Fix payment" : "View plans"}</Link> : <small className="dim">{paymentProblem ? "Ask an organization admin to update the payment method." : "Ask an organization admin to choose a plan."}</small>}
            </footer>
          </div>
        </div>
      )}
    </main>
  );
}
