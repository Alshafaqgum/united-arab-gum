import { Resend } from 'resend';

export const runtime = 'nodejs';

const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 3;

const requestsByIp = new Map<string, { count: number; resetAt: number }>();

interface ContactFields {
  name: string;
  email: string;
  company: string;
  subject: string;
  phone: string;
  productInterest: string;
  quantity: string;
  message: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cleanString(value: unknown, maxLength: number): string | null {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') return null;

  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, maxLength);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return entities[character];
  });
}

function isRateLimited(ip: string, now: number): boolean {
  for (const [key, entry] of requestsByIp) {
    if (entry.resetAt <= now) requestsByIp.delete(key);
  }

  const current = requestsByIp.get(ip);
  if (!current || current.resetAt <= now) {
    requestsByIp.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }

  if (current.count >= RATE_LIMIT_MAX_REQUESTS) return true;

  current.count += 1;
  return false;
}

function escapeText(value: string): string {
  return value.replace(/\r\n/g, '\n');
}

export async function POST(request: Request) {
  const now = Date.now();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ success: false, error: 'invalid_request' }, { status: 400 });
  }

  if (!isRecord(body)) {
    return Response.json({ success: false, error: 'invalid_request' }, { status: 400 });
  }

  const companyWebsite = cleanString(body.companyWebsite, 500);
  if (companyWebsite === null) {
    return Response.json({ success: false, error: 'invalid_request' }, { status: 400 });
  }
  if (companyWebsite) {
    return Response.json({ success: true });
  }

  const ip = request.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'unknown';
  if (isRateLimited(ip, now)) {
    return Response.json({ success: false, error: 'rate_limited' }, { status: 429 });
  }

  const formLoadedAt = body.formLoadedAt;
  if (
    typeof formLoadedAt !== 'number' ||
    !Number.isFinite(formLoadedAt) ||
    formLoadedAt <= 0 ||
    now - formLoadedAt < 3000
  ) {
    return Response.json({ success: false, error: 'invalid_submission' }, { status: 400 });
  }

  const fields: ContactFields = {
    name: cleanString(body.name, 200) ?? '',
    email: cleanString(body.email, 320) ?? '',
    company: cleanString(body.company, 200) ?? '',
    subject: cleanString(body.subject, 200) ?? '',
    phone: cleanString(body.phone, 50) ?? '',
    productInterest: cleanString(body.productInterest, 200) ?? '',
    quantity: cleanString(body.quantity, 100) ?? '',
    message: cleanString(body.message, 3000) ?? '',
  };

  const fieldLimits: Record<keyof ContactFields, number> = {
    name: 200,
    email: 320,
    company: 200,
    subject: 200,
    phone: 50,
    productInterest: 200,
    quantity: 100,
    message: 3000,
  };
  for (const field of Object.keys(fieldLimits) as Array<keyof ContactFields>) {
    if (body[field] !== undefined && body[field] !== null && typeof body[field] !== 'string') {
      return Response.json({ success: false, error: 'invalid_submission' }, { status: 400 });
    }
    if (typeof body[field] === 'string' && body[field].length > fieldLimits[field]) {
      return Response.json({ success: false, error: 'invalid_submission' }, { status: 400 });
    }
  }

  if (
    !fields.name ||
    !fields.email ||
    !fields.message ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields.email) ||
    fields.message.length > 3000 ||
    (fields.message.match(/https?:\/\/\S*/gi) ?? []).length > 1
  ) {
    return Response.json({ success: false, error: 'invalid_submission' }, { status: 400 });
  }

  const apiKey = process.env.RESEND_API_KEY;
  const receiverEmail = process.env.RECEIVER_EMAIL;
  const senderEmail = process.env.SENDER_EMAIL;
  if (!apiKey || !receiverEmail || !senderEmail) {
    console.error('Contact email is not configured. Set RESEND_API_KEY, RECEIVER_EMAIL, and SENDER_EMAIL.');
    return Response.json({ success: false, error: 'email_not_configured' }, { status: 500 });
  }

  const emailFields: Array<[string, string]> = [
    ['Name', fields.name],
    ['Email', fields.email],
    ['Company', fields.company],
    ['Subject', fields.subject],
    ['Phone', fields.phone],
    ['Product interest', fields.productInterest],
    ['Quantity', fields.quantity],
    ['Message', fields.message],
  ].filter(([, value]) => value) as Array<[string, string]>;

  const html = `<h1>New website contact inquiry</h1><table>${emailFields
    .map(
      ([label, value]) =>
        `<tr><th align="left" valign="top">${escapeHtml(label)}</th><td>${escapeHtml(value).replace(/\n/g, '<br>')}</td></tr>`
    )
    .join('')}</table>`;
  const text = `New website contact inquiry\n\n${emailFields
    .map(([label, value]) => `${label}: ${escapeText(value)}`)
    .join('\n\n')}`;

  try {
    const resend = new Resend(apiKey);
    const { error } = await resend.emails.send({
      from: senderEmail,
      to: receiverEmail,
      replyTo: fields.email,
      subject: 'New website contact inquiry',
      html,
      text,
    });

    if (error) {
      console.error('Resend failed to send contact inquiry:', error);
      return Response.json({ success: false, error: 'email_send_failed' }, { status: 502 });
    }

    return Response.json({ success: true });
  } catch (error) {
    console.error('Unexpected error sending contact inquiry:', error);
    return Response.json({ success: false, error: 'email_send_failed' }, { status: 502 });
  }
}
