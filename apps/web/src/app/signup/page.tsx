"use client";

import { FormEvent, useState } from "react";
import { ArrowRight, Building2, CheckCircle2, MailCheck } from "lucide-react";
import { AuthFootnote, ResendVerification } from "@/components/auth-frame";
import { BrandMark } from "@/components/brand-mark";
import Link from "next/link";
import { Select } from "@/components/select";

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export default function SignUpPage() {
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [message, setMessage] = useState("");
  const [pendingEmail, setPendingEmail] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setStatus("loading");
    try {
      const response = await fetch(`${apiUrl}/v1/auth/signup`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.fromEntries(form)) });
      const result = await response.json() as { verificationRequired?: boolean; email?: string; message?: string };
      if (!response.ok || !result.verificationRequired) throw new Error(result.message ?? "Unable to create the organization");
      // The confirmation link continues to /billing; carry any plan selection from this URL across.
      try { window.localStorage.setItem("proofline.signupSearch", window.location.search); } catch { }
      setPendingEmail(result.email ?? String(form.get("email")));
      setStatus("success");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to create the organization");
      setStatus("error");
    }
  }

  return <main className="auth-shell">
    <section className="auth-intro">
      <a className="auth-brand" href="/"><BrandMark />ProoflineQA</a>
      <div>
        <h1>Build a reviewable regression suite from your application.</h1>
        <ul>
          <li><CheckCircle2 size={16} />Repository analysis with human approval gates</li>
          <li><CheckCircle2 size={16} />Approved tests only, on demand or in CI</li>
          <li><CheckCircle2 size={16} />Organization-level usage and execution controls</li>
        </ul>
      </div>
      <AuthFootnote />
    </section>
    <section className="auth-panel">
      {pendingEmail ? (
        <div className="auth-card">
          <div className="auth-status-icon"><MailCheck size={22} /></div>
          <div className="form-header">
            <h2>Check your inbox <span className="step">step 2 of 2</span></h2>
            <p>We sent a confirmation link to <strong>{pendingEmail}</strong>. Open it to activate your organization and choose a plan. The link expires in 24 hours.</p>
          </div>
          <ResendVerification email={pendingEmail} />
          <p className="signin-link">Wrong email? <a href="/signup">Start over</a></p>
          <p className="signin-link">Already confirmed? <Link href="/signin">Back to sign in</Link></p>
        </div>
      ) : (
        <form onSubmit={submit}>
          <div className="form-header">
            <h2>Create your organization <span className="step">step 1 of 2</span></h2>
            <p>Start with the account that will administer your team and billing.</p>
          </div>
          <div className="form-grid">
            <label>Full name<input name="displayName" required placeholder="Avery Morgan" /></label>
            <label>Work email<input name="email" type="email" required placeholder="avery@company.com" /></label>
            <label className="wide">Password<input name="password" type="password" minLength={12} required placeholder="At least 12 characters" /></label>
            <label className="wide"><span className="label-title"><Building2 size={15} />Organization name</span><input name="organizationName" required placeholder="Acme Commerce" /></label>
            <label>Industry<input name="industry" placeholder="Retail technology" /></label>
            <label>Organization size<Select name="organizationSize" defaultValue="" placeholder="Select size" options={["1-10", "11-50", "51-200", "201+"].map((size) => ({ value: size, label: size }))} /></label>
            <label className="wide">Country / region<input name="country" placeholder="United States" /></label>
          </div>
          {status !== "idle" && <p className={`form-message ${status}`}>{message}</p>}
          <button className="submit" disabled={status === "loading"}>
            {status === "loading" ? "Creating organization..." : <>Create organization <ArrowRight size={15} /></>}
          </button>
          <p className="signin-link">Already have an account? <Link href="/signin">Sign in</Link></p>
        </form>
      )}
    </section>
  </main>;
}