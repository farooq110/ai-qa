import nodemailer from "nodemailer";

/** Lazy singleton: built on first send, not at import time, so missing env vars don't crash the dev server. */
let transporter: ReturnType<typeof nodemailer.createTransport> | null = null;

export function getMailer() {
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASSWORD;
  if (!user || !pass) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || "smtp.hostinger.com",
      port: Number(process.env.SMTP_PORT) || 465,
      secure: (Number(process.env.SMTP_PORT) || 465) === 465,
      auth: { user, pass }
    });
  }
  return { transporter, from: `"ProoflineQA Support" <${user}>`, inbox: process.env.SUPPORT_INBOX_EMAIL || user };
}
