"use client";

import { useState } from "react";
import { AlertTriangle, X } from "lucide-react";

export interface ConfirmRequest {
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  action: () => Promise<unknown> | void;
}

/** In-app replacement for window.confirm: same blocking semantics, app-consistent UI. */
export function ConfirmDialog({ request, onClose }: { request: ConfirmRequest; onClose: () => void }) {
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    try {
      await request.action();
    } finally {
      onClose();
    }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="modal confirm" onClick={(event) => event.stopPropagation()}>
        <div className={`confirm-icon ${request.danger === false ? "safe" : ""}`}><AlertTriangle size={20} /></div>
        <h2>{request.title}</h2>
        <p>{request.body}</p>
        <div className="confirm-actions">
          <button className="modal-cancel" onClick={onClose} disabled={busy}>Cancel</button>
          <button className={request.danger === false ? "primary-button" : "primary-button danger"} onClick={() => void run()} disabled={busy}>{busy ? "Working…" : request.confirmLabel}</button>
        </div>
        <button className="icon-button confirm-close" aria-label="Close" onClick={onClose} disabled={busy}><X size={15} /></button>
      </div>
    </div>
  );
}
