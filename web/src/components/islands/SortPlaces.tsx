/**
 * "Sort mail I already have when I save", with Where to look: Messages and
 * each folder, as checkboxes named `look` ("messages" or a folder id), plus
 * the window (days, limit). After "Test this rule" (the RuleTester island's
 * `busta:rule-tested` events) each place shows how many of its emails would
 * go in, or for the folder being edited, would leave it.
 *
 * A finished test is posted with the form as `tested`, so saving files what
 * the test found without asking the model again; editing the rule or the
 * window drops it. Server-rendered as plain inputs, so the form works
 * without JavaScript.
 */
import { useEffect, useState } from "preact/hooks";
import type { RuleTestedDetail } from "./RuleTester";

interface Place { key: string; name: string; total: number }
interface Props {
  places: Place[];
  /** Checked at first: Messages, plus the edited folder. */
  checked: string[];
  folderId?: string;
  ruleField: string;
  days: number;
  limit: number;
}

export default function SortPlaces({ places, checked, folderId, ruleField, days, limit }: Props) {
  const [on, setOn] = useState(true);
  const [picked, setPicked] = useState<Set<string>>(new Set(checked));
  const [test, setTest] = useState<RuleTestedDetail | null>(null);

  useEffect(() => {
    const onTested = (e: Event) => setTest((e as CustomEvent<RuleTestedDetail>).detail);
    window.addEventListener("busta:rule-tested", onTested);
    // A change to the rule or the window makes the counts stale.
    const stale = () => setTest(null);
    const watched = [ruleField, "sort-days", "sort-limit"].map((id) => document.getElementById(id)).filter(Boolean) as HTMLElement[];
    for (const el of watched) el.addEventListener("input", stale);
    return () => {
      window.removeEventListener("busta:rule-tested", onTested);
      for (const el of watched) el.removeEventListener("input", stale);
    };
  }, [ruleField]);

  // A test whose every check failed says nothing about where mail would go.
  const live = test && !test.sample && test.rows.some((r) => !r.error) ? test : null;
  const count = (key: string) => {
    if (!live) return null;
    const here = live.rows.filter((r) => (r.place ?? "messages") === key);
    const n = key === folderId ? here.filter((r) => !r.in && !r.error).length : here.filter((r) => r.in).length;
    return { n, of: here.length };
  };
  const toggle = (key: string) => {
    const next = new Set(picked);
    next.has(key) ? next.delete(key) : next.add(key);
    setPicked(next);
  };
  const moving = live?.done ? places.filter((p) => picked.has(p.key) && p.key !== folderId).reduce((n, p) => n + (count(p.key)?.n ?? 0), 0) : null;
  const leaving = live?.done && folderId && picked.has(folderId) ? count(folderId)?.n ?? 0 : null;
  const summary = [moving ? `${moving} will move here` : null, leaving ? `${leaving} will leave` : null].filter(Boolean).join(" · ");
  const tested = live?.done
    ? JSON.stringify({
        rule: live.rule, days: live.days, limit: live.limit,
        in: Object.fromEntries(live.rows.filter((r) => r.in).map((r) => [r.id, r.p ?? 1])),
        out: live.rows.filter((r) => !r.in && !r.error).map((r) => r.id),
      })
    : "";

  return (
    <fieldset class="sort-places">
      <label class="switch">
        <input type="checkbox" name="apply" value="1" checked={on} onChange={(e) => setOn((e.target as HTMLInputElement).checked)} />
        <span>Sort mail I already have when I save</span>
        {summary && <span class="tot">{summary}</span>}
      </label>
      <div class="where" hidden={!on}>
        <span class="lbl" id="sort-where">Where to look</span>
        <div class="places" role="group" aria-labelledby="sort-where">
          {places.map((p) => {
            const c = count(p.key);
            const verb = p.key === folderId ? "would leave" : "would go in";
            return (
              <label class="place">
                <input type="checkbox" name="look" value={p.key} checked={picked.has(p.key)} onChange={() => toggle(p.key)} />
                <span class="pn">{p.name}</span>
                <span class="c">{c ? c.of : p.total}</span>
                {c && (live!.done || c.n > 0)
                  ? <span class={`tag${c.n === 0 ? " zero" : ""}`}>{c.n}{live!.done ? "" : "+"} {verb}</span>
                  : live && !live.done ? <span class="c">· counting…</span> : null}
              </label>
            );
          })}
        </div>
        <div class="win">
          From the last <input id="sort-days" name="days" type="number" min="1" max="365" defaultValue={String(days)} aria-label="Days" /> days,
          up to <input id="sort-limit" name="limit" type="number" min="1" max="500" defaultValue={String(limit)} aria-label="Emails" /> emails in all.
        </div>
        <p class="hint">
          {folderId && picked.has(folderId)
            ? "This folder is checked because you're changing its rule: mail that no longer fits leaves it, for another folder or Messages. "
            : "Checked places are sorted when you save. An email in a checked folder moves only if it would go in this one. "}
          Mail you filed by hand never moves.{!live && places.length > 1 ? " Test the rule to see how many would go in from each." : ""}
        </p>
      </div>
      <input type="hidden" name="tested" value={tested} />
    </fieldset>
  );
}
