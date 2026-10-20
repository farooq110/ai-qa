import { Injectable, Logger } from "@nestjs/common";
import * as nodemailer from "nodemailer";
import type { RenderedEmail } from "./templates";

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private transporter: ReturnType<typeof nodemailer.createTransport> | null = null;

  /** Never throws: a failed send is logged, and the user can request the email again. */
  async send(to: string, email: RenderedEmail) {
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASSWORD;
    if (!user || !pass) {
      this.logger.warn(`SMTP is not configured; skipped "${email.subject}" to ${to}.\n${email.text}`);
      return;
    }
    const port = Number(process.env.SMTP_PORT) || 465;
    this.transporter ??= nodemailer.createTransport({ host: process.env.SMTP_HOST || "smtp.hostinger.com", port, secure: port === 465, auth: { user, pass } });
    try {
      await this.transporter.sendMail({ from: `"Proofline" <${user}>`, replyTo: process.env.SUPPORT_INBOX_EMAIL || user, to, ...email });
    } catch (error) {
      this.logger.error(`Failed to send "${email.subject}" to ${to}: ${error instanceof Error ? error.message : error}`);
    }
  }
}
