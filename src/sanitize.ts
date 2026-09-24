/**
 * HTML email sanitizer built on HTMLRewriter.
 *
 * Email HTML is hostile input: it arrives from anyone, and a mail client that
 * renders it naively hands attackers script execution against a logged-in
 * session. This is the first of two layers — the second is serving the result
 * from a separate route into a sandboxed iframe under a strict CSP, so a miss
 * here still cannot reach the app.
 *
 * The policy is an allowlist. Anything not named is dropped, because a
 * denylist is a promise to have thought of every tag, and nobody has.
 */

/** Removed along with everything inside them. */
const DROP_WITH_CONTENT = new Set([
  "script", "style", "iframe", "frame", "frameset", "object", "embed", "applet",
  "form", "input", "button", "select", "option", "textarea",
  "link", "meta", "base", "svg", "math", "noscript", "template", "head", "title",
]);

/** Kept, with their attributes filtered. Everything else keeps only its text. */
const ALLOWED_TAGS = new Set([
  "html", "body", "div", "p", "span", "br", "hr", "a", "img",
  "b", "strong", "i", "em", "u", "s", "strike", "small", "big", "sub", "sup",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "li", "dl", "dt", "dd",
  "blockquote", "pre", "code", "q", "cite",
  "table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption", "colgroup", "col",
  "center", "font", "abbr", "address", "article", "aside", "figure", "figcaption",
  "header", "footer", "main", "nav", "section", "time", "mark", "wbr",
]);

const GLOBAL_ATTRS = new Set(["title", "dir", "lang", "align", "valign", "style"]);

const TAG_ATTRS: Record<string, Set<string>> = {
  a: new Set(["href"]),
  img: new Set(["src", "alt", "width", "height", "border"]),
  td: new Set(["colspan", "rowspan", "width", "height", "bgcolor", "nowrap"]),
  th: new Set(["colspan", "rowspan", "width", "height", "bgcolor", "nowrap"]),
  table: new Set(["width", "border", "cellpadding", "cellspacing", "bgcolor"]),
  tr: new Set(["bgcolor"]),
  col: new Set(["span", "width"]),
  colgroup: new Set(["span", "width"]),
  font: new Set(["color", "face", "size"]),
  ol: new Set(["start", "type"]),
};

/** CSS that can exfiltrate, execute, or escape the iframe's flow. */
const DANGEROUS_CSS =
  /(url\s*\(|expression\s*\(|javascript\s*:|behavior\s*:|@import|position\s*:\s*(fixed|absolute|sticky)|-moz-binding)/i;

/** Whitespace and control characters, used to smuggle scheme names. */
const URL_NOISE = /[\u0000-\u0020\u00a0\u2000-\u200b\ufeff]/g;

/** 1x1 transparent GIF, used in place of a blocked remote image. */
const BLOCKED_PIXEL =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

export interface SanitizeOptions {
  /**
   * Remote images are tracking pixels by default — they tell the sender the
   * message was opened, from which IP, and when. Off unless asked for.
   */
  allowRemoteImages: boolean;
  /** Maps a MIME `cid:` reference to a local URL for an inline attachment. */
  resolveCid?: (contentId: string) => string | null;
}

export interface SanitizeResult {
  html: string;
  blockedImages: number;
}

function safeUrl(value: string): string | null {
  const trimmed = value.trim();
  // Strip whitespace and control characters before testing the scheme:
  // browsers parse "java\tscript:" and "java\nscript:" as javascript:.
  const normalized = trimmed.replace(URL_NOISE, "").toLowerCase();
  if (normalized.startsWith("http://") || normalized.startsWith("https://")) return trimmed;
  if (normalized.startsWith("mailto:")) return trimmed;
  return null;
}

function safeStyle(value: string): string | null {
  const cleaned = value
    .split(";")
    .map((declaration) => declaration.trim())
    .filter((declaration) => declaration.length > 0 && !DANGEROUS_CSS.test(declaration))
    .join("; ");
  return cleaned.length > 0 ? cleaned : null;
}

export async function sanitizeEmailHtml(
  html: string,
  options: SanitizeOptions,
): Promise<SanitizeResult> {
  let blockedImages = 0;

  const rewriter = new HTMLRewriter().on("*", {
    element(element) {
      const tag = element.tagName.toLowerCase();

      if (DROP_WITH_CONTENT.has(tag)) {
        element.remove();
        return;
      }

      if (!ALLOWED_TAGS.has(tag)) {
        // Unknown tag: keep the words, discard the element.
        element.removeAndKeepContent();
        return;
      }

      const allowed = TAG_ATTRS[tag];
      for (const [name, value] of [...element.attributes]) {
        const attr = name.toLowerCase();

        // Every on* handler goes, without exception.
        if (attr.startsWith("on") || !(GLOBAL_ATTRS.has(attr) || allowed?.has(attr))) {
          element.removeAttribute(name);
          continue;
        }

        if (attr === "style") {
          const safe = safeStyle(value);
          if (safe === null) element.removeAttribute(name);
          else element.setAttribute(name, safe);
          continue;
        }

        if (attr === "href") {
          const safe = safeUrl(value);
          if (safe === null) element.removeAttribute(name);
          else element.setAttribute(name, safe);
          continue;
        }

        if (attr === "src") {
          const trimmed = value.trim();
          if (trimmed.toLowerCase().startsWith("cid:")) {
            const resolved = options.resolveCid?.(trimmed.slice(4));
            if (resolved) element.setAttribute("src", resolved);
            else element.remove();
            continue;
          }
          if (!options.allowRemoteImages) {
            blockedImages += 1;
            element.setAttribute("src", BLOCKED_PIXEL);
            element.setAttribute("data-blocked", trimmed.slice(0, 200));
            continue;
          }
          const safe = safeUrl(trimmed);
          if (safe === null) element.remove();
          else element.setAttribute("src", safe);
          continue;
        }
      }

      if (tag === "a") {
        // Opened in a sandboxed frame; deny the opener and any link equity.
        element.setAttribute("target", "_blank");
        element.setAttribute("rel", "noopener noreferrer nofollow");
      }
    },

    comments(comment) {
      // Conditional comments are a documented way to hide markup from parsers.
      comment.remove();
    },
  });

  const transformed = rewriter.transform(
    new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }),
  );

  return { html: await transformed.text(), blockedImages };
}
