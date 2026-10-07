import { NextResponse } from "next/server";
import { getMailer } from "@/lib/mailer";
import { renderEmail } from "@/lib/email-template";

export const runtime = "nodejs";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(request: Request) {
  const { title, description, email, imageUrl } = (await request.json()) as { title?: string; description?: string; email?: string; imageUrl?: string };

  if (!title?.trim() || !description?.trim() || !email || !EMAIL_RE.test(email)) {
    return NextResponse.json({ error: "Title, description, and a valid email are required." }, { status: 400 });
  }

  const apiUrl = process.env.NEXT_PUBLIC_API_URL;
  const stored = await fetch(`${apiUrl}/v1/support-queries`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, description, email, imageUrl })
  });
  if (!stored.ok) return NextResponse.json({ error: "Unable to record your message right now." }, { status: 502 });

  const mailer = getMailer();
  if (!mailer) return NextResponse.json({ error: "Support email isn't configured yet." }, { status: 503 });
  const { transporter, from, inbox } = mailer;

  await transporter.sendMail({
    from,
    to: inbox,
    replyTo: email,
    subject: `[Support] ${title}`,
    text: `From: ${email}\n\n${description}${imageUrl ? `\n\nAttachment: ${imageUrl}` : ""}`,
    html: renderEmail({
      eyebrow: "New support query",
      heading: title,
      bodyHtml: `
        <p style="margin:0 0 14px;"><strong style="color:#e9eeec;">From:</strong> ${email}</p>
        <p style="margin:0 0 14px;white-space:pre-wrap;">${description}</p>
        ${imageUrl ? `<p style="margin:0;"><a href="${imageUrl}" style="color:#35d08f;">View attached image →</a></p>` : ""}
      `
    })
  });

  await transporter.sendMail({
    from,
    to: email,
    subject: "We've got your message",
    text: `Hi,\n\nThanks for reaching out — "${title}" has been received and our team will get back to you shortly.\n\nYour message:\n${description}`,
    html: renderEmail({
      eyebrow: "Support",
      heading: "We've got your message",
      bodyHtml: `
        <p style="margin:0 0 14px;">Thanks for reaching out — <strong style="color:#e9eeec;">"${title}"</strong> has been received and our team will get back to you shortly.</p>
        <p style="margin:0 0 6px;color:#7f8c8a;font-size:12px;text-transform:uppercase;letter-spacing:0.06em;">Your message</p>
        <p style="margin:0;white-space:pre-wrap;">${description}</p>
      `
    })
  });

  return NextResponse.json({ ok: true });
}
