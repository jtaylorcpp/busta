/**
 * Tidy up a folder rule (designs/2026-09-24-why-not-folder, screen 5): asks
 * /folders/tidy for a "Goes in / Leaves out" rewrite, shows it beside yours,
 * then checks both versions against your recent mail so a tidier rule can't
 * quietly change what gets filed. Proposes only: onUse hands the text back.
 * Used inside the WhyNot and RuleTidy islands; styles in styles/why.css.
 */
import { Fragment } from "preact";
import { useEffect, useState } from "preact/hooks";

export interface CompareRow {
  id: string;
  from: string;
  subject: string;
  this?: boolean;
  before?: { in: boolean; p: number };
  after?: { in: boolean; p: number };
  changed?: boolean;
  error?: string;
}

export const pct = (p?: number) => (typeof p === "number" ? `${Math.round(p * 100)}%` : "");
const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

export async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

interface Props {
  /** /mb/<address> */
  base: string;
  name: string;
  rule: string;
  onUse: (text: string) => void;
  onCancel: () => void;
}

export default function TidyPanel({ base, name, rule, onUse, onCancel }: Props) {
  const [text, setText] = useState("");
  const [missing, setMissing] = useState<string[]>([]);
  const [editing, setEditing] = useState(false);
  const [err, setErr] = useState("");
  const [rows, setRows] = useState<CompareRow[] | null>(null);
  const [checking, setChecking] = useState(false);

  async function check(after: string) {
    setChecking(true);
    setRows(null);
    try {
      const r = await postJson<{ results: CompareRow[] }>(`${base}/folders/compare`, { name, before: rule, after });
      setRows(r.results);
    } catch (e) {
      setErr(`Couldn't check the rewrite: ${(e as Error).message}`);
    } finally {
      setChecking(false);
    }
  }

  useEffect(() => {
    postJson<{ text: string; missing: string[] }>(`${base}/folders/tidy`, { name, rule })
      .then((t) => { setText(t.text); setMissing(t.missing ?? []); void check(t.text); })
      .catch((e) => setErr((e as Error).message));
  }, []);

  const scored = rows?.filter((r) => !r.error) ?? [];
  const changed = scored.filter((r) => r.changed);

  return (
    <div class="tidy-panel">
      <div class="tp-head"><h3>Tidy up {name}</h3><button type="button" class="linkish" onClick={onCancel}>Close</button></div>
      <p class="fine">Rewritten for reading: same conditions, nothing added or dropped. <b>Check the result below before you use it.</b></p>
      {err && <p class="err" role="alert">{err}</p>}
      <div class="tidy">
        <div class="ver mine"><div class="vh"><b>Yours</b><span class="grow" /><span class="wc">{words(rule)} words</span></div><div class="vb">{rule}</div></div>
        <div class="ver new">
          <div class="vh"><b>Tidied</b><span class="grow" />{text && <span class="wc">{words(text)} words</span>}
            {text && <button type="button" class="linkish" onClick={() => setEditing(!editing)}>{editing ? "Done" : "Edit"}</button>}
          </div>
          <div class="vb">
            {!text && !err && <p class="loading"><i class="spin" aria-hidden="true" />Rewriting…</p>}
            {text && (editing
              ? <textarea rows={9} value={text} onInput={(e) => setText((e.target as HTMLTextAreaElement).value)} onBlur={() => void check(text)} />
              : <pre>{text}</pre>)}
          </div>
        </div>
      </div>
      {text && missing.length > 0 && (
        <p class="same warn missing">Not in the tidied version: <b>{missing.join(", ")}</b>. Make sure the rewrite still covers them, or edit it.</p>
      )}
      {text && (
        <div class="checkbox">
          <div class="cb-head"><b>Does it still mean the same?</b><span class="fine">both versions on your recent mail</span><span class="grow" />
            <button type="button" class="small" onClick={() => void check(text)} disabled={checking}>{checking ? "Checking…" : "Check again"}</button></div>
          {checking && <p class="loading"><i class="spin" aria-hidden="true" />Scoring {name} both ways…</p>}
          {rows && (changed.length === 0
            ? <p class="same">✓ <b>Same result on all {scored.length}</b> of your recent messages.</p>
            : (
              <Fragment>
                <p class="same warn"><b>Same result on {scored.length - changed.length} of {scored.length}.</b> {changed.length === 1 ? "One changes:" : `${changed.length} change:`}</p>
                <ul class="ck-list">
                  {changed.map((r) => (
                    <li><span class="m"><b>{r.subject || "(no subject)"}</b><span>{r.from} · yours {r.before!.in ? "In" : "Out"} {pct(r.before!.p)}</span></span>
                      <span class={`move ${r.after!.in ? "in" : "out"}`}>{r.after!.in ? "✓ In" : "✕ Out"} · {pct(r.after!.p)}</span></li>
                  ))}
                </ul>
              </Fragment>
            ))}
        </div>
      )}
      <div class="tp-foot">
        <span class="grow" />
        <button type="button" class="btn-g" onClick={onCancel}>Keep mine</button>
        <button type="button" class="btn-p" disabled={!text} onClick={() => onUse(text)}>Use tidied version</button>
      </div>
    </div>
  );
}
