"use client";

import { apiToken, apiUrl } from "@/lib/api";
import { FormEvent, useState } from "react";
import { ArrowRight } from "lucide-react";
import { AuthFootnote, ResendVerification } from "@/components/auth-frame";
import { BrandMark } from "@/components/brand-mark";
import Link from "next/link";
import { useToast } from "@/lib/hooks";

export default function SignInPage() {
  const [message, setMessage] = useState("");
  const [unverifiedEmail, setUnverifiedEmail] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const { notify } = useToast()

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      setUnverifiedEmail("");
      setIsLoading(true);
      const credentials = Object.fromEntries(new FormData(event.currentTarget));
      const response = await fetch(`${apiUrl}/v1/auth/signin`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(credentials) });
      const result = await response.json() as { accessToken?: string; message?: string; code?: string };
      if (result.code === "EMAIL_NOT_VERIFIED") setUnverifiedEmail(String(credentials.email));
      if (!response.ok || !result.accessToken) { setMessage(result.message ?? "Unable to sign in"); return; }
      apiToken.set(result.accessToken);
      window.location.assign("/dashboard");
    } catch (error) {
      notify("Error signing in", "error")
    } finally {
      setIsLoading(false);
    }
  }
  return <main className="auth-shell">
    <section className="auth-intro">
      <a className="auth-brand" href="/"><BrandMark />ProoflineQA</a>
      <div>
        <h1>Run the approved tests that protect your next release.</h1>
      </div>
      <AuthFootnote />
    </section>
    <section className="auth-panel narrow">
      <form onSubmit={submit}>
        <div className="form-header">
          <h2>Sign in</h2>
          <p>Use your organization account to continue.</p>
        </div>
        <div className="form-grid">
          <label className="wide">Work email
            <input name="email" type="email" required autoComplete="email" placeholder="avery@company.com" />
          </label>
          <label className="wide">
            <span className="label-row">
              Password
              <Link href="/forgot-password">Forgot password?</Link>
            </span>
            <input name="password" type="password" required autoComplete="current-password" placeholder="Your password" />
          </label>
        </div>
        {message && <p className="form-message error">{message}</p>}
        {unverifiedEmail && <ResendVerification email={unverifiedEmail} />}
        <button disabled={isLoading} className="submit">{isLoading ? "Logging in..." : "Continue"} <ArrowRight size={15} /></button>
        <p className="signin-link">Need an organization? <Link href="/signup">Create one</Link></p>
      </form>
    </section>
  </main>;
}