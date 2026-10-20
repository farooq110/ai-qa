"use client";

import { apiToken } from "@/lib/api";
import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ArrowRight, CircleAlert, Loader2, MailCheck } from "lucide-react";
import { AuthFrame, postAuth } from "@/components/auth-frame";

type State = { kind: "verifying" } | { kind: "already" } | { kind: "error"; message: string };

function VerifyEmail() {
  const token = useSearchParams().get("token") ?? "";
  const [state, setState] = useState<State>({ kind: "verifying" });
  const started = useRef(false);

  useEffect(() => {
    // Exactly one request: a second one would see the email as already confirmed and skip sign-in.
    if (started.current) return;
    started.current = true;
    if (!token) { setState({ kind: "error", message: "This link is missing its token. Open the link from your email again." }); return; }
    void postAuth<{ accessToken?: string; alreadyVerified?: boolean }>("verify-email", { token }).then(({ ok, result }) => {
      if (ok && result.accessToken) {
        apiToken.set(result.accessToken);
        let search = "";
        try { search = window.localStorage.getItem("proofline.signupSearch") ?? ""; window.localStorage.removeItem("proofline.signupSearch"); } catch {}
        window.location.replace(`/billing${search}`);
      } else if (ok && result.alreadyVerified) setState({ kind: "already" });
      else setState({ kind: "error", message: result.message ?? "We couldn't confirm your email. Request a new link." });
    }).catch(() => setState({ kind: "error", message: "We couldn't reach ProoflineQA. Check your connection and reload this page." }));
  }, [token]);

  if (state.kind === "verifying") return <div className="auth-card"><div className="auth-status-icon"><Loader2 size={22} className="spin" /></div><div className="form-header"><h2>Confirming your email</h2><p>One moment. You&apos;ll continue to plan selection automatically.</p></div></div>;
  if (state.kind === "already") return <div className="auth-card"><div className="auth-status-icon"><MailCheck size={22} /></div><div className="form-header"><h2>Email already confirmed</h2><p>Sign in to pick up where you left off.</p></div><a className="submit" href="/signin">Sign in <ArrowRight size={15} /></a></div>;
  return <div className="auth-card"><div className="auth-status-icon error"><CircleAlert size={22} /></div><div className="form-header"><h2>Link didn&apos;t work</h2><p>{state.message}</p></div><a className="submit" href="/signin">Back to sign in <ArrowRight size={15} /></a><p className="signin-link">Signing in with an unconfirmed email lets you resend the link.</p></div>;
}

export default function VerifyEmailPage() {
  return <AuthFrame kicker="ALMOST THERE" title="Confirm your email to open your QA control center."><Suspense><VerifyEmail /></Suspense></AuthFrame>;
}
