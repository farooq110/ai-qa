import nodemailer from "nodemailer";

/** Lazy singleton: built on first send, not at import time, so missing env vars don't crash the dev server. */
let transporter: ReturnType<typeof nodemailer.createTransport> | null = null;

export function getMailer() {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({ service: "gmail", auth: { user, pass } });
  }
  return { transporter, from: `"Proofline Support" <${user}>`, inbox: process.env.SUPPORT_INBOX_EMAIL || user };
}
