"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, CircleHelp, Trash2, UserPlus, X } from "lucide-react";
import Link from "next/link";
import { PERMISSIONS, APP_ROLES, appRoles } from "@ai-qa/domain";
import { AppShell } from "@/components/app-shell";
import { Select } from "@/components/select";
import { api, fmtDate } from "@/lib/api";
import { can, useMe, useToast } from "@/lib/hooks";

const roleNames: Record<string, string> = { ADMIN: "Admin", QA: "QA", DEVELOPER: "Developer" };

interface Member { userId: string; email: string; displayName: string; role: string; joinedAt: string }

export default function TeamPage() {
  const me = useMe();
  const { toast, notify } = useToast();
  const [members, setMembers] = useState<Member[] | null>(null);
  const [invite, setInvite] = useState<{ email: string; displayName: string; role: string } | null>(null);
  const [tempPassword, setTempPassword] = useState<{ email: string; password: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const isAdmin = can(me, PERMISSIONS.TEAM_MANAGE);

  const reload = useCallback(async () => {
    try {
      setMembers(await api<Member[]>("/v1/team"));
    } catch (error) {
      notify(error instanceof Error ? error.message : "Unable to load the team", "error");
    }
  }, [notify]);

  useEffect(() => { void reload(); }, [reload]);

  async function act(label: string, fn: () => Promise<unknown>, success: string) {
    setBusy(label);
    try { await fn(); notify(success, "success"); await reload(); }
    catch (error) { notify(error instanceof Error ? error.message : "The action failed", "error"); }
    finally { setBusy(null); }
  }

  async function submitInvite() {
    if (!invite) return;
    setBusy("invite");
    try {
      const result = await api<{ temporaryPassword?: string }>("/v1/team/invite", { method: "POST", body: invite });
      setTempPassword({ email: invite.email, password: result.temporaryPassword ?? "(the password you set)" });
      setInvite(null);
      notify("Member invited.", "success");
      await reload();
    } catch (error) {
      notify(error instanceof Error ? error.message : "Unable to invite", "error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <AppShell activePath="/team">
      <header className="page-header">
        <div>
          <h1>Team</h1>
          <p className="muted">{members ? `${members.length} member${members.length === 1 ? "" : "s"} · Admins manage users, billing, and approvals` : "Loading…"}</p>
        </div>
        <div className="heading-actions">
          {can(me, PERMISSIONS.ROLES_VIEW) && <Link className="secondary-button" href="/roles">Manage roles</Link>}
          {isAdmin && <button className="primary-button" onClick={() => setInvite({ email: "", displayName: "", role: APP_ROLES.QA })}><UserPlus size={16} />Invite member</button>}
        </div>
      </header>

      {!isAdmin && <section className="banner"><CircleHelp size={15} />Only organization admins can manage members. You have read-only access.</section>}

      {!members ? <section className="loading-state">Loading team…</section> : (
        <section className="team-table">
          <div className="team-head"><span>Member</span><span>Role</span><span>Joined</span><span /></div>
          {members.map((member) => (
            <article className="team-row" key={member.userId}>
              <div className="member"><span className="avatar">{member.displayName.split(/\s+/).map((part) => part[0]).slice(0, 2).join("").toUpperCase()}</span><div><strong>{member.displayName}</strong><small>{member.email}</small></div></div>
              {isAdmin ? (
                <Select value={member.role} ariaLabel={`Role for ${member.displayName}`} onChange={(role) => act(`role-${member.userId}`, () => api(`/v1/team/${member.userId}/role`, { method: "PATCH", body: { role } }), "Role updated.")} disabled={busy !== null} options={appRoles.map((role) => ({ value: role, label: roleNames[role] ?? role }))} />
              ) : <span className="chip tag">{member.role}</span>}
              <small className="dim">{fmtDate(member.joinedAt)}</small>
              {isAdmin && <button className="mini-button danger" title="Remove member" disabled={busy !== null || member.userId === me?.id} onClick={() => { if (window.confirm(`Remove ${member.displayName} from the organization?`)) void act(`remove-${member.userId}`, () => api(`/v1/team/${member.userId}`, { method: "DELETE" }), "Member removed."); }}><Trash2 size={13} /></button>}
            </article>
          ))}
        </section>
      )}

      {invite && (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal">
            <header><div><h2>Add a team member</h2></div><button className="icon-button" aria-label="Close" onClick={() => setInvite(null)}><X size={16} /></button></header>
            <div className="modal-body">
              <div className="field-grid">
                <label className="span2">Full name<input value={invite.displayName} onChange={(event) => setInvite({ ...invite, displayName: event.target.value })} placeholder="Jamie Rivera" /></label>
                <label className="span2">Work email<input type="email" value={invite.email} onChange={(event) => setInvite({ ...invite, email: event.target.value })} placeholder="jamie@company.com" /></label>
                <label className="span2">Role
                  <Select value={invite.role} onChange={(role) => setInvite({ ...invite, role })} options={[
                    { value: APP_ROLES.ADMIN, label: "Admin", hint: "full control including billing" },
                    { value: APP_ROLES.QA, label: "QA", hint: "review, approve, and execute tests" },
                    { value: APP_ROLES.DEVELOPER, label: "Developer", hint: "view results and connect repos" }
                  ]} />
                </label>
              </div>
              <p className="dim">A temporary password is generated for the new member. Share it securely; they can change it later.</p>
            </div>
            <footer>
              <button className="modal-cancel" onClick={() => setInvite(null)}>Cancel</button>
              <button className="primary-button" onClick={submitInvite} disabled={busy !== null || !invite.email.trim() || !invite.displayName.trim()}>{busy === "invite" ? "Inviting…" : "Send invite"}</button>
            </footer>
          </div>
        </div>
      )}

      {tempPassword && (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal">
            <header><div><h2>Share the temporary password</h2></div><button className="icon-button" aria-label="Close" onClick={() => setTempPassword(null)}><X size={16} /></button></header>
            <div className="modal-body">
              <p>{tempPassword.email} can sign in with:</p>
              <p className="temp-password"><code>{tempPassword.password}</code></p>
              <p className="dim">This is shown once. Copy it now and share it through a secure channel.</p>
            </div>
            <footer><button className="primary-button" onClick={async () => { await navigator.clipboard?.writeText(tempPassword.password).catch(() => undefined); setTempPassword(null); }}>Copy &amp; close</button></footer>
          </div>
        </div>
      )}

      {toast && <div className={`toast ${toast.tone}`}>{toast.tone === "success" ? <Check size={17} /> : toast.tone === "error" ? <X size={17} /> : <CircleHelp size={17} />}{toast.message}</div>}
    </AppShell>
  );
}
