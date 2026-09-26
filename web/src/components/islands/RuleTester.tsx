/**
 * "Test this rule": checks the rule being edited against all the mail "Sort
 * mail I already have" would look at (the window, in Messages and every
 * folder), 20 at a time with progress, and lists the ones that would go in,
 * then the closest misses, or says none would. Built-in sample mail (marked
 * Sample) stands in when the mailbox has almost none.
 *
 * Reads the name, rule and window straight from the form, so it tests what
 * you typed. Each batch is announced as a `busta:rule-tested` event, which
 * the Where to look selector (SortPlaces) turns into per-place counts.
 * Needs JavaScript; the form works without it.
 */
import { useRef, useState } from "preact/hooks";

export interface TestRow { id: string; from: string; subject: string; place: string | null; in?: boolean; p?: number; error?: string }
export interface RuleTestedDetail { rule: string; days: number; limit: number; rows: TestRow[]; done: boolean; sample: boolean }

interface Props {
  endpoint: string;
  nameField: string;
  ruleField: string;
  /** The window inputs (SortPlaces); without them the default window is used. */
  daysField?: string;
  limitField?: string;
  /** Folder names by id, to show where each email is now. */
  folders?: { id: string; name: string }[];
  /** The folder being edited: its own mail that doesn't fit "would leave". */
  folderId?: string;
}

const value = (id?: string) => (id ? (document.getElementById(id) as HTMLInputElement | null)?.value ?? "" : "");

