/**
 * "Test this rule": runs the rule being edited against the 5 newest received
 * messages (or built-in sample mail, marked Sample, when the mailbox has
 * almost none) and shows ✓ In / ✕ Out with the model's probability. Reads the
 * name and rule straight from the form fields, so it tests what you typed,
 * not what was saved. Needs JavaScript; the form works without it.
 */
import { useState } from "preact/hooks";

interface Props { endpoint: string; nameField: string; ruleField: string }
type Row = { id: string; from: string; subject: string; in?: boolean; p?: number; error?: string };

export default function RuleTester({ endpoint, nameField, ruleField }: Props) {
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [rows, setRows] = useState<Row[]>([]);
  const [message, setMessage] = useState("");
  const [sample, setSample] = useState(false);

  async function run() {
    const name = (document.getElementById(nameField) as HTMLInputElement | null)?.value ?? "";
    const rule = (document.getElementById(ruleField) as HTMLTextAreaElement | null)?.value ?? "";
    setState("loading");
    setMessage("");
    try {
      const res = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, rule }) });
      const data = (await res.json()) as { results?: Row[]; sample?: boolean; error?: string };
      if (!res.ok || !data.results) throw new Error(data.error ?? `HTTP ${res.status}`);
      setRows(data.results);
      setSample(!!data.sample);
      setState("done");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
      setState("error");
    }
  }

  const pct = (p?: number) => (typeof p === "number" ? `${Math.round(p * 100)}%` : "");
  const matched = rows.filter((r) => r.in).length;

  return (
    <div class="tester">
      <div class="bar">
        <button type="button" onClick={run} disabled={state === "loading"}>{state === "loading" ? "Testing…" : state === "done" ? "Test again" : "Test this rule"}</button>
        {state === "done" && rows.length > 0
          ? <span class="hint"><b>{matched} of {rows.length}</b> would go in.{sample && <span class="sample">Sample mail</span>}</span>
          : <span class="hint">Runs it on your newest mail. Nothing is filed.</span>}
      </div>
      {state === "done" && sample && <p class="hint">Your mailbox is new, so this test uses examples. Once you have mail, it tests yours.</p>}
      {state === "loading" && (
        <ul class="rows">{[0, 1, 2, 3, 4].map(() => <li class="skeleton"><span /><span /></li>)}</ul>
      )}
      {state === "error" && <p class="err" role="alert">Couldn't test the rule: {message}</p>}
      {state === "done" && (
        <ul class="rows">
          {rows.map((r) => (
            <li>
              <span class="who"><b>{r.from}</b><span>{r.subject}</span></span>
              {r.error ? <span class="verdict fail" title={r.error}>Couldn't check</span>
                : r.in ? <span class="verdict in">✓ In · {pct(r.p)}</span>
                : <span class="verdict out">✕ Out · {pct(r.p)}</span>}
            </li>
          ))}
          {rows.length === 0 && <li class="empty">No received mail to test against yet.</li>}
        </ul>
      )}
    </div>
  );
}
