"use client";

import { FormEvent, useEffect, useState } from "react";
import { ArrowLeft, Check, Download, GitBranch, Globe, Lock, Search, Settings2, X } from "lucide-react";
import { BitbucketIcon, GithubIcon, GitlabIcon } from "@/components/brand-icons";
import { Select } from "@/components/select";
import { api, type ProjectSummaryDto } from "@/lib/api";

interface ConnectionDto { id: string; provider: "GITHUB" | "BITBUCKET" | "GITLAB"; baseUrl: string; accountLogin: string }
interface RepositoryDto { externalId: string; fullName: string; private: boolean; defaultBranch: string; url: string }

const providers = [
  { key: "github", label: "GitHub", Icon: GithubIcon },
  { key: "bitbucket", label: "Bitbucket", Icon: BitbucketIcon },
  { key: "gitlab", label: "GitLab", Icon: GitlabIcon }
] as const;
const providerFor = (connection: ConnectionDto) => providers.find((provider) => provider.key === connection.provider.toLowerCase())!;
const accountLabel = (connection: ConnectionDto) => `${connection.accountLogin} · ${connection.baseUrl ? connection.baseUrl.replace(/^https?:\/\//, "") : providerFor(connection).label}`;

/** Sends the browser through the provider's connect flow and back to /projects, which reopens this modal. */
async function connect(provider: string) {
  const { url } = await api<{ url: string }>(`/v1/repository-connections/${provider}/authorize?returnTo=/projects`);
  window.location.assign(url);
}

/**
 * Import a repository the way Vercel does: pick a connected account, pick one of the repositories it
 * can see, confirm name / branch / root directory. No URLs to paste, no OAuth apps to register.
 */
