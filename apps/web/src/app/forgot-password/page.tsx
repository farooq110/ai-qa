"use client";

import { FormEvent, useState } from "react";
import { ArrowRight, MailCheck } from "lucide-react";
import { AuthFrame, postAuth } from "@/components/auth-frame";

export default function ForgotPasswordPage() {
  const [status, setStatus] = useState<"idle" | "loading" | "sent" | "error">("idle");
  const [email, setEmail] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("loading");
    try {
      const { ok } = await postAuth("forgot-password", { email });
      setStatus(ok ? "sent" : "error");
    } catch {
      setStatus("error");
    }
  }

  return <AuthFrame kicker="ACCOUNT RECOVERY" title="Get back to the tests your team approved.">
    {status === "sent"
      ? <div className="auth-card"><div className="auth-status-icon"><MailCheck size={22} /></div><div className="form-header"><h2>Check your inbox</h2><p>If an account exists for <strong>{email}</strong>, a reset link is on its way. It expires in 1 hour.</p></div><a className="submit" href="/signin">Back to sign in <ArrowRight size={15} /></a><p className="signin-link">Wrong address? <button type="button" className="text-link-button" onClick={() => setStatus("idle")}>Try another email</button></p></div>
      : <form onSubmit={submit}><div className="form-header"><h2>Reset your password</h2><p>Enter your work email and we&apos;ll send you a link to choose a new password.</p></div><div className="form-grid"><label className="wide">Work email<input name="email" type="email" required autoComplete="email" autoFocus value={email} onChange={(event) => setEmail(event.target.value)} placeholder="avery@company.com" /></label></div>{status === "error" && <p className="form-message error">We couldn&apos;t send the link right now. Try again in a moment.</p>}<button className="submit" disabled={status === "loading"}>{status === "loading" ? "Sending link..." : <>Send reset link <ArrowRight size={15} /></>}</button><p className="signin-link">Remembered it? <a href="/signin">Sign in</a></p></form>}
  </AuthFrame>;
}
