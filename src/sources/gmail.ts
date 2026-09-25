/**
 * The Gmail API, as much of it as a connected account needs: the mailbox's
 * profile and history (what changed since last time), raw messages, label
 * changes, trash, send, and the Pub/Sub watch. REST over fetch.
 */
const API = "https://gmail.googleapis.com/gmail/v1/users/me";

export class GmailError extends Error {
  constructor(message: string, readonly status: number, readonly reason: string | null) { super(message); }
  /** Worth trying again later (rate limit, Google having a moment). */
  get transient() { return this.status === 429 || this.status >= 500; }
}

/** A source of fresh access tokens for one account. */
export type TokenSource = () => Promise<string>;

async function call<T>(token: TokenSource, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${await token()}`, ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
  });
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => ({}))) as T & { error?: { message?: string; errors?: { reason?: string }[] } };
  if (!res.ok) {
    throw new GmailError(data.error?.message ?? `Gmail ${res.status}`, res.status, data.error?.errors?.[0]?.reason ?? null);
  }
  return data;
}

export const profile = (t: TokenSource) => call<{ emailAddress: string; historyId: string; messagesTotal: number }>(t, "/profile");

/** Ask Gmail to publish changes to `topic`. Lasts up to 7 days; renew daily. */
export const watch = (t: TokenSource, topic: string) =>
  call<{ historyId: string; expiration: string }>(t, "/watch", {
    method: "POST",
    body: JSON.stringify({ topicName: topic, labelIds: ["INBOX", "SENT", "UNREAD", "STARRED", "TRASH"], labelFilterBehavior: "include" }),
  });

export const stopWatch = (t: TokenSource) => call<void>(t, "/stop", { method: "POST" });

/** Message ids matching a Gmail search, newest first. */
export const listMessages = (t: TokenSource, q: string, pageToken?: string) =>
  call<{ messages?: { id: string; threadId: string }[]; nextPageToken?: string; resultSizeEstimate?: number }>(
    t, `/messages?${new URLSearchParams({ q, maxResults: "500", includeSpamTrash: "false", ...(pageToken ? { pageToken } : {}) })}`,
  );

export interface RawMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  internalDate: string;
  historyId: string;
  sizeEstimate: number;
  /** base64url RFC 822 bytes. */
  raw: string;
}

export const getRaw = (t: TokenSource, id: string) => call<RawMessage>(t, `/messages/${id}?format=raw`);

export const getHeaders = (t: TokenSource, id: string, names: string[]) =>
  call<{ id: string; threadId: string; payload?: { headers?: { name: string; value: string }[] } }>(
    t, `/messages/${id}?format=metadata&${names.map((n) => `metadataHeaders=${encodeURIComponent(n)}`).join("&")}`,
  );

export interface HistoryRecord {
  id: string;
  messagesAdded?: { message: { id: string; threadId: string; labelIds?: string[] } }[];
  messagesDeleted?: { message: { id: string } }[];
  labelsAdded?: { message: { id: string; labelIds?: string[] }; labelIds: string[] }[];
  labelsRemoved?: { message: { id: string; labelIds?: string[] }; labelIds: string[] }[];
}

/** Changes since `startHistoryId`. A 404 means it's too old: re-list recent mail instead. */
export const listHistory = (t: TokenSource, startHistoryId: string, pageToken?: string) =>
  call<{ history?: HistoryRecord[]; historyId: string; nextPageToken?: string }>(
    t, `/history?${new URLSearchParams({ startHistoryId, maxResults: "500", ...(pageToken ? { pageToken } : {}) })}`,
  );

export const modify = (t: TokenSource, id: string, add: string[], remove: string[]) =>
  call<unknown>(t, `/messages/${id}/modify`, { method: "POST", body: JSON.stringify({ addLabelIds: add, removeLabelIds: remove }) });

export const trash = (t: TokenSource, id: string) => call<unknown>(t, `/messages/${id}/trash`, { method: "POST" });
export const untrash = (t: TokenSource, id: string) => call<unknown>(t, `/messages/${id}/untrash`, { method: "POST" });

export const sendRaw = (t: TokenSource, raw: Uint8Array, threadId?: string | null) =>
  call<{ id: string; threadId: string; labelIds?: string[] }>(t, "/messages/send", {
    method: "POST",
    body: JSON.stringify({ raw: toB64url(raw), ...(threadId ? { threadId } : {}) }),
  });

// --- bytes ------------------------------------------------------------------

export function fromB64url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function toB64url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64Lines(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return (btoa(bin).match(/.{1,76}/g) ?? []).join("\r\n");
}

/** RFC 2047 for headers that aren't plain ASCII. */
function headerText(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${b64Lines(new TextEncoder().encode(value)).replace(/\r\n/g, "")}?=`;
}

/**
 * Build the message Gmail sends: text and HTML alternatives, plus any
 * attachments. Bcc is included; Gmail delivers to it and strips the header.
 */
export function buildMime(m: {
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string;
  html: string;
  headers: Record<string, string>;
  attachments: { filename: string; contentType: string; content: ArrayBuffer }[];
}): Uint8Array {
  const enc = new TextEncoder();
  const boundary = (tag: string) => `=_busta_${tag}_${crypto.randomUUID().replace(/-/g, "")}`;
  const alt = boundary("alt");
  const lines: string[] = [
    `From: ${m.from}`,
    `To: ${m.to.join(", ")}`,
    ...(m.cc.length ? [`Cc: ${m.cc.join(", ")}`] : []),
    ...(m.bcc.length ? [`Bcc: ${m.bcc.join(", ")}`] : []),
    `Subject: ${headerText(m.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0",
    ...Object.entries(m.headers).map(([k, v]) => `${k}: ${v}`),
  ];
  const altPart = [
    `Content-Type: multipart/alternative; boundary="${alt}"`,
    "",
    `--${alt}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    b64Lines(enc.encode(m.text)),
    `--${alt}`,
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    b64Lines(enc.encode(m.html)),
    `--${alt}--`,
  ];
  if (m.attachments.length === 0) return enc.encode([...lines, ...altPart, ""].join("\r\n"));

  const mixed = boundary("mix");
  const parts = [...lines, `Content-Type: multipart/mixed; boundary="${mixed}"`, "", `--${mixed}`, ...altPart];
  for (const a of m.attachments) {
    const name = headerText(a.filename).replace(/"/g, "");
    parts.push(
      `--${mixed}`,
      `Content-Type: ${a.contentType || "application/octet-stream"}; name="${name}"`,
      `Content-Disposition: attachment; filename="${name}"`,
      "Content-Transfer-Encoding: base64",
      "",
      b64Lines(new Uint8Array(a.content)),
    );
  }
  parts.push(`--${mixed}--`, "");
  return enc.encode(parts.join("\r\n"));
}
