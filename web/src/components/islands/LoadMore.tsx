/**
 * Search pagination island. The server renders the first page; this loads
 * the rest, appending server-rendered rows from `<base>/search/more`, so the
 * rows are the same MailRow markup as the first page.
 *
 * Loads automatically when the sentinel scrolls into view, with a button as
 * the explicit fallback. When a slice comes back empty (the index scans a
 * bounded window per request) it stops and asks before walking older mail,
 * so a rare term in a big mailbox can't fire request after request unasked.
 * Before hydration (or without JS) it is a plain link to the next page, so
 * pagination never depends on this script.
 */
import { useEffect, useRef, useState } from "preact/hooks";

interface Props {
  /** `/mb/<address>/search/more`, the partial endpoint. */
  endpoint: string;
  /** `/mb/<address>/search`, for the no-JS link. */
  pageUrl: string;
  /** Query string without the cursor. */
  query: string;
  cursor: number | null;
  examined: number;
  shown: number;
}

type State = "idle" | "empty" | "loading" | "done" | "error";

export default function LoadMore({ endpoint, pageUrl, query, cursor: start, examined: startExamined, shown: startShown }: Props) {
  const [cursor, setCursor] = useState(start);
  const [pages, setPages] = useState<string[]>([]);
  const [state, setState] = useState<State>(start === null ? "done" : startShown === 0 ? "empty" : "idle");
  const [examined, setExamined] = useState(startExamined);
  const [shown, setShown] = useState(startShown);
  const [hydrated, setHydrated] = useState(false);
  const sentinel = useRef<HTMLDivElement>(null);
  const busy = useRef(false);

  useEffect(() => setHydrated(true), []);

  async function next() {
    if (busy.current || cursor === null) return;
    busy.current = true;
    setState("loading");
    try {
      const res = await fetch(`${endpoint}?${query}&cursor=${cursor}`, { headers: { accept: "text/html" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();
      const nextCursor = res.headers.get("x-next-cursor");
      const count = Number(res.headers.get("x-count") ?? 0);
      if (count > 0) setPages((p) => [...p, html]);
      setExamined((n) => n + Number(res.headers.get("x-examined") ?? 0));
      setShown((n) => n + count);
      setCursor(nextCursor ? Number(nextCursor) : null);
      setState(!nextCursor ? "done" : count === 0 ? "empty" : "idle");
    } catch {
      setState("error");
    } finally {
      busy.current = false;
    }
  }

  // Keep going while the bottom of the list is on screen, but only while
  // results are coming back ("idle"); an empty window waits for a click.
  useEffect(() => {
    if (!hydrated || !sentinel.current || cursor === null || state !== "idle") return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) void next();
    }, { rootMargin: "400px" });
    io.observe(sentinel.current);
    return () => io.disconnect();
  }, [hydrated, cursor, state]);

  const link = (label: string) =>
    hydrated
      ? <button type="button" onClick={() => next()}>{label}</button>
      : <a href={`${pageUrl}?${query}&cursor=${cursor}`}>{label}</a>;

  return (
    <div class="load-more">
      {pages.map((html) => (
        <ul class="more-rows" dangerouslySetInnerHTML={{ __html: html }} />
      ))}
      <div ref={sentinel} class="status" aria-live="polite">
        {state === "loading" && <span class="loading"><span class="spin" aria-hidden="true" />Loading more…</span>}
        {state === "idle" && link("Load more")}
        {state === "empty" && (
          <span class="empty-window">
            <span>No matches in the newest messages yet. Keep going to search older mail.</span>
            {link("Keep searching")}
          </span>
        )}
        {state === "error" && (
          <span class="err" role="alert">Couldn't load more results. <button type="button" onClick={() => next()}>Try again</button></span>
        )}
        {state === "done"
          ? <span class="count">{shown > 0 ? "End of results" : "No messages match"} · {examined.toLocaleString("en-US")} scanned</span>
          : <span class="count">{shown} shown · {examined.toLocaleString("en-US")} scanned</span>}
      </div>
    </div>
  );
}
