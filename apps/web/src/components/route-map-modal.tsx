"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Pin, PinOff, Plus, RefreshCw, X } from "lucide-react";
import { api } from "@/lib/api";

interface RouteParam { name: string; in: "path" | "query"; samples: string[] }
interface RouteRow {
  id: string; pattern: string; label: string | null; navOrder: number | null; sources: string[];
  status: "DISCOVERED" | "VERIFIED" | "UNREACHABLE"; reason: string | null; pinned: boolean; excluded: boolean;
  params: RouteParam[] | null; apiCalls: string[]; lastVerifiedAt: string | null; fixture: Record<string, string> | null;
}

const statusText: Record<RouteRow["status"], string> = { VERIFIED: "verified", UNREACHABLE: "not reachable", DISCOVERED: "not opened" };

/**
 * The project's Route Map: every page the analysis found (live crawl + code + recordings),
 * whether it opened in the real app, and the values it needs. Only verified, non-excluded
 * pages get generated tests.
 */
export function RouteMapModal({ projectId, projectName, canEdit, onClose }: { projectId: string; projectName: string; canEdit: boolean; onClose: () => void }) {
  const [rows, setRows] = useState<RouteRow[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState("");
  const [values, setValues] = useState<Record<string, Record<string, string>>>({});
  const [filter, setFilter] = useState<"all" | "verified" | "problems">("all");

  const load = useCallback(async () => {
    try {
      setRows((await api<{ routes: RouteRow[] }>(`/v1/projects/${projectId}/routes`)).routes);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load the route map");
    }
  }, [projectId]);
  useEffect(() => { void load(); }, [load]);

  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(label);
    setError("");
    try { await fn(); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "The action failed"); }
    finally { setBusy(null); }
  }

  const patch = (row: RouteRow, body: Record<string, unknown>) => run(`patch-${row.id}`, () => api(`/v1/projects/${projectId}/routes/${row.id}`, { method: "PATCH", body }));
  const visible = (rows ?? []).filter((row) => filter === "all" ? true : filter === "verified" ? row.status === "VERIFIED" && !row.excluded : row.status !== "VERIFIED" || row.excluded);
  const counts = { verified: (rows ?? []).filter((row) => row.status === "VERIFIED" && !row.excluded).length, total: (rows ?? []).length };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Route map">
      <div className="modal route-map">
        <header>
          <div>
            <h2>Route map · {projectName}</h2>
            <p className="muted">{rows ? `${counts.verified} of ${counts.total} pages are verified and used for test generation.` : "Loading…"}</p>
          </div>
          <button className="icon-button" aria-label="Close" onClick={onClose}><X size={16} /></button>
        </header>
        <div className="modal-body">
          <div className="route-map-tools">
            <span className="brand-switch" role="group" aria-label="Filter routes">
              {(["all", "verified", "problems"] as const).map((key) => <button key={key} type="button" className={filter === key ? "seg on" : "seg"} aria-pressed={filter === key} onClick={() => setFilter(key)}>{key === "problems" ? "Needs attention" : key === "all" ? "All" : "Verified"}</button>)}
            </span>
            {canEdit && <form className="route-add" onSubmit={(event) => { event.preventDefault(); if (!adding.trim()) return; void run("add", async () => { await api(`/v1/projects/${projectId}/routes`, { method: "POST", body: { pattern: adding } }); setAdding(""); }); }}>
              <input value={adding} onChange={(event) => setAdding(event.target.value)} placeholder="/orders/:id or /reports/sales" aria-label="Add a route" />
              <button className="secondary-button" disabled={busy !== null || !adding.trim()}><Plus size={13} />Add</button>
            </form>}
          </div>
          {error && <p className="form-error">{error}</p>}
          {rows && rows.length === 0 && <p className="muted">No pages yet. Run Analyze to crawl the live app, or add a route above.</p>}
          <div className="route-list">
            {visible.map((row) => {
              const needed = (row.params ?? []).filter((param) => param.in === "path" || param.samples.length);
              const draft = values[row.id] ?? row.fixture ?? Object.fromEntries(needed.map((param) => [param.name, param.samples[0] ?? ""]));
              return (
                <div className={`route-row ${row.status.toLowerCase()}${row.excluded ? " excluded" : ""}`} key={row.id}>
                  <div className="route-main">
                    <strong>{row.label ?? row.pattern}</strong>
                    <code>{row.pattern}</code>
                    <div className="route-meta">
                      <span className={`chip route-status ${row.status.toLowerCase()}`}>{row.excluded ? "excluded" : statusText[row.status]}</span>
                      {row.sources.map((source) => <span className="chip" key={source}>{source}</span>)}
                      {row.apiCalls.length > 0 && <span className="chip" title={row.apiCalls.join("\n")}>{row.apiCalls.length} API call{row.apiCalls.length === 1 ? "" : "s"}</span>}
                    </div>
                    {row.reason && row.status !== "VERIFIED" && <small className="error-text">{row.reason}</small>}
                    {needed.length > 0 && (
                      <div className="route-values">
                        {needed.map((param) => (
                          <label key={param.name}>{param.name}<small>{param.in}</small>
                            <input disabled={!canEdit} value={draft[param.name] ?? ""} placeholder={param.samples[0] ?? "value"} onChange={(event) => setValues({ ...values, [row.id]: { ...draft, [param.name]: event.target.value } })} />
                          </label>
                        ))}
                        {canEdit && values[row.id] && <button className="mini-button" disabled={busy !== null} onClick={() => patch(row, { fixture: values[row.id] }).then(() => setValues(({ [row.id]: _saved, ...rest }) => rest))}><Check size={12} />Save values</button>}
                      </div>
                    )}
                  </div>
                  {canEdit && <div className="route-actions">
                    <button className="mini-button" disabled={busy !== null} onClick={() => run(`verify-${row.id}`, () => api(`/v1/projects/${projectId}/routes/${row.id}/verify`, { method: "POST" }))}><RefreshCw size={12} />{busy === `verify-${row.id}` ? "Opening…" : "Verify"}</button>
                    <button className="mini-button" disabled={busy !== null} aria-pressed={row.pinned} title={row.pinned ? "Unpin" : "Pin: generate first"} onClick={() => patch(row, { pinned: !row.pinned })}>{row.pinned ? <PinOff size={12} /> : <Pin size={12} />}</button>
                    <button className="mini-button" disabled={busy !== null} onClick={() => patch(row, { excluded: !row.excluded })}>{row.excluded ? "Include" : "Exclude"}</button>
                  </div>}
                </div>
              );
            })}
          </div>
        </div>
        <footer>
          <button className="modal-cancel" onClick={onClose}>Close</button>
        </footer>
      </div>
    </div>
  );
}
