import { b64url, fromB64url, randomToken } from "./crypto";

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

function walk(part: GmailPart, out: { plain: string[]; html: string[]; attachments: GmailPart[] }) {
  const type = (part.mimeType ?? "").toLowerCase();
  if (part.filename && (part.body?.attachmentId || part.body?.size)) {
    out.attachments.push(part);
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

function collect(payload: GmailPart) {
  const out = { plain: [] as string[], html: [] as string[], attachments: [] as GmailPart[] };
  walk(payload, out);
  return out;
}

export function extractBody(payload: GmailPart) {
  const out = collect(payload);
  const text = out.plain.length ? out.plain.join("\n\n") : htmlToText(out.html.join("\n\n"));
  return {
    text: text.replace(/\r\n/g, "\n").trim(),
    attachments: out.attachments.map((p) => ({ filename: p.filename ?? "", mimeType: p.mimeType ?? "", size: p.body?.size ?? 0 })),
  };
}

/** Returns the parts of a message that are attachments, in the order of the message. */
export function attachmentParts(payload: GmailPart): GmailPart[] {
  return collect(payload).attachments;
}

/** Returns the standard base64 form, with padding, of base64url data from the Gmail API. */
export const toBase64 = (data: string) => {
  const s = data.replace(/=+$/, "").replace(/-/g, "+").replace(/_/g, "/");
  return s + "=".repeat((4 - (s.length % 4)) % 4);
};

/** The headers of a message, and its plain text, for the forwarded part of a new message. */
export interface ForwardedMessage {
  from?: string;
  date?: string;
  subject?: string;
  to?: string;
  cc?: string;
  text: string;
}

/** Returns the body of a forward: the note, then the headers and the text of the forwarded message, as Gmail shows a forward. */
export function forwardText(note: string | undefined, m: ForwardedMessage): string {
  const headers = [
    ["From", m.from],
    ["Date", m.date],
    ["Subject", m.subject],
    ["To", m.to],
    ["Cc", m.cc],
  ]
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${v}`);
  const intro = note?.trim() ? `${note.trim()}\n\n` : "";
  return `${intro}---------- Forwarded message ---------\n${headers.join("\n")}\n\n${m.text}`;
}

/** Returns the subject of a forward of a message with the subject `subject`. */
export const forwardSubject = (subject: string | undefined) =>
  /^(fwd?|fw):/i.test(subject ?? "") ? subject! : `Fwd: ${subject ?? ""}`.trim();

/** RFC 2047 encoded-word when the value isn't plain ASCII. */
function encodeHeader(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  const bytes = new TextEncoder().encode(value);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return `=?UTF-8?B?${btoa(s)}?=`;
}

const clean = (v: string) => v.replace(/[\r\n]+/g, " ").trim();

/** Wraps base64 data in lines of 76 characters, as MIME requires. */
const wrap = (b64: string) => b64.replace(/.{76}/g, "$&\r\n");

/** A file to attach to a new message. */
export interface MimeAttachment {
  filename: string;
  mimeType: string;
  /** The content in standard base64, without line breaks. */
  base64: string;
}

/** A new plain-text message, with optional attachments. */
export interface NewMessage {
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string;
  attachments?: MimeAttachment[];
}

/** Returns a header parameter value in quotes, with characters that would end the value removed. */
const quoted = (v: string) => `"${encodeHeader(clean(v).replace(/["\\]/g, ""))}"`;

/** Returns the message as RFC 822 text with CRLF line ends. The text is ASCII only. */
export function buildMessage(m: NewMessage): string {
  const lines = [`To: ${clean(m.to)}`];
  if (m.cc) lines.push(`Cc: ${clean(m.cc)}`);
  if (m.bcc) lines.push(`Bcc: ${clean(m.bcc)}`);
  lines.push(`Subject: ${encodeHeader(clean(m.subject))}`);
  if (m.inReplyTo) lines.push(`In-Reply-To: ${clean(m.inReplyTo)}`);
  if (m.references) lines.push(`References: ${clean(m.references)}`);
  lines.push("MIME-Version: 1.0");
  const bytes = new TextEncoder().encode(m.body.replace(/\r?\n/g, "\r\n"));
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  const text = ['Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64", "", wrap(btoa(s))];
  if (!m.attachments?.length) return [...lines, ...text].join("\r\n");

  // Base64 has no "-", so the boundary cannot occur in the content.
  const boundary = `mailroom-${randomToken(12)}`;
  const parts = [
    text.join("\r\n"),
    ...m.attachments.map((a) =>
      [
        `Content-Type: ${clean(a.mimeType) || "application/octet-stream"}; name=${quoted(a.filename)}`,
        `Content-Disposition: attachment; filename=${quoted(a.filename)}`,
        "Content-Transfer-Encoding: base64",
        "",
        wrap(a.base64),
      ].join("\r\n"),
    ),
  ];
  return [
    ...lines,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    ...parts.map((p) => `--${boundary}\r\n${p}`),
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

/** Returns the message in the base64url form that the `raw` field of the Gmail API takes. */
export const buildRawMessage = (m: NewMessage) => b64url(new TextEncoder().encode(buildMessage(m)));