export default function RuleTester({ endpoint, nameField, ruleField, daysField, limitField, folders = [], folderId }: Props) {
  const [state, setState] = useState<"idle" | "loading" | "done" | "stopped" | "error">("idle");
  const [rows, setRows] = useState<TestRow[]>([]);
  const [total, setTotal] = useState(0);
  const [days, setDays] = useState(30);
  const [message, setMessage] = useState("");
  const [sample, setSample] = useState(false);
  const [allIn, setAllIn] = useState(false);
  const [allOut, setAllOut] = useState(false);
  const stop = useRef(false);
  const names = new Map(folders.map((f) => [f.id, f.name]));

  async function run() {
    const name = value(nameField);
    const rule = value(ruleField);
    const d = Number(value(daysField)) || 30;
    const limit = Number(value(limitField)) || 200;
    setState("loading");
    setMessage("");
    setRows([]);
    setTotal(0);
    setDays(d);
    setAllIn(false);
    setAllOut(false);
    stop.current = false;
    const seen = new Map<string, TestRow>();
    const announce = (done: boolean, isSample: boolean) =>
      window.dispatchEvent(new CustomEvent<RuleTestedDetail>("busta:rule-tested", { detail: { rule, days: d, limit, rows: [...seen.values()], done, sample: isSample } }));
    try {
      let offset: number | null = 0;
      while (offset !== null) {
        const res = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, rule, days: d, limit, offset }) });
        const data = (await res.json()) as { results?: TestRow[]; sample?: boolean; total?: number; next?: number | null; error?: string };
        if (!res.ok || !data.results) throw new Error(data.error ?? `HTTP ${res.status}`);
        for (const r of data.results) seen.set(r.id, r);
        setRows([...seen.values()]);
        setTotal(data.total ?? seen.size);
        setSample(!!data.sample);
        offset = data.next ?? null;
        if (stop.current && offset !== null) {
          announce(false, !!data.sample);
          setState("stopped");
          return;
        }
        announce(offset === null, !!data.sample);
      }
      setState("done");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
      setState("error");
    }
  }

  const pct = (p?: number) => (typeof p === "number" ? `${Math.round(p * 100)}%` : "");
  const hits = rows.filter((r) => r.in).sort((a, b) => (b.p ?? 0) - (a.p ?? 0));
  const misses = rows.filter((r) => !r.in && !r.error).sort((a, b) => (b.p ?? 0) - (a.p ?? 0));
  const failed = rows.filter((r) => r.error).length;
  const where = (r: TestRow) => {
    if (sample) return null;
    const n = r.place ? names.get(r.place) : null;
    return <span class={`where${r.place ? " in-folder" : ""}`}>{r.place ? (n ?? "A folder") : "Messages"}</span>;
  };
  const line = (r: TestRow) => (
    <li>
      <span class="who"><b>{r.from}</b><span>{r.subject}</span></span>
      {where(r)}
      {r.error ? <span class="verdict fail" title={r.error}>Couldn't check</span>
        : r.in ? <span class="verdict in">✓ In · {pct(r.p)}</span>
        : <span class="verdict out">{folderId && r.place === folderId ? "Would leave" : "✕ Out"} · {pct(r.p)}</span>}
    </li>
  );
  const checked = rows.length;
  const allFailed = checked > 0 && failed === checked;
  const scope = sample ? "" : ` from the last ${days} day${days === 1 ? "" : "s"}, in Messages and every folder`;
  const finished = state === "done" || state === "stopped";

  return (
    <div class="tester">
      <div class="bar">
        {state === "loading"
          ? <button type="button" onClick={() => { stop.current = true; }}>Stop</button>
          : <button type="button" onClick={run}>{finished ? "Test again" : "Test this rule"}</button>}
        {state === "loading"
          ? <span class="scan" role="status"><span class="spin" aria-hidden="true" />{checked === 0 ? "Checking…" : `Checked ${checked}${total ? ` of ${total}` : ""} · ${hits.length} would go in so far`}</span>
          : finished
            ? <span class="hint" role="status">
                <b>{allFailed ? "Couldn't check your mail." : hits.length === 0 ? "None would go in." : `${hits.length} would go in.`}</b>{" "}
                {state === "stopped" ? `Stopped after ${checked} of ${total}.` : sample ? "" : `Checked ${checked === total ? "all " : ""}${checked} email${checked === 1 ? "" : "s"}${scope}.`}
                {failed > 0 && ` ${failed} couldn't be checked.`}
                {sample && <span class="sample">Sample mail</span>}
              </span>
            : <span class="hint">Checks the mail you already have{daysField ? ", under Where to look," : " from the last 30 days"} and shows what would go in. Nothing is filed.</span>}
      </div>
      {state === "loading" && total > 0 && <div class="prog" aria-hidden="true"><i style={`width:${Math.round((checked / total) * 100)}%`} /></div>}
      {finished && sample && <p class="hint">Your mailbox is new, so this test uses examples. Once you have mail, it tests yours.</p>}
      {state === "error" && <p class="err" role="alert">Couldn't test the rule: {message}</p>}
      {state === "loading" && rows.length === 0 && (
        <ul class="rows">{[0, 1, 2].map(() => <li class="skeleton"><span /><span /></li>)}</ul>
      )}
      {hits.length > 0 && (
        <>
          <ul class="rows">{(allIn ? hits : hits.slice(0, 5)).map(line)}</ul>
          {hits.length > 5 && !allIn && <button type="button" class="more" onClick={() => setAllIn(true)}>Show all {hits.length}</button>}
        </>
      )}
      {finished && hits.length === 0 && !sample && !allFailed && (
        <div class="empty2">
          <b>{checked === 0 ? "There's no mail to test against yet." : `Nothing${scope} matches this rule.`}</b>
          {checked > 0 && <span>That's fine for mail you're expecting. To look further back, raise the days{daysField ? " under Where to look" : ""} and test again. If you know some should match, name the sender or a word they use.</span>}
        </div>
      )}
      {finished && misses.length > 0 && (
        <>
          <span class="sub2">{hits.length ? `Closest that stay out · ${misses.length}` : "Closest · still under 75%"}</span>
          <ul class="rows">{(allOut ? misses : misses.slice(0, hits.length ? 2 : 3)).map(line)}</ul>
          {misses.length > (hits.length ? 2 : 3) && !allOut && <button type="button" class="more" onClick={() => setAllOut(true)}>Show all {misses.length}</button>}
        </>
      )}
    </div>
  );
}
