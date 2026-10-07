"use client";

import { FormEvent, useState } from "react";
import { ArrowRight, ShieldCheck } from "lucide-react";

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export default function SignInPage() {
  const [message, setMessage] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const response = await fetch(`${apiUrl}/v1/auth/signin`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) });
    const result = await response.json() as { accessToken?: string; message?: string };
    if (!response.ok || !result.accessToken) { setMessage(result.message ?? "Unable to sign in"); return; }
    window.localStorage.setItem("proofline.accessToken", result.accessToken);
    window.location.assign("/dashboard");
  }
  return <main className="auth-shell"><section className="auth-intro"><div className="auth-brand"><ShieldCheck size={23} />proofline</div><div><p>WELCOME BACK</p><h1>Run the approved tests that protect your next release.</h1></div></section><section className="auth-panel narrow"><form onSubmit={submit}><div className="form-header"><h2>Sign in</h2><p>Use your organization account to continue.</p></div><div className="form-grid"><label className="wide">Work email<input name="email" type="email" required placeholder="avery@company.com" /></label><label className="wide">Password<input name="password" type="password" required placeholder="Your password" /></label></div>{message && <p className="form-message error">{message}</p>}<button className="submit">Continue <ArrowRight size={17} /></button><p className="signin-link">Need an organization? <a href="/signup">Create one</a></p></form></section></main>;
}