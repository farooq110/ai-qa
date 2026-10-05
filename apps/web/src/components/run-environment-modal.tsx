"use client";

import { useState } from "react";
import { Globe, X } from "lucide-react";
import { api } from "@/lib/api";

/**
 * Shown when the user tries to run tests on a project that has no environments yet.
 * Lets them create one inline, then hands the new environment id back to the caller
 * so the run can continue without a detour to Settings.
 */
export function RunEnvironmentModal({ projectId, onClose, onReady }: { projectId: string; onClose: () => void; onReady: (environmentId: string) => void }) {
  const [name, setName] = useState("Local");
  const [url, setUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function createAndContinue() {
    setSaving(true);
    setError("");
    try {
      const environment = await api<{ id: string }>(`/v1/projects/${projectId}/environments`, { method: "POST", body: { name: name.trim(), url: url.trim(), isDefault: true } });
      onReady(environment.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to create the environment");
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal">
        <header>
          <div><p className="eyebrow">PICK A TARGET</p><h2>Add an environment to run against</h2></div>
          <button className="icon-button" aria-label="Close" onClick={onClose}><X size={16} /></button>
        </header>
        <div className="modal-body">
          <p className="muted">Executions drive a real browser against a deployed application, so they need a target URL. This environment becomes the project default — make sure it matches the code revision the tests were generated from.</p>
          <div className="field-grid">
            <label>Name<input value={name} onChange={(event) => setName(event.target.value)} placeholder="Staging" /></label>
            <label>URL<input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://staging.example.com" /></label>
          </div>
          {error && <p className="form-error">{error}</p>}
        </div>
        <footer>
          <button className="modal-cancel" onClick={onClose}>Cancel</button>
          <button className="primary-button" onClick={createAndContinue} disabled={saving || !name.trim() || !url.trim()}><Globe size={15} />{saving ? "Saving…" : "Create & continue"}</button>
        </footer>
      </div>
    </div>
  );
}
