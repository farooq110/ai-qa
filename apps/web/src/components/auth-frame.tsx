"use client";

import { useState, type ReactNode } from "react";
import { BrandMark } from "@/components/brand-mark";

export const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export async function postAuth<T>(path: string, body: Record<string, unknown>) {
  const response = await fetch(`${apiUrl}/v1/auth/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const result = await response.json().catch(() => ({})) as T & { message?: string; code?: string };
  return { ok: response.ok, result };
}

/** Split auth layout shared by the email-link pages (verify, forgot, reset). */
export function AuthFrame({ title, children }: { kicker?: string; title: string; children: ReactNode }) {
  return <main className="auth-shell"><section className="auth-intro"><a className="auth-brand" href="/"><BrandMark />ProoflineQA</a><div><h1>{title}</h1></div><AuthFootnote /></section><section className="auth-panel narrow">{children}</section></main>;
}

/** The product's three commitments, set like the landing page's spec line. */
export function AuthFootnote() {
  return <p>approved tests only · pinned commit sha · 0 AI tokens per CI run</p>;
}

/** "Resend" control with a short cooldown, so an impatient double-click doesn't send two emails. */
export function ResendVerification({ email }: { email: string }) {
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  async function resend() {
    setState("sending");
    await postAuth("resend-verification", { email });
    setState("sent");
    window.setTimeout(() => setState("idle"), 30_000);
  }
  return <p className="signin-link">{state === "sent" ? "Sent. Check your inbox and spam folder." : <>Didn&apos;t get it? <button type="button" className="text-link-button" disabled={state === "sending"} onClick={resend}>{state === "sending" ? "Sending..." : "Resend the email"}</button></>}</p>;
}
