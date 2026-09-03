import type { Env } from './lib';
import { getSetting, run } from './lib';

// Resend transactional email (HTTP API). Requires:
//   - resend_api_key in settings (admin → 系统设置)
//   - sender domain verified in Resend (DNS SPF + DKIM)
// Docs: https://resend.com/docs/api-reference/emails/send-email
export async function sendEmail(
  env: Env,
  to: string,
  subject: string,
  textBody: string,
  htmlBody?: string,
  type = 'system'
): Promise<{ ok: boolean; status: number; body: string }> {
  const fromEmail = await getSetting(env.DB, 'sender_email', 'noreply@example.com');
  const fromName = await getSetting(env.DB, 'sender_name', '财经资讯站');
  const apiKey = await getSetting(env.DB, 'resend_api_key', '');

  if (!apiKey) {
    await run(env.DB, 'INSERT INTO email_log (to_email, subject, type, status) VALUES (?, ?, ?, ?)', [
      to,
      subject,
      type,
      'error:resend_api_key_not_set',
    ]);
    return { ok: false, status: 0, body: 'resend_api_key 未配置' };
  }

  const payload: Record<string, unknown> = {
    from: `${fromName} <${fromEmail}>`,
    to: [to],
    subject,
    text: textBody,
  };
  if (htmlBody) payload.html = htmlBody;

  let status = 0;
  let body = '';
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
    });
    status = resp.status;
    body = await resp.text();
    const ok = status >= 200 && status < 300;
    await run(env.DB, 'INSERT INTO email_log (to_email, subject, type, status) VALUES (?, ?, ?, ?)', [
      to,
      subject,
      type,
      ok ? 'sent' : `failed:${status}`,
    ]);
    return { ok, status, body: body.slice(0, 500) };
  } catch (e) {
    await run(env.DB, 'INSERT INTO email_log (to_email, subject, type, status) VALUES (?, ?, ?, ?)', [
      to,
      subject,
      type,
      `error:${String(e)}`,
    ]);
    return { ok: false, status, body: String(e) };
  }
}

export function siteBase(env: Env): string {
  return env.BASE_URL || 'https://your-worker.workers.dev';
}
