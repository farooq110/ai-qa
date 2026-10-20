"use client";

import { useState } from "react";
import { Check, Copy, X } from "lucide-react";
import { api } from "@/lib/api";

/**
 * Registers a self-managed GitLab instance: its URL plus the OAuth application the organization
 * created on it. GitHub, Bitbucket and GitLab.com need none of this — they use the platform's apps.
 * The client secret is write-only: it is sent to the API once and never displayed again.
 */
export function GitlabInstanceModal({ baseUrl, clientId, redirectUri, onClose, onSaved }: {
  baseUrl: string | null;
  clientId: string | null;
  redirectUri: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [url, setUrl] = useState(baseUrl ?? "");
  const [id, setId] = useState(clientId ?? "");
  const [secret, setSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const applicationsUrl = /^https:\/\/[^/]+/.test(url.trim()) ? `${url.trim().replace(/\/+$/, "")}/-/user_settings/applications` : null;

  function copyRedirect() {
    void navigator.clipboard.writeText(redirectUri).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  async function save() {
    setSaving(true);
    setError("");
    try {
      await api("/v1/repository-connections/gitlab/self-managed", { method: "PUT", body: { baseUrl: url.trim(), clientId: id.trim(), clientSecret: secret.trim() } });
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save the GitLab instance");
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="gitlab-instance-title">
      <div className="modal">
        <header>
          <div><h2 id="gitlab-instance-title">{clientId ? "Update" : "Add"} self-managed GitLab</h2></div>
          <button className="icon-button" aria-label="Close" onClick={onClose}><X size={16} /></button>
        </header>
        <div className="modal-body">
          <p className="oauth-intro">For GitLab running on your own servers. Using gitlab.com? Close this and use <strong>Connect GitLab</strong> instead.</p>
          <ol className="oauth-steps">
            <li>On your instance, open {applicationsUrl ? <a className="text-link" href={applicationsUrl} target="_blank" rel="noreferrer">User settings → Applications</a> : "User settings → Applications"} and add an application with the <code>api</code> scope.</li>
            <li>
              Set its redirect URI to:
              <span className="oauth-redirect-row">
                <code>{redirectUri}</code>
                <button type="button" className="mini-button" onClick={copyRedirect} aria-label="Copy redirect URI">{copied ? <Check size={12} /> : <Copy size={12} />}{copied ? "Copied" : "Copy"}</button>
              </span>
            </li>
            <li>Paste the instance URL and the application&apos;s ID and secret below.</li>
          </ol>
          <div className="oauth-fields">
            <label className="span-full">Instance URL<input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://gitlab.example.com" autoComplete="off" inputMode="url" /></label>
            <label>Application ID<input value={id} onChange={(event) => setId(event.target.value)} placeholder={clientId ?? ""} autoComplete="off" /></label>
            <label>Secret<input type="password" value={secret} onChange={(event) => setSecret(event.target.value)} placeholder="stored encrypted" autoComplete="new-password" /></label>
          </div>
          <small className="field-hint">The secret is stored encrypted and never shown again. Only organization admins can replace or remove it.</small>
          {error && <p className="form-error">{error}</p>}
        </div>
        <footer>
          <button className="modal-cancel" onClick={onClose}>Cancel</button>
          <button className="primary-button" onClick={save} disabled={saving || !url.trim() || !id.trim() || !secret.trim()}><Check size={15} />{saving ? "Saving…" : "Save & connect"}</button>
        </footer>
      </div>
    </div>
  );
}
