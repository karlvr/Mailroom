import { fromB64url, randomToken } from "./crypto";

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

/** The parts of a message by kind. `calendar` has the text of each calendar part that is not an attachment, such as an invitation. */
interface MessageParts {
  plain: string[];
  html: string[];
  calendar: string[];
  attachments: GmailPart[];
}

function walk(part: GmailPart, out: MessageParts) {
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
  else if (type === "text/calendar") out.calendar.push(decodeData(part.body.data));
}

/**
 * Returns the bare addresses of an address header, such as To, in lower case. It reads each address in
 * angle brackets, and each address without them. A display name in quotes, with commas or an "@" in
 * it, does not count as an address.
 */
export function addressList(value: string | undefined): string[] {
  if (!value) return [];
  // Remove the display names in quotes, and the comments in parentheses.
  const plain = value.replace(/"(?:[^"\\]|\\.)*"/g, "").replace(/\([^()]*\)/g, "");
  const out: string[] = [];
  for (const part of plain.split(/[,;]/)) {
    const angle = /<([^<>]*)>/.exec(part);
    const addr = (angle ? angle[1]! : part).trim().toLowerCase();
    if (addr.includes("@")) out.push(addr);
  }
  return out;
}

/** One address of an address header, such as To. */
export interface Mailbox {
  /** The address as the header gives it, with its display name, for example `"Smith, Ana" <ana@example.com>`. */
  text: string;
  /** The display name without quotes, or "" when the address does not have one. */
  name: string;
  /** The bare address in lower case. */
  address: string;
}

/**
 * Returns the addresses of an address header, such as To, with their display names. It splits the
 * header at each comma or semicolon outside quotes, comments and angle brackets. Each item gets its
 * address from `addressList`, so an address in a display name does not count. Use this to copy
 * addresses into a new message. To check addresses, use `addressList`.
 */
export function mailboxes(value: string | undefined): Mailbox[] {
  if (!value) return [];
  const out: Mailbox[] = [];
  const add = (text: string) => {
    const addresses = addressList(text);
    if (addresses.length === 1) {
      const name = /^([^<]*)</.exec(text)?.[1]?.trim() ?? "";
      out.push({ text, name: name.replace(/^"(.*)"$/, "$1").replace(/\\(.)/g, "$1"), address: addresses[0]! });
    } else {
      // An item with a quote that does not end can hold more than one address.
      for (const address of addresses) out.push({ text: address, name: "", address });
    }
  };
  let start = 0;
  let quoted = false;
  let angle = false;
  let comment = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (quoted) {
      if (c === "\\") i++;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === "(") comment++;
    else if (c === ")") comment = Math.max(0, comment - 1);
    else if (c === "<") angle = true;
    else if (c === ">") angle = false;
    else if ((c === "," || c === ";") && !angle && !comment) {
      add(value.slice(start, i).trim());
      start = i + 1;
    }
  }
  add(value.slice(start).trim());
  return out;
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
  const out: MessageParts = { plain: [], html: [], calendar: [], attachments: [] };
  walk(payload, out);
  return out;
}

/** Returns the plain text of the parts of a message, or the text of its HTML when it does not have plain text. */
function plainText(out: MessageParts): string {
  const text = out.plain.length ? out.plain.join("\n\n") : htmlToText(out.html.join("\n\n"));
  return text.replace(/\r\n/g, "\n").trim();
}

/**
 * Returns the plain text of a message, its attachments, and the text of each calendar part that is not
 * an attachment. `part_id` of an attachment addresses the part in the message.
 */
