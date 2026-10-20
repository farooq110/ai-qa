/**
 * Transactional email templates. Table layout + inline styles only, so they render the same in
 * Gmail, Outlook and Apple Mail. Mirrors the app's auth screens: navy masthead with the gold "P"
 * brand mark, white card, teal primary action.
 */

const ink = "#1e2632";
const body = "#3d4955";
const muted = "#6f7b8b";
const line = "#e5e9ed";
const teal = "#1f7265";
const navy = "#172029";
const gold = "#e6c069";
const mint = "#31a98c";
const sans = "Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif";
const mono = "'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";

export interface RenderedEmail { subject: string; html: string; text: string; }

export function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[char]!);
}

const firstName = (displayName: string) => displayName.trim().split(/\s+/)[0] || "there";

function button(href: string, label: string) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:28px 0 0;"><tr>
    <td style="border-radius:6px;background:${teal};">
      <a href="${href}" style="display:inline-block;padding:13px 22px;font-family:${sans};font-size:15px;font-weight:600;line-height:1;color:#ffffff;text-decoration:none;border-radius:6px;">${label}</a>
    </td>
  </tr></table>`;
}

/** The raw URL, for clients that strip buttons or readers who prefer to paste. */
function fallbackLink(href: string) {
  return `<p style="margin:24px 0 6px;font-family:${sans};font-size:13px;line-height:1.5;color:${muted};">Button not working? Paste this link into your browser:</p>
  <p style="margin:0;padding:10px 12px;background:#f5f6f4;border:1px solid ${line};border-radius:6px;font-family:${mono};font-size:12px;line-height:1.55;color:${body};word-break:break-all;"><a href="${href}" style="color:${body};text-decoration:none;">${href}</a></p>`;
}

function paragraph(html: string, extra = "") {
  return `<p style="margin:0 0 14px;font-family:${sans};font-size:15px;line-height:1.6;color:${body};${extra}">${html}</p>`;
}

function note(html: string) {
  return `<p style="margin:28px 0 0;padding-top:20px;border-top:1px solid ${line};font-family:${sans};font-size:13px;line-height:1.55;color:${muted};">${html}</p>`;
}

function layout({ preheader, heading, content, recipient }: { preheader: string; heading: string; content: string; recipient: string }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light only">
  <meta name="supported-color-schemes" content="light">
  <title>${heading}</title>
  <style>@media (max-width:480px){.px{padding-left:22px!important;padding-right:22px!important}.outer{padding:20px 10px!important}}</style>
</head>
<body style="margin:0;padding:0;background:#f5f6f4;-webkit-text-size-adjust:100%;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${preheader}&#8203;&nbsp;&#8203;&nbsp;&#8203;&nbsp;&#8203;&nbsp;&#8203;&nbsp;&#8203;&nbsp;&#8203;&nbsp;</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f6f4;">
    <tr><td class="outer" align="center" style="padding:40px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid ${line};border-radius:10px;overflow:hidden;">
        <tr><td class="px" style="background:${navy};padding:22px 36px;">
          <table role="presentation" cellpadding="0" cellspacing="0"><tr>
            <td width="28" height="28" align="center" valign="middle" style="width:28px;height:28px;background:${gold};border-radius:6px;font-family:Georgia,'Times New Roman',serif;font-size:16px;font-weight:700;color:${navy};line-height:28px;">P</td>
            <td style="padding-left:10px;font-family:${mono};font-size:17px;font-weight:700;letter-spacing:.3px;color:#ffffff;">proofline</td>
          </tr></table>
        </td></tr>
        <tr><td style="font-size:0;line-height:0;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
            <td width="72%" height="3" style="height:3px;background:${mint};font-size:0;line-height:0;">&nbsp;</td>
            <td height="3" style="height:3px;background:${gold};font-size:0;line-height:0;">&nbsp;</td>
          </tr></table>
        </td></tr>
        <tr><td class="px" style="padding:40px 36px 36px;">
          <h1 style="margin:0 0 18px;font-family:${sans};font-size:24px;line-height:1.25;font-weight:600;letter-spacing:-.01em;color:${ink};">${heading}</h1>
          ${content}
        </td></tr>
      </table>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
        <tr><td class="px" style="padding:22px 36px 0;font-family:${sans};font-size:12px;line-height:1.6;color:${muted};">
          AI writes the tests. Humans approve them. Only approved tests run.<br>
          Sent to ${escapeHtml(recipient)} by Proofline · <a href="https://prooflineqa.com" style="color:${muted};">prooflineqa.com</a>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

export function verifyEmailTemplate({ displayName, email, organizationName, url }: { displayName: string; email: string; organizationName: string; url: string }): RenderedEmail {
  const name = escapeHtml(firstName(displayName));
  const org = escapeHtml(organizationName);
  return {
    subject: "Confirm your email for Proofline",
    html: layout({
      preheader: `One click to finish setting up ${org}.`,
      heading: "Confirm your email",
      recipient: email,
      content: paragraph(`Hi ${name},`)
        + paragraph(`Confirm <strong style="color:${ink};font-weight:600;">${escapeHtml(email)}</strong> to finish setting up <strong style="color:${ink};font-weight:600;">${org}</strong> on Proofline. You'll go straight to choosing a plan.`, "margin-bottom:0;")
        + button(url, "Confirm email")
        + fallbackLink(url)
        + note("This link expires in 24 hours. If you didn't create a Proofline account, ignore this email. Nothing is set up without confirmation.")
    }),
    text: `Hi ${firstName(displayName)},\n\nConfirm ${email} to finish setting up ${organizationName} on Proofline:\n\n${url}\n\nThis link expires in 24 hours. If you didn't create a Proofline account, ignore this email.\n\nProofline · prooflineqa.com`
  };
}

