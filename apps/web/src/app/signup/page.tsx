"use client";

import { FormEvent, useState } from "react";
import { ArrowRight, Building2, CheckCircle2, ShieldCheck } from "lucide-react";

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export default function SignUpPage() {
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [message, setMessage] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setStatus("loading");
    try {
      const response = await fetch(`${apiUrl}/v1/auth/signup`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.fromEntries(form)) });
      const result = await response.json() as { accessToken?: string; message?: string };
      if (!response.ok || !result.accessToken) throw new Error(result.message ?? "Unable to create the organization");
      window.localStorage.setItem("proofline.accessToken", result.accessToken);
      setStatus("success");
      window.setTimeout(() => window.location.assign("/projects"), 600);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to create the organization");
      setStatus("error");
    }
  }

  return <main className="auth-shell"><section className="auth-intro"><div className="auth-brand"><ShieldCheck size={23} />proofline</div><div><p>AI QA CONTROL CENTER</p><h1>Build a reviewable regression suite from your application.</h1><ul><li><CheckCircle2 size={18} />Repository analysis with human approval gates</li><li><CheckCircle2 size={18} />Approved tests only, on demand or in CI</li><li><CheckCircle2 size={18} />Organization-level usage and execution controls</li></ul></div></section><section className="auth-panel"><form onSubmit={submit}><div className="form-header"><span className="step">01 / 02</span><h2>Create your organization</h2><p>Start with the account that will administer your team and billing.</p></div><div className="form-grid"><label>Full name<input name="displayName" required placeholder="Avery Morgan" /></label><label>Work email<input name="email" type="email" required placeholder="avery@company.com" /></label><label className="wide">Password<input name="password" type="password" minLength={12} required placeholder="At least 12 characters" /></label><label className="wide"><span className="label-title"><Building2 size={15} />Organization name</span><input name="organizationName" required placeholder="Acme Commerce" /></label><label>Industry<input name="industry" placeholder="Retail technology" /></label><label>Organization size<select name="organizationSize" defaultValue=""><option value="" disabled>Select size</option><option>1-10</option><option>11-50</option><option>51-200</option><option>201+</option></select></label><label className="wide">Country / region<input name="country" placeholder="United States" /></label></div>{status !== "idle" && <p className={`form-message ${status}`}>{message}</p>}<button className="submit" disabled={status === "loading"}>{status === "loading" ? "Creating organization..." : <>Create organization <ArrowRight size={17} /></>}</button><p className="signin-link">Already have an account? <a href="/signin">Sign in</a></p></form></section></main>;
}