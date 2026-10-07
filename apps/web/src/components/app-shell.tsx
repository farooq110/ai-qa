"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Activity, CreditCard, FolderKanban, GitBranch, LayoutDashboard, LogOut, Settings, TestTube2, Users } from "lucide-react";
import { apiToken } from "@/lib/api";
import { useMe } from "@/lib/hooks";

const navigation = [
  [LayoutDashboard, "Overview", "/dashboard"],
  [FolderKanban, "Projects", "/projects"],
  [TestTube2, "Test cases", "/test-cases"],
  [Activity, "Executions", "/executions"],
  [GitBranch, "CI / CD", "/ci-cd"],
  [Users, "Team", "/team"],
  [CreditCard, "Billing", "/billing"]
] as const;

export function AppShell({ children, activePath }: { children: React.ReactNode; activePath: string }) {
  const me = useMe();
  const [signingOut, setSigningOut] = useState(false);

  function signOut() {
    setSigningOut(true);
    apiToken.clear();
    window.location.assign("/signin");
  }

  // Signed up but never completed Checkout: the only usable page is Billing.
  useEffect(() => {
    if (me?.organization?.subscription?.status === "INCOMPLETE" && activePath !== "/billing") window.location.assign("/billing");
  }, [me, activePath]);

  const initials = me ? me.displayName.split(/\s+/).map((part) => part[0]).slice(0, 2).join("").toUpperCase() : "…";

  return (
    <main className="shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">P</span><span>proofline</span></div>
        <Link className="project-switcher" href="/projects"><span><strong>{me?.organization?.name ?? "Organization"}</strong><small>{me?.organization?.subscription?.plan?.name ? `${me.organization.subscription.plan.name} plan` : "Workspace"}</small></span></Link>
        <nav aria-label="Main navigation">{navigation.map(([Icon, label, href]) => <Link className={href === activePath ? "nav-item active" : "nav-item"} key={label} href={href}><Icon size={18} />{label}</Link>)}</nav>
        <div className="sidebar-bottom">
          <Link className={activePath === "/settings" ? "nav-item active" : "nav-item"} href="/settings"><Settings size={18} />Settings</Link>
          <div className="account"><span>{initials}</span><div><strong>{me?.displayName ?? "Loading…"}</strong><small>{me?.role ? me.role.charAt(0) + me.role.slice(1).toLowerCase() : ""}</small></div><button className="signout" title="Sign out" aria-label="Sign out" onClick={signOut} disabled={signingOut}><LogOut size={15} /></button></div>
        </div>
      </aside>
      <section className="workspace">{children}</section>
    </main>
  );
}
