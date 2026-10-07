/** Minimal table-based layout so it survives Outlook/Gmail clipping — matches apps/landing's dark panel theme. */
export function renderEmail({ eyebrow, heading, bodyHtml }: { eyebrow: string; heading: string; bodyHtml: string }) {
  return `<!doctype html>
<html>
  <body style="margin:0;padding:32px 16px;background:#0a0d0f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr><td align="center">
        <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;background:#0f1418;border:1px solid #1f282e;border-radius:12px;">
          <tr><td style="padding:28px 32px 8px;">
            <table role="presentation" cellpadding="0" cellspacing="0"><tr>
              <td style="width:26px;height:26px;background:#0f1418;border:1px solid #2c373e;border-radius:7px;text-align:center;vertical-align:middle;">
                <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#35d08f;"></span>
              </td>
              <td style="padding-left:10px;font-size:16px;font-weight:600;color:#e9eeec;">Proofline</td>
            </tr></table>
          </td></tr>
          <tr><td style="padding:20px 32px 0;">
            <p style="margin:0 0 6px;font-family:ui-monospace,'SFMono-Regular',monospace;font-size:11px;letter-spacing:0.08em;color:#7f8c8a;text-transform:uppercase;">${eyebrow}</p>
            <h1 style="margin:0 0 16px;font-size:19px;line-height:1.35;color:#e9eeec;">${heading}</h1>
          </td></tr>
          <tr><td style="padding:0 32px 32px;font-size:14px;line-height:1.6;color:#a8b3b0;">
            ${bodyHtml}
          </td></tr>
        </table>
        <p style="margin:20px 0 0;font-family:ui-monospace,'SFMono-Regular',monospace;font-size:11px;color:#7f8c8a;">Proofline · AI-generated tests, human-approved</p>
      </td></tr>
    </table>
  </body>
</html>`;
}
