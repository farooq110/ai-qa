"use client";

import { FormEvent, Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ArrowRight, CircleAlert, KeyRound } from "lucide-react";
import { AuthFrame, postAuth } from "@/components/auth-frame";

function ResetPassword() {
  const token = useSearchParams().get("token") ?? "";
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [message, setMessage] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    if (form.get("password") !== form.get("confirm")) { setMessage("The two passwords don't match."); setStatus("error"); return; }
    setStatus("loading");
    try {
      const { ok, result } = await postAuth("reset-password", { token, password: form.get("password") });
      if (ok) { setStatus("done"); return; }
      setMessage(result.message ?? "We couldn't reset your password. Request a new link.");
    } catch {
      setMessage("We couldn't reach ProoflineQA. Check your connection and try again.");
    }
    setStatus("error");
  }

  if (!token) return <div className="auth-card"><div className="auth-status-icon error"><CircleAlert size={22} /></div><div className="form-header"><h2>Link is incomplete</h2><p>Open the link from your email again, or request a new one.</p></div><a className="submit" href="/forgot-password">Request a new link <ArrowRight size={15} /></a></div>;
  if (status === "done") return <div className="auth-card"><div className="auth-status-icon"><KeyRound size={22} /></div><div className="form-header"><h2>Password updated</h2><p>Sign in with your new password. The reset link can&apos;t be used again.</p></div><a className="submit" href="/signin">Sign in <ArrowRight size={15} /></a></div>;
  return <form onSubmit={submit}><div className="form-header"><h2>Choose a new password</h2><p>Use at least 12 characters. You&apos;ll sign in with it right after.</p></div><div className="form-grid"><label className="wide">New password<input name="password" type="password" minLength={12} required autoComplete="new-password" autoFocus placeholder="At least 12 characters" /></label><label className="wide">Confirm password<input name="confirm" type="password" minLength={12} required autoComplete="new-password" placeholder="Type it again" /></label></div>{status === "error" && <p className="form-message error">{message}{/expired|no longer valid|already been used/.test(message) && <> <a href="/forgot-password">Request a new link</a>.</>}</p>}<button className="submit" disabled={status === "loading"}>{status === "loading" ? "Updating password..." : <>Update password <ArrowRight size={15} /></>}</button></form>;
}

export default function ResetPasswordPage() {
  return <AuthFrame kicker="ACCOUNT RECOVERY" title="Get back to the tests your team approved."><Suspense><ResetPassword /></Suspense></AuthFrame>;
}
