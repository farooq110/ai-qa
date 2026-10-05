"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, CircleHelp, KeyRound, Plus, Trash2, Webhook, X } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { api, fmtRelative } from "@/lib/api";
import { useProjects, useToast } from "@/lib/hooks";

interface ConnectionDto { id: string; provider: string; label: string; tokenHint: string; lastUsedAt: string | null; createdAt: string }
interface RequestDto { id: string; provider: string; branch: string; commitSha: string; pipelineId: string | null; status: string; createdAt: string }

const providerLabels: Record<string, string> = {
  GITHUB_ACTIONS: "GitHub Actions",
  GITLAB_CI: "GitLab CI",
  BITBUCKET_PIPELINES: "Bitbucket Pipelines"
};

export default function CiCdPage() {
  const { selected } = useProjects();
  const { toast, notify } = useToast();
  const [connections, setConnections] = useState<ConnectionDto[] | null>(null);
  const [requests, setRequests] = useState<RequestDto[]>([]);
  const [creating, setCreating] = useState<{ provider: string; label: string } | null>(null);
  const [newToken, setNewToken] = useState<{ token: string; provider: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!selected) { setConnections(null); return; }
    try {
      const [connections, requests] = await Promise.all([
        api<ConnectionDto[]>(`/v1/projects/${selected.id}/ci/connections`),
        api<RequestDto[]>(`/v1/projects/${selected.id}/ci/requests`)
      ]);
      setConnections(connections);
      setRequests(requests);
    } catch (error) {
      notify(error instanceof Error ? error.message : "Unable to load CI integrations", "error");
    }
  }, [selected, notify]);

  useEffect(() => { void reload(); }, [reload]);

  async function act(label: string, fn: () => Promise<unknown>, success: string) {
    setBusy(label);
    try { await fn(); notify(success, "success"); await reload(); }
    catch (error) { notify(error instanceof Error ? error.message : "The action failed", "error"); }
    finally { setBusy(null); }
  }

  const curlExample = (token: string) => `curl -X POST http://localhost:4000/v1/ci/push \\
  -H "Content-Type: application/json" \\
  -d '{"token":"${token}","branch":"$CI_BRANCH","commitSha":"$CI_COMMIT","pipelineId":"$CI_PIPELINE_ID"}'`;

  return (
    <AppShell activePath="/ci-cd">
      <header className="page-header">
        <div>
          <p className="eyebrow">CI / CD</p>
          <h1>Pipeline integrations</h1>
          <p className="muted">{selected ? `${selected.name} · every push to a connected pipeline runs the approved suite against the exact commit` : "Select a project to manage its pipelines."}</p>
        </div>
        <div className="heading-actions">
          <button className="primary-button" disabled={!selected} onClick={() => setCreating({ provider: "GITHUB_ACTIONS", label: "" })}><Plus size={16} />New connection</button>
        </div>
      </header>

      {!selected ? <section className="empty-state"><h2>No project selected</h2><p>Create a project first.</p></section> : <>
        <section className="ci-grid">
          <div className="panel">
            <div className="panel-heading"><div><p className="eyebrow">CONNECTIONS</p><h2>Pipeline tokens</h2></div></div>
            {!connections ? <p className="dim">Loading…</p> : connections.length === 0 ? <p className="dim">No connections yet. Create a token and add it as a secret in your pipeline.</p> : (
              <div className="ci-list">
                {connections.map((connection) => (
                  <div className="ci-row" key={connection.id}>
                    <Webhook size={15} />
                    <div><strong>{connection.label || (providerLabels[connection.provider] ?? connection.provider)}</strong><small>{providerLabels[connection.provider] ?? connection.provider} · token {connection.tokenHint}… · {connection.lastUsedAt ? `last used ${fmtRelative(connection.lastUsedAt)}` : "never used"}</small></div>
                    <button className="mini-button danger" aria-label="Revoke" disabled={busy !== null} onClick={() => { if (window.confirm(`Revoke the ${connection.label || connection.provider} token? Pipelines using it will fail.`)) void act(`revoke-${connection.id}`, () => api(`/v1/projects/${selected.id}/ci/connections/${connection.id}`, { method: "DELETE" }), "Connection revoked."); }}><Trash2 size={13} /></button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="panel">
            <div className="panel-heading"><div><p className="eyebrow">HOW IT WORKS</p><h2>Push webhook contract</h2></div></div>
            <ol className="how-list">
              <li>Create a connection token and store it as a pipeline secret (e.g. <code>PROOFLINE_TOKEN</code>).</li>
              <li>On every push, POST the branch and exact commit SHA to the webhook.</li>
              <li>The platform queues all approved tests pinned to that commit and reports status back here.</li>
              <li>Pending, rejected, or unapproved tests never run in CI.</li>
            </ol>
          </div>
        </section>

        <section className="panel span-full">
          <div className="panel-heading"><div><p className="eyebrow">HISTORY</p><h2>CI execution requests</h2></div></div>
          {requests.length === 0 ? <p className="dim">No pipeline pushes recorded yet.</p> : (
            <div className="ci-requests">
              <div className="ci-req-head"><span>When</span><span>Provider</span><span>Branch</span><span>Commit</span><span>Status</span></div>
              {requests.map((request) => (
                <div className="ci-req-row" key={request.id}>
                  <small>{fmtRelative(request.createdAt)}</small>
                  <span>{providerLabels[request.provider] ?? request.provider}</span>
                  <code>{request.branch}</code>
                  <code>{request.commitSha.slice(0, 7)}</code>
                  <span className={`status ${request.status === "QUEUED" ? "approved" : request.status === "ACCEPTED" ? "pending-review" : "needs-review"}`}>{request.status.replace(/_/g, " ").toLowerCase()}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      </>}

      {creating && selected && (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal">
            <header><div><p className="eyebrow">NEW CONNECTION</p><h2>Create a pipeline token</h2></div><button className="icon-button" aria-label="Close" onClick={() => setCreating(null)}><X size={16} /></button></header>
            <div className="modal-body">
              <div className="field-grid">
                <label className="span2">Provider
                  <select value={creating.provider} onChange={(event) => setCreating({ ...creating, provider: event.target.value })}>
                    {Object.entries(providerLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                </label>
                <label className="span2">Label (optional)<input value={creating.label} onChange={(event) => setCreating({ ...creating, label: event.target.value })} placeholder="Main repo pipeline" /></label>
              </div>
            </div>
            <footer>
              <button className="modal-cancel" onClick={() => setCreating(null)}>Cancel</button>
              <button className="primary-button" onClick={async () => {
                setBusy("create");
                try {
                  const created = await api<{ token: string }>(`/v1/projects/${selected.id}/ci/connections`, { method: "POST", body: creating });
                  setNewToken({ token: created.token, provider: creating.provider });
                  setCreating(null);
                  await reload();
                } catch (error) {
                  notify(error instanceof Error ? error.message : "Unable to create the connection", "error");
                } finally {
                  setBusy(null);
                }
              }} disabled={busy === "create"}><KeyRound size={15} />Create token</button>
            </footer>
          </div>
        </div>
      )}

      {newToken && (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal wide">
            <header><div><p className="eyebrow">TOKEN CREATED</p><h2>Copy it now — it is shown once</h2></div><button className="icon-button" aria-label="Close" onClick={() => setNewToken(null)}><X size={16} /></button></header>
            <div className="modal-body">
              <p className="temp-password"><code>{newToken.token}</code></p>
              <h3 className="modal-subhead">Call this from your pipeline on push</h3>
              <pre className="code-block">{curlExample(newToken.token)}</pre>
            </div>
            <footer><button className="primary-button" onClick={async () => { await navigator.clipboard?.writeText(newToken.token).catch(() => undefined); setNewToken(null); }}>Copy token &amp; close</button></footer>
          </div>
        </div>
      )}

      {toast && <div className={`toast ${toast.tone}`}>{toast.tone === "success" ? <Check size={17} /> : toast.tone === "error" ? <X size={17} /> : <CircleHelp size={17} />}{toast.message}</div>}
    </AppShell>
  );
}