export function extractBody(payload: GmailPart) {
  const out = collect(payload);
  return {
    text: plainText(out),
    attachments: out.attachments.map((p) => ({
      part_id: p.partId ?? null,
      filename: p.filename ?? "",
      mimeType: p.mimeType ?? "",
      size: p.body?.size ?? 0,
    })),
    calendar: out.calendar,
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

/** The body of a message: its plain text, and its HTML when the message has an HTML version. */
export interface MessageBody {
  text: string;
  html?: string;
}

/**
 * Returns HTML that another message can include: the content of the body element, with the styles of
 * the head, and without scripts.
 */
function innerHtml(html: string): string {
  const head = /<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(html)?.[1] ?? "";
  const styles = head.match(/<style\b[\s\S]*?<\/style>/gi) ?? [];
  const body = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html.replace(/<head\b[\s\S]*?<\/head>/i, "");
  return (
    styles.join("") +
    body
      .replace(/<script\b[\s\S]*?<\/script>/gi, "")
      .replace(/<!doctype[^>]*>|<\/?(html|body)\b[^>]*>/gi, "")
      .trim()
  );
}

/**
 * Returns the body of a message. The text is the same as in `extractBody`. The HTML is the content of
 * each HTML part, without its head and scripts, so that another message can include it.
 */
export function messageBody(payload: GmailPart): MessageBody {
  const out = collect(payload);
  return { text: plainText(out), ...(out.html.length ? { html: out.html.map(innerHtml).join("<br>") } : {}) };
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Returns plain text as HTML, with each line break as a <br> and each web address as a link. */
function textToHtml(text: string): string {
  const html = text
    .split(/(https?:\/\/[^\s<>"]+)/)
    .map((piece, i) => {
      if (i % 2 === 0) return escapeHtml(piece);
      // Punctuation at the end of an address is usually part of the sentence.
      const [, url, tail] = /^(.*?)([.,;:!?)\]'"]*)$/.exec(piece)!;
      return `<a href="${escapeHtml(url!)}">${escapeHtml(url!)}</a>${escapeHtml(tail!)}`;
    })
    .join("")
    .replace(/\r?\n/g, "<br>");
  return `<div dir="ltr">${html}</div>`;
}

/**
 * A quote of another message, or a forwarded message, that goes under the text of the author of a new
 * message. The HTML has the quote markup of Gmail, so Gmail can hide the quote behind "…".
 */
export interface Quote {
  text: string;
  html: string;
}

// The start of the quote markup of Gmail, in a reply and in a forward.
const QUOTE_START = /<div\b[^>]*\bclass="gmail_quote\b/i;

/** A time zone for a date in a quote line: an IANA time zone, or a fixed offset from UTC in minutes. */
export type QuoteTimeZone = { name: string } | { offsetMinutes: number };

/** Returns true when `name` is an IANA time zone that the runtime knows, such as Pacific/Auckland. */
export function isTimeZone(name: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/** Returns the offset from UTC in a Date header, in minutes, or 0 when the header does not have an offset. */
export function dateOffsetMinutes(date: string | undefined): number {
  const m = /([+-])(\d{2})(\d{2})(?:\s*\([^)]*\))?\s*$/.exec(date ?? "");
  return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
}

/** Returns a time as Gmail gives it in a quote line, for example "Tue, 10 Nov 2026 at 09:00". */
export function quoteDate(ms: number, zone: QuoteTimeZone): string {
  const fixed = "offsetMinutes" in zone;
  const parts = new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: fixed ? "UTC" : zone.name,
  }).formatToParts(fixed ? ms + zone.offsetMinutes * 60_000 : ms);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return `${p.weekday}, ${p.day} ${p.month} ${p.year} at ${p.hour}:${p.minute}`;
}

/**
 * Returns the line above a quote, for example "On Tue, 10 Nov 2026 at 09:00, Ana <ana@example.com> wrote:".
 * `from` is the From header of the quoted message, and `date` is its time from `quoteDate`, or null when it does not have a time.
 */
export function attributionLine(from: string | undefined, date: string | null): string {
  const m = mailboxes(from)[0];
  const who = m ? (m.name ? `${m.name} <${m.address}>` : `<${m.address}>`) : "";
  return [date ? `On ${date},` : "", who, "wrote:"].filter(Boolean).join(" ");
}

/** Returns the quote of a message in a reply. The quote does not have the inline images of the message, because the reply does not have its parts. */
export function replyQuote(attribution: string, body: MessageBody): Quote {
  return {
    text: `${attribution}\n\n${body.text
      .split("\n")
      .map((l) => (l ? `> ${l}` : ">"))
      .join("\n")}`,
    html:
      `<div class="gmail_quote gmail_quote_container"><div dir="ltr" class="gmail_attr">${escapeHtml(attribution)}<br></div>` +
      `<blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex">` +
      `${body.html ?? textToHtml(body.text)}</blockquote></div>`,
  };
}

/** The headers and the body of a message, for the forwarded part of a new message. */
export interface ForwardedMessage {
  from?: string;
  date?: string;
  subject?: string;
  to?: string;
  cc?: string;
  body: MessageBody;
}

/** Returns a forwarded message as Gmail shows it: a "Forwarded message" line, the headers, then the body. */
export function forwardQuote(m: ForwardedMessage): Quote {
  const marker = "---------- Forwarded message ---------";
  const headers = Object.entries({ From: m.from, Date: m.date, Subject: m.subject, To: m.to, Cc: m.cc }).filter(
    (h): h is [string, string] => !!h[1],
  );
  return {
    text: `${marker}\n${headers.map(([k, v]) => `${k}: ${v}`).join("\n")}\n\n${m.body.text}`,
    html:
      `<div class="gmail_quote gmail_quote_container"><div dir="ltr" class="gmail_attr">${marker}<br>` +
      `${headers.map(([k, v]) => `${k}: ${escapeHtml(v)}<br>`).join("")}</div><br><br>${m.body.html ?? textToHtml(m.body.text)}</div>`,
  };
}

/** Returns the body of a new message: the plain text of the author, then the quote. Without a quote, the body is plain text only. */
export function withQuote(text: string, quote: Quote | null): MessageBody {
  if (!quote) return { text };
  const own = text.trimEnd();
  return own ? { text: `${own}\n\n${quote.text}`, html: `${textToHtml(own)}<br>${quote.html}` } : { ...quote };
}

/**
 * Splits a body at the quote markup of Gmail, into the part that the author wrote and the quote under it.
 * The quote is null when the body does not have quote markup. This works for the bodies of `withQuote`,
 * and for replies and forwards that a person wrote in Gmail.
 */
export function splitQuote(body: MessageBody): { own: MessageBody; quote: Quote | null } {
  const at = body.html?.search(QUOTE_START) ?? -1;
  if (!body.html || at < 0) return { own: body, quote: null };
  const ownHtml = body.html.slice(0, at).replace(/(<br\s*\/?>\s*)+$/i, "");
  const quoteHtml = body.html.slice(at);
  // The plain text has the same first line of the quote as the HTML, such as the line "On … wrote:".
  const first = htmlToText(quoteHtml).split("\n")[0]!.trim();
  const t = first ? body.text.indexOf(first) : -1;
  if (t < 0) return { own: { text: htmlToText(ownHtml), html: ownHtml }, quote: { text: htmlToText(quoteHtml), html: quoteHtml } };
  return { own: { text: body.text.slice(0, t).trimEnd(), html: ownHtml }, quote: { text: body.text.slice(t), html: quoteHtml } };
}

/** Returns the subject of a forward of a message with the subject `subject`. */
export const forwardSubject = (subject: string | undefined) =>
  /^(fwd?|fw):/i.test(subject ?? "") ? subject! : `Fwd: ${subject ?? ""}`.trim();

/** Returns the standard base64 form of the UTF-8 bytes of a text. */
function utf8Base64(value: string): string {
  let s = "";
  for (const b of new TextEncoder().encode(value)) s += String.fromCharCode(b);
  return btoa(s);
}

/** RFC 2047 encoded-word when the value isn't plain ASCII. */
function encodeHeader(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${utf8Base64(value)}?=`;
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
  /** The Content-ID of the file without angle brackets, when the HTML of the message can show the file as an image with cid:. */
  contentId?: string;
}

/** A new message, with optional attachments. */
export interface NewMessage {
  /** The sender, for example a send-as address of the account. Without it, Gmail uses the default address of the account. */
  from?: string;
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  /** The body. Without HTML, the message is plain text only. */
  body: MessageBody;
  inReplyTo?: string;
  references?: string;
  attachments?: MimeAttachment[];
}

/** Returns a header parameter value in quotes, with characters that would end the value removed. */
const quoted = (v: string) => `"${encodeHeader(clean(v).replace(/["\\]/g, ""))}"`;

/** Returns a MIME part with text of the subtype, such as plain or html. */
const textPart = (subtype: string, content: string) =>
  [`Content-Type: text/${subtype}; charset="UTF-8"`, "Content-Transfer-Encoding: base64", "", wrap(utf8Base64(content.replace(/\r?\n/g, "\r\n")))].join(
    "\r\n",
  );

/** Returns a MIME part with a file. An inline file shows in the HTML of its message, and other files show as attachments. */
const filePart = (a: MimeAttachment, disposition: "inline" | "attachment") =>
  [
    `Content-Type: ${clean(a.mimeType) || "application/octet-stream"}; name=${quoted(a.filename)}`,
    `Content-Disposition: ${disposition}; filename=${quoted(a.filename)}`,
    ...(a.contentId ? [`Content-ID: <${clean(a.contentId).replace(/[<>]/g, "")}>`] : []),
    "Content-Transfer-Encoding: base64",
    "",
    wrap(a.base64),
  ].join("\r\n");

/** Returns a multipart MIME part of the subtype, such as mixed, with the parts. */
function multipart(subtype: string, parts: string[]): string {
  // Base64 has no "-", so the boundary cannot occur in the content.
  const boundary = `mailroom-${randomToken(12)}`;
  return [`Content-Type: multipart/${subtype}; boundary="${boundary}"`, "", ...parts.map((p) => `--${boundary}\r\n${p}`), `--${boundary}--`, ""].join(
    "\r\n",
  );
}

/**
 * Returns the message as RFC 822 text with CRLF line ends. The text is ASCII only. A body with HTML
 * becomes multipart/alternative. An attachment that the HTML shows with cid: goes with the HTML in
 * multipart/related. The HTML loses each image that refers with cid: to a file that the message does
 * not have, so that the message does not show a broken image.
 */
export function buildMessage(m: NewMessage): string {
  const lines = m.from ? [`From: ${clean(m.from)}`] : [];
  lines.push(`To: ${clean(m.to)}`);
  if (m.cc) lines.push(`Cc: ${clean(m.cc)}`);
  if (m.bcc) lines.push(`Bcc: ${clean(m.bcc)}`);
  lines.push(`Subject: ${encodeHeader(clean(m.subject))}`);
  if (m.inReplyTo) lines.push(`In-Reply-To: ${clean(m.inReplyTo)}`);
  if (m.references) lines.push(`References: ${clean(m.references)}`);
  lines.push("MIME-Version: 1.0");

  const files = m.attachments ?? [];
  const ids = new Set(files.flatMap((a) => (a.contentId ? [a.contentId] : [])));
  const html = m.body.html?.replace(/<img\b[^>]*?\bsrc\s*=\s*["']?cid:([^"'\s>]+)[^>]*>/gi, (tag, id: string) => (ids.has(id) ? tag : ""));
  const inline = html === undefined ? [] : files.filter((a) => a.contentId && html.includes(`cid:${a.contentId}`));
  const attached = files.filter((a) => !inline.includes(a));

  let body = textPart("plain", m.body.text);
  if (html !== undefined) body = multipart("alternative", [body, textPart("html", html)]);
  if (inline.length) body = multipart("related", [body, ...inline.map((a) => filePart(a, "inline"))]);
  if (attached.length) body = multipart("mixed", [body, ...attached.map((a) => filePart(a, "attachment"))]);
  return [...lines, body].join("\r\n");
}

/**
 * How Mailroom reads an attachment: as text, as HTML, as iCalendar data, as a document that Workers AI
 * converts, or as an image that an agent can see.
 */
export type AttachmentKind =
  | { kind: "text" | "html" | "calendar" }
  | {
      kind: "document";
      /** The file name for the conversion. It ends with the extension of the document type. */
      name: string;
      /** The media type of the document. */
      type: string;
    }
  | {
      kind: "image";
      /** The media type of the image. */
      type: string;
    };

// The document types that Workers AI converts to Markdown, by file extension.
const DOCUMENT_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
};

// The image types that an agent can see, by file extension.
const IMAGE_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
};

// The extensions of text files. A sender can give such a file a general media type, such as application/octet-stream.
const TEXT_EXTENSIONS = new Set(["txt", "log", "csv", "tsv", "json", "xml", "md", "yaml", "yml"]);

/**
 * Returns how Mailroom reads an attachment, from its media type and its file name, or null when Mailroom
 * cannot read it. The extension of the file name counts first, because senders often give a general media type.
 */
export function attachmentKind(mimeType: string, filename: string): AttachmentKind | null {
  const type = mimeType.toLowerCase();
  const ext = /\.([a-z0-9]+)$/i.exec(filename)?.[1]?.toLowerCase() ?? "";
  if (ext === "ics" || type === "text/calendar" || type === "application/ics") return { kind: "calendar" };
  if (ext === "html" || ext === "htm" || type === "text/html") return { kind: "html" };
  const doc = DOCUMENT_TYPES[ext] ? ext : Object.keys(DOCUMENT_TYPES).find((e) => DOCUMENT_TYPES[e] === type);
  if (doc) {
    const base = filename.trim() || "attachment";
    return { kind: "document", name: base.toLowerCase().endsWith(`.${doc}`) ? base : `${base}.${doc}`, type: DOCUMENT_TYPES[doc]! };
  }
  const image = IMAGE_TYPES[ext] ?? (type.startsWith("image/") ? IMAGE_TYPES[type.slice("image/".length)] : undefined);
  if (image) return { kind: "image", type: image };
  if (TEXT_EXTENSIONS.has(ext) || type.startsWith("text/") || type === "application/json" || type === "application/xml") return { kind: "text" };
  return null;
}

/**
 * Returns a Content-Disposition header that makes a browser save a file with the name `filename`. The
 * header has a plain ASCII name, and the full name in UTF-8 for the clients that read it.
 */
export function attachmentDisposition(filename: string): string {
  const name = filename.trim() || "attachment";
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const utf8 = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

/** Returns the part of a message with the part ID, or null when the message has no such part. */
export function findPart(payload: GmailPart, partId: string): GmailPart | null {
  if (payload.partId === partId) return payload;
  for (const p of payload.parts ?? []) {
    const hit = findPart(p, partId);
    if (hit) return hit;
  }
  return null;
}
