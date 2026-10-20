"use client";

import { FormEvent, useState } from "react";
import { BadgeCheck, KeyRound, Monitor, Moon, Save, Sun } from "lucide-react";
import { api } from "@/lib/api";
import { publishMe, type MePayload } from "@/lib/hooks";
import { useTheme, type ThemePreference } from "@/lib/theme";

type Notify = (message: string, tone?: "info" | "success" | "error") => void;

const roleLabel = (role: string | null) => role ? role.charAt(0) + role.slice(1).toLowerCase() : "—";

export function PersonalSettings({ me, notify }: { me: MePayload | null; notify: Notify }) {
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [savingProfile, setSavingProfile] = useState(false);
  const [savingPassword, setSavingPassword] = useState(false);
  const [passwordError, setPasswordError] = useState("");
  const { preference, setPreference } = useTheme();

  const name = displayName ?? me?.displayName ?? "";
  const dirty = !!me && name.trim() !== me.displayName && name.trim().length > 0;
  const initials = (me?.displayName ?? "").split(/\s+/).map((part) => part[0]).slice(0, 2).join("").toUpperCase() || "…";

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!dirty) return;
    setSavingProfile(true);
    try {
      publishMe(await api<MePayload>("/v1/auth/me", { method: "PATCH", body: { displayName: name.trim() } }));
      setDisplayName(null);
      notify("Profile updated.", "success");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Unable to update your profile", "error");
    } finally {
      setSavingProfile(false);
    }
  }

  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setPasswordError("");
    if (form.get("newPassword") !== form.get("confirmPassword")) { setPasswordError("The new passwords don't match."); return; }
    setSavingPassword(true);
    try {
      await api("/v1/auth/change-password", { method: "POST", body: { currentPassword: form.get("currentPassword"), newPassword: form.get("newPassword") } });
      formElement.reset();
      notify("Password changed. We emailed you a confirmation.", "success");
    } catch (error) {
      setPasswordError(error instanceof Error ? error.message : "Unable to change your password");
    } finally {
      setSavingPassword(false);
    }
  }

  return (
    <section className="settings-grid">
      <section className="panel">
        <div className="panel-heading"><div><h2>Profile</h2><p className="muted">How you appear to your team in reviews, approvals and audit history.</p></div></div>
        <form className="profile-form" onSubmit={saveProfile}>
          <div className="profile-identity"><span className="profile-avatar" aria-hidden>{initials}</span><div><strong>{me?.displayName ?? "Loading…"}</strong><small>{roleLabel(me?.role ?? null)} · {me?.organization?.name ?? ""}</small></div></div>
          <div className="form-grid">
            <label className="wide">Full name<input value={name} onChange={(event) => setDisplayName(event.target.value)} maxLength={80} required autoComplete="name" disabled={!me} /></label>
            <label className="wide"><span className="label-row">Email{me?.emailVerifiedAt && <span className="verified-chip"><BadgeCheck size={12} />Verified</span>}</span><input value={me?.email ?? ""} readOnly aria-describedby="email-hint" /><small id="email-hint" className="field-hint">Your sign-in address. Contact support to change it.</small></label>
          </div>
          <div className="settings-actions"><button className="run-button" disabled={!dirty || savingProfile}><Save size={14} />{savingProfile ? "Saving…" : "Save changes"}</button>{dirty && <button type="button" className="secondary-button" onClick={() => setDisplayName(null)}>Discard</button>}</div>
        </form>
      </section>

      <section className="panel">
        <div className="panel-heading"><div><h2>Account</h2></div></div>
        <dl className="detail-grid stacked">
          <div><dt>Organization</dt><dd>{me?.organization?.name ?? "—"}</dd></div>
          <div><dt>Role</dt><dd>{roleLabel(me?.role ?? null)}</dd></div>
          <div><dt>Member since</dt><dd>{me?.createdAt ? new Date(me.createdAt).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }) : "—"}</dd></div>
          <div><dt>Session</dt><dd>Access tokens expire after 8 hours. Sign out from the sidebar to end this session.</dd></div>
        </dl>
      </section>

      <section className="panel span-full">
        <div className="appearance">
          <div><h2>Appearance</h2><p>Dark matches the Proofline site. System follows your OS setting. Saved on this device.</p></div>
          <div className="view-toggle" role="radiogroup" aria-label="Theme">
            {([["dark", "Dark", Moon], ["light", "Light", Sun], ["system", "System", Monitor]] as [ThemePreference, string, typeof Moon][]).map(([value, label, Icon]) => (
              <button key={value} type="button" role="radio" aria-checked={preference === value} className={preference === value ? "seg on" : "seg"} onClick={() => setPreference(value)}><Icon size={13} />{label}</button>
            ))}
          </div>
        </div>
      </section>

      <section className="panel span-full">
        <div className="panel-heading"><div><h2>Password</h2><p className="muted">Use at least 12 characters. You stay signed in here, and we email you to confirm the change.</p></div></div>
        <form className="password-form" onSubmit={changePassword}>
          <input type="email" name="username" autoComplete="username" value={me?.email ?? ""} readOnly hidden />
          <div className="form-grid three">
            <label>Current password<input name="currentPassword" type="password" required autoComplete="current-password" /></label>
            <label>New password<input name="newPassword" type="password" minLength={12} required autoComplete="new-password" placeholder="At least 12 characters" /></label>
            <label>Confirm new password<input name="confirmPassword" type="password" minLength={12} required autoComplete="new-password" /></label>
          </div>
          {passwordError && <p className="form-message error" role="alert">{passwordError}</p>}
          <div className="settings-actions"><button className="run-button" disabled={savingPassword}><KeyRound size={14} />{savingPassword ? "Updating…" : "Update password"}</button><a className="text-link" href="/forgot-password">Forgot your current password?</a></div>
        </form>
      </section>
    </section>
  );
}