export function ImportRepositoryModal({ canConnect, onClose, onImported }: {
  canConnect: boolean;
  onClose: () => void;
  onImported: (project: ProjectSummaryDto) => void;
}) {
  const [connections, setConnections] = useState<ConnectionDto[] | null>(null);
  const [connectionId, setConnectionId] = useState("");
  const [search, setSearch] = useState("");
  const [repositories, setRepositories] = useState<RepositoryDto[] | null>(null);
  const [picked, setPicked] = useState<RepositoryDto | null>(null);
  const [branches, setBranches] = useState<string[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const connection = connections?.find((candidate) => candidate.id === connectionId) ?? null;

  useEffect(() => {
    api<ConnectionDto[]>("/v1/repository-connections")
      .then((rows) => { setConnections(rows); setConnectionId(rows[0]?.id ?? ""); })
      .catch((cause) => { setConnections([]); setError(cause instanceof Error ? cause.message : "Unable to load connected accounts"); });
  }, []);

  // Search runs on the provider (GitLab/Bitbucket accounts often see thousands of repositories).
  useEffect(() => {
    if (!connectionId) return;
    let cancelled = false;
    setRepositories(null);
    setError("");
    const timer = window.setTimeout(() => {
      api<RepositoryDto[]>(`/v1/repository-connections/${connectionId}/repositories?search=${encodeURIComponent(search.trim())}`)
        .then((rows) => { if (!cancelled) setRepositories(rows); })
        .catch((cause) => { if (!cancelled) { setRepositories([]); setError(cause instanceof Error ? cause.message : "Unable to load repositories"); } });
    }, search ? 300 : 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [connectionId, search]);

  useEffect(() => {
    if (!picked || !connectionId) return;
    setBranches(null);
    api<Array<{ name: string }>>(`/v1/repository-connections/${connectionId}/branches?repository=${encodeURIComponent(picked.fullName)}`)
      .then((rows) => setBranches(rows.map((row) => row.name)))
      .catch(() => setBranches([picked.defaultBranch]));
  }, [picked, connectionId]);

  function startConnect(provider: string) {
    setBusy(true);
    connect(provider).catch((cause) => { setBusy(false); setError(cause instanceof Error ? cause.message : "Unable to start the connection"); });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!picked) return;
    const data = Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>;
    setBusy(true);
    setError("");
    try {
      onImported(await api<ProjectSummaryDto>("/v1/projects", { method: "POST", body: { connectionId, repository: picked.fullName, name: data.name, defaultBranch: data.defaultBranch, rootDirectory: data.rootDirectory, backendDirectories: data.backendDirectories } }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to import the repository");
      setBusy(false);
    }
  }

  const repoName = picked?.fullName.split("/").pop() ?? "";

  return <div className="project-modal-backdrop" role="presentation" onMouseDown={onClose}>
    <form className="project-modal import-modal" role="dialog" aria-modal="true" aria-labelledby="import-title" onSubmit={submit} onMouseDown={(event) => event.stopPropagation()}>
      <header>
        <div>
          <h2 id="import-title">{picked ? `Import ${picked.fullName}` : "Import a repository"}</h2>
          <p>{picked ? "Proofline analyzes the default branch at a pinned commit, then drafts tests for review." : "Pick a repository from a connected account."}</p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close"><X size={16} /></button>
      </header>

      {connections === null ? <div className="modal-fields"><span className="skel" style={{ height: 34 }} /><span className="skel" style={{ height: 180 }} /></div>

        : connections.length === 0 ? <div className="modal-fields import-empty">
          <p>{canConnect ? "Connect the account your repositories live on. You choose which repositories Proofline can see." : "No repository accounts are connected yet. Ask an organization admin to connect GitHub, Bitbucket, or GitLab."}</p>
          {canConnect && <div className="import-connect">{providers.map(({ key, label, Icon }) => <button key={key} type="button" className="secondary-button" disabled={busy} onClick={() => startConnect(key)}><Icon size={14} />Connect {label}</button>)}</div>}
          {canConnect && <small className="field-hint">Self-managed GitLab? Add your instance in Settings → Repository providers.</small>}
        </div>

        : picked ? <div className="modal-fields">
          <button type="button" className="mini-button ghost import-back" onClick={() => { setPicked(null); setError(""); }}><ArrowLeft size={12} />All repositories</button>
          <label>Project name<input name="name" defaultValue={repoName} required maxLength={120} autoFocus /></label>
          <div className="modal-row">
            <label>Default branch{branches ? <Select name="defaultBranch" defaultValue={picked.defaultBranch} ariaLabel="Default branch" options={(branches.includes(picked.defaultBranch) ? branches : [picked.defaultBranch, ...branches]).map((name) => ({ value: name, label: name }))} /> : <span className="skel" style={{ height: 34 }} />}</label>
            <label>Root directory (optional)
            <input name="rootDirectory" placeholder="apps/web" autoComplete="off" /></label>
          </div>
          <small className="field-hint">Set a root directory to import one app from a monorepo. Repositories already imported into this organization no longer appear in the list.</small>
          <label>Backend directories (optional)
          <input name="backendDirectories" placeholder="api, services/orders" autoComplete="off" /></label>
          <small className="field-hint">Folders holding this app's backend, comma-separated. Analysis reads them for API endpoints and server-side rules, so tests can cover validation and business-rule errors.</small>
        </div>

        : <div className="modal-fields">
          <div className="import-toolbar">
            <Select value={connectionId} onChange={(value) => { setConnectionId(value); setSearch(""); }} ariaLabel="Connected account" options={connections.map((candidate) => ({ value: candidate.id, label: accountLabel(candidate) }))} />
            <label className="search"><Search size={14} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search repositories…" aria-label="Search repositories" autoFocus /></label>
          </div>
          <ul className="import-list" aria-busy={repositories === null}>
            {repositories === null ? Array.from({ length: 5 }, (_, index) => <li key={index}><span className="skel" style={{ height: 16, width: `${60 - index * 7}%` }} /></li>)
              : repositories.length ? repositories.map((repository) => <li key={repository.externalId}>
                {repository.private ? <Lock size={13} aria-label="Private" /> : <Globe size={13} aria-label="Public" />}
                <div><strong>{repository.fullName}</strong><small><GitBranch size={11} />{repository.defaultBranch}</small></div>
                <button type="button" className="secondary-button" onClick={() => setPicked(repository)}><Download size={13} />Import</button>
              </li>)
              : <li className="import-none">{search ? `No repositories match “${search}”.` : "This account has no repositories Proofline can see."}</li>}
          </ul>
          {connection && canConnect && <div className="import-foot">
            {connection.provider === "GITHUB" && <button type="button" className="mini-button ghost" disabled={busy} onClick={() => startConnect("github")} title="Choose which repositories the Proofline GitHub App can see"><Settings2 size={12} />Missing a repository? Adjust GitHub access</button>}
            <span className="import-add">Add account:{providers.map(({ key, label, Icon }) => <button key={key} type="button" className="mini-button ghost" disabled={busy} onClick={() => startConnect(key)} aria-label={`Connect ${label}`} title={`Connect ${label}`}><Icon size={12} /></button>)}</span>
          </div>}
        </div>}

      {error && <p className="form-error import-error">{error}</p>}
      <footer>
        <button type="button" className="modal-cancel" onClick={onClose}>Cancel</button>
        {picked && <button className="primary-button" disabled={busy || branches === null}><Check size={14} />{busy ? "Importing…" : "Import"}</button>}
      </footer>
    </form>
  </div>;
}
