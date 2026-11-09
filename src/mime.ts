import { b64url, fromB64url } from "./crypto";

export interface GmailHeader {
  name: string;
  value: string;
}

export interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPart[];
}

export function header(headers: GmailHeader[] | undefined, name: string): string | undefined {
  const n = name.toLowerCase();
  return headers?.find((h) => h.name.toLowerCase() === n)?.value;
}

const decodeData = (data: string) => new TextDecoder().decode(fromB64url(data));

function walk(part: GmailPart, out: { plain: string[]; html: string[]; attachments: { filename: string; mimeType: string; size: number }[] }) {
  const type = (part.mimeType ?? "").toLowerCase();
  if (part.filename && (part.body?.attachmentId || part.body?.size)) {
    out.attachments.push({ filename: part.filename, mimeType: part.mimeType ?? "", size: part.body?.size ?? 0 });
    return;
  }
  if (part.parts?.length) {
    for (const p of part.parts) walk(p, out);
    return;
  }
  if (!part.body?.data) return;
  if (type === "text/plain") out.plain.push(decodeData(part.body.data));
  else if (type === "text/html") out.html.push(decodeData(part.body.data));
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function extractBody(payload: GmailPart) {
  const out = { plain: [] as string[], html: [] as string[], attachments: [] as { filename: string; mimeType: string; size: number }[] };
  walk(payload, out);
  const text = out.plain.length ? out.plain.join("\n\n") : htmlToText(out.html.join("\n\n"));
  return { text: text.replace(/\r\n/g, "\n").trim(), attachments: out.attachments };
}

/** RFC 2047 encoded-word when the value isn't plain ASCII. */
function encodeHeader(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  const bytes = new TextEncoder().encode(value);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return `=?UTF-8?B?${btoa(s)}?=`;
}

const clean = (v: string) => v.replace(/[\r\n]+/g, " ").trim();

export function buildRawMessage(m: {
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string;
}): string {
  const lines = [`To: ${clean(m.to)}`];
  if (m.cc) lines.push(`Cc: ${clean(m.cc)}`);
  if (m.bcc) lines.push(`Bcc: ${clean(m.bcc)}`);
  lines.push(`Subject: ${encodeHeader(clean(m.subject))}`);
  if (m.inReplyTo) lines.push(`In-Reply-To: ${clean(m.inReplyTo)}`);
  if (m.references) lines.push(`References: ${clean(m.references)}`);
  lines.push("MIME-Version: 1.0", 'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64", "");
  const bytes = new TextEncoder().encode(m.body.replace(/\r?\n/g, "\r\n"));
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  const b64 = btoa(s).replace(/.{76}/g, "$&\r\n");
  return b64url(new TextEncoder().encode(lines.join("\r\n") + "\r\n" + b64));
}