const welcomeSteps = [
  ["Connect a repository", "GitHub or Bitbucket. Every analysis pins the exact commit it read."],
  ["Review generated tests", "Each candidate shows its evidence: the routes, components and files it came from."],
  ["Approve, then run", "Only approved tests execute, from the dashboard or your CI pipeline."]
] as const;

export function welcomeTemplate({ displayName, email, organizationName, url }: { displayName: string; email: string; organizationName: string; url: string }): RenderedEmail {
  const name = escapeHtml(firstName(displayName));
  const org = escapeHtml(organizationName);
  const steps = welcomeSteps.map(([title, detail], index) => `<tr>
      <td width="34" valign="top" style="padding:${index ? "16px" : "0"} 0 0;">
        <div style="width:24px;height:24px;border-radius:12px;background:#e4f4ee;font-family:${mono};font-size:12px;font-weight:700;line-height:24px;text-align:center;color:${teal};">${index + 1}</div>
      </td>
      <td valign="top" style="padding:${index ? "16px" : "0"} 0 0;font-family:${sans};">
        <p style="margin:2px 0 3px;font-size:15px;font-weight:600;line-height:1.35;color:${ink};">${title}</p>
        <p style="margin:0;font-size:14px;line-height:1.55;color:${muted};">${detail}</p>
      </td>
    </tr>`).join("");
  return {
    subject: `Welcome to Proofline, ${firstName(displayName)}`,
    html: layout({
      preheader: `${org} is ready. Here's how your first approved suite comes together.`,
      heading: `${org} is ready`,
      recipient: email,
      content: paragraph(`Welcome aboard, ${name}. Your email is confirmed. Here's how a first suite comes together:`, "margin-bottom:24px;")
        + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${steps}</table>`
        + button(url, "Open your dashboard")
        + note("Questions about setup? Reply to this email. It goes to the team that builds Proofline.")
    }),
    text: `Welcome aboard, ${firstName(displayName)}. ${organizationName} is ready.\n\n${welcomeSteps.map(([title, detail], index) => `${index + 1}. ${title}: ${detail}`).join("\n")}\n\nOpen your dashboard: ${url}\n\nQuestions? Reply to this email.\n\nProofline · prooflineqa.com`
  };
}

export function resetPasswordTemplate({ displayName, email, url }: { displayName: string; email: string; url: string }): RenderedEmail {
  const name = escapeHtml(firstName(displayName));
  return {
    subject: "Reset your Proofline password",
    html: layout({
      preheader: "Choose a new password. The link expires in 1 hour.",
      heading: "Reset your password",
      recipient: email,
      content: paragraph(`Hi ${name},`)
        + paragraph(`We received a request to reset the password for <strong style="color:${ink};font-weight:600;">${escapeHtml(email)}</strong>. Choose a new one below.`, "margin-bottom:0;")
        + button(url, "Choose a new password")
        + fallbackLink(url)
        + note("This link expires in 1 hour and works once. If you didn't ask for a reset, ignore this email. Your password stays the same.")
    }),
    text: `Hi ${firstName(displayName)},\n\nWe received a request to reset the password for ${email}. Choose a new one here:\n\n${url}\n\nThis link expires in 1 hour and works once. If you didn't ask for a reset, ignore this email. Your password stays the same.\n\nProofline · prooflineqa.com`
  };
}

/** Security notice after any password change, so an unexpected one gets noticed. */
export function passwordChangedTemplate({ displayName, email, url }: { displayName: string; email: string; url: string }): RenderedEmail {
  const name = escapeHtml(firstName(displayName));
  const when = new Date().toUTCString().replace("GMT", "UTC");
  return {
    subject: "Your Proofline password was changed",
    html: layout({
      preheader: "If this was you, there's nothing else to do.",
      heading: "Your password was changed",
      recipient: email,
      content: paragraph(`Hi ${name},`)
        + paragraph(`The password for <strong style="color:${ink};font-weight:600;">${escapeHtml(email)}</strong> was changed on ${when}. If this was you, there's nothing else to do.`, "margin-bottom:0;")
        + note(`<strong style="color:${ink};font-weight:600;">Didn't change it?</strong> Someone else may have access to your account. <a href="${url}" style="color:${teal};font-weight:600;">Reset your password now</a> and tell your organization admin.`)
    }),
    text: `Hi ${firstName(displayName)},\n\nThe password for ${email} was changed on ${when}. If this was you, there's nothing else to do.\n\nDidn't change it? Reset your password now and tell your organization admin: ${url}\n\nProofline · prooflineqa.com`
  };
}
