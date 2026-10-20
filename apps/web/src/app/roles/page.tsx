"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, CircleHelp, Lock, RotateCcw, Save, X } from "lucide-react";
import { PERMISSIONS, APP_ROLES, permissionModules, type Permission } from "@ai-qa/domain";
import { AppShell } from "@/components/app-shell";
import { api } from "@/lib/api";
import { can, publishMe, useMe, useToast, type MePayload } from "@/lib/hooks";

interface RoleDto { role: APP_ROLES; locked: boolean; permissions: Permission[]; defaults: Permission[] }

const moduleLabels: Record<string, string> = { dashboard: "Overview", projects: "Projects", test_cases: "Test cases", executions: "Executions", ci_cd: "CI / CD", team: "Team", billing: "Billing", settings: "Settings", roles: "Roles" };
const roleLabel = (role: string) => role.charAt(0) + role.slice(1).toLowerCase();

export default function RolesPage() {
  const me = useMe();
  const { toast, notify } = useToast();
  const [roles, setRoles] = useState<RoleDto[] | null>(null);
  const [active, setActive] = useState<APP_ROLES>(APP_ROLES.QA);
  const [draft, setDraft] = useState<Permission[]>([]);
  const [busy, setBusy] = useState(false);

  const canManage = can(me, PERMISSIONS.ROLES_MANAGE);
  const current = roles?.find((role) => role.role === active);
  const readOnly = !canManage || !!current?.locked;
  const dirty = !!current && [...draft].sort().join() !== [...current.permissions].sort().join();

  const load = useCallback(async () => {
    try {
      const result = await api<{ roles: RoleDto[] }>("/v1/roles");
      setRoles(result.roles);
    } catch (error) {
      notify(error instanceof Error ? error.message : "Unable to load roles", "error");
    }
  }, [notify]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (current) setDraft(current.permissions); }, [current]);

  function toggle(module: string, action: string) {
    const key = `${module}:${action}` as Permission;
    setDraft((previous) => {
      if (previous.includes(key)) {
        // Removing "view" closes the whole module.
        return previous.filter((permission) => action === "view" ? !permission.startsWith(`${module}:`) : permission !== key);
      }
      return [...previous, key];
    });
  }

  async function save(request: () => Promise<unknown>, success: string) {
    setBusy(true);
    try {
      await request();
      notify(success, "success");
      await load();
      // Refresh the signed-in user too: their own role may be the one that changed.
      publishMe(await api<MePayload>("/v1/auth/me"));
    } catch (error) {
      notify(error instanceof Error ? error.message : "The action failed", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppShell activePath="/roles">
      <header className="page-header">
        <div>
          <h1>Roles</h1>
          <p className="muted">Choose which modules and actions each role can use. Changes apply on the member&apos;s next request.</p>
        </div>
        <div className="heading-actions">
          {!readOnly && <button className="secondary-button" disabled={busy} onClick={() => void save(() => api(`/v1/roles/${active}/reset`, { method: "POST" }), "Permissions reset to defaults.")}><RotateCcw size={16} />Reset to defaults</button>}
          {!readOnly && <button className="primary-button" disabled={busy || !dirty} onClick={() => void save(() => api(`/v1/roles/${active}`, { method: "PUT", body: { permissions: draft } }), "Permissions saved.")}><Save size={16} />Save changes</button>}
        </div>
      </header>

      {me && !canManage && <section className="banner"><CircleHelp size={15} />You can view roles but not change them.</section>}

      <div className="settings-tabs" role="tablist">
        {roles?.map(({ role, locked }) => (
          <button key={role} role="tab" aria-selected={role === active} className={role === active ? "active" : ""} onClick={() => setActive(role)}>{locked && <Lock size={12} />} {roleLabel(role)}</button>
        ))}
      </div>

      {current?.locked && <section className="banner"><Lock size={15} />Admins always have full access, so this role cannot be changed.</section>}

      {!roles ? <section className="loading-state">Loading roles…</section> : (
        <section className="team-table roles-table">
          <div className="roles-head"><span>Module</span><span>Permissions</span></div>
          {(Object.keys(permissionModules) as (keyof typeof permissionModules)[]).map((module) => (
            <div className="roles-row" key={module}>
              <strong>{moduleLabels[module]}</strong>
              <div className="roles-actions">
                {permissionModules[module].map((action) => {
                  const key = `${module}:${action}` as Permission;
                  const checked = draft.includes(key);
                  const needsView = action !== "view" && !draft.includes(`${module}:view` as Permission);
                  return (
                    <label key={action} className={`perm-check${checked ? " on" : ""}`}>
                      <input type="checkbox" checked={checked} disabled={readOnly || busy || needsView} onChange={() => toggle(module, action)} />
                      {action.replace("_", " ")}
                    </label>
                  );
                })}
              </div>
            </div>
          ))}
        </section>
      )}

      {toast && <div className={`toast ${toast.tone}`}>{toast.tone === "success" ? <Check size={17} /> : toast.tone === "error" ? <X size={17} /> : <CircleHelp size={17} />}{toast.message}</div>}
    </AppShell>
  );
}
