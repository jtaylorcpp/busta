/**
 * "Why not this folder?" on the thread page (designs/2026-09-24-why-not-folder).
 *
 *   why   the folder's score against the 75% line, the rule's closest
 *         sentences with the reason each missed, and the email with the
 *         words that mattered highlighted
 *   fix   keywords + a sentence to add (editable), a before/after check on
 *         this message and your recent mail, optional Tidy up, then save
 *
 * The explanation is fetched when the panel opens (POST /<id>/why); saving
 * is a plain form post to /<id>/why/save, which re-files this message.
 * Styles live in styles/why.css.
 */
import { Fragment } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import TidyPanel, { pct, postJson, type CompareRow } from "./TidyPanel";

interface Explanation {
  summary: string;
  closest: { index: number; verdict: "match" | "near" | "no"; reason: string }[];
  others: string;
  evidence: string[];
  keywords: { text: string; source: "email" | "rule" | "sender" }[];
  suggestion: string;
}
interface WhyData {
  folder: { id: string; name: string; rule: string; sentences: string[] };
  score: number;
  none: number | null;
  threshold: number;
  filedHere: boolean;
  explanation: Explanation;
  email: { from: string; subject: string; text: string };
}

interface Props {
  /** /mb/<address> */
  base: string;
  messageId: string;
  folderId: string;
  /** Where Close goes: the thread without ?why. */
  closeHref: string;
}

/** Split text around the phrases so they can be wrapped in <mark>. */
function highlight(text: string, phrases: string[]) {
  const ps = phrases.filter(Boolean).sort((a, b) => b.length - a.length);
  if (ps.length === 0) return [text];
  const re = new RegExp(`(${ps.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  return text.split(re).map((part, i) => (i % 2 === 1 ? <mark class="kw">{part}</mark> : part));
}

function Meter({ name, before, after, none, threshold }: { name: string; before: number; after?: number; none: number | null; threshold: number }) {
  return (
    <div class="meter">
      <div class="line">
        {after !== undefined && <span class={`fill after${after >= threshold ? " ok" : ""}`} style={{ width: `${Math.round(after * 100)}%` }} />}
        <span class="fill" style={{ width: `${Math.round(before * 100)}%` }} />
        <span class="tick" style={{ left: `${Math.round(threshold * 100)}%` }} title={`Files at ${pct(threshold)}`} />
      </div>
      <div class="labels">
        <span>{name} <b>{pct(before)}{after !== undefined && ` → ${pct(after)}`}</b>{after === undefined && none !== null && <Fragment> · No folder <b>{pct(none)}</b></Fragment>}</span>
        <span>Files at <b>{pct(threshold)}</b></span>
      </div>
    </div>
  );
}

export default function WhyNot({ base, messageId, folderId, closeHref }: Props) {
  const [data, setData] = useState<WhyData | null>(null);
  const [err, setErr] = useState("");
  const [view, setView] = useState<"why" | "fix" | "tidy">("why");
  const [sentence, setSentence] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [tidied, setTidied] = useState<string | null>(null);
  const [rows, setRows] = useState<CompareRow[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkErr, setCheckErr] = useState("");

  async function load(fresh = false) {
    setErr("");
    setData(null);
    try {
      const d = await postJson<WhyData>(`${base}/${messageId}/why`, { folderId, fresh });
      setData(d);
      setSentence(d.explanation.suggestion);
      setPicked([]);
    } catch (e) {
      setErr((e as Error).message);
    }
  }
  useEffect(() => { void load(); }, []);

  // The rule as it would be saved: yours plus the addition, or the tidied version.
  const addition = useMemo(() => {
    const extra = picked.filter((k) => !sentence.toLowerCase().includes(k.toLowerCase()));
    return [sentence.trim(), extra.length ? `Also: ${extra.join("; ")}.` : ""].filter(Boolean).join(" ");
  }, [sentence, picked]);
  const newRule = tidied ?? (data ? `${data.folder.rule.trim()}${data.folder.rule.includes("\n") ? "\n" : " "}${addition}`.trim() : "");

  async function check() {
    if (!data) return;
    setChecking(true);
    setCheckErr("");
    setRows(null);
    try {
      const r = await postJson<{ results: CompareRow[] }>(`${base}/folders/compare`, { name: data.folder.name, before: data.folder.rule, after: newRule, include: messageId });
      setRows(r.results);
    } catch (e) {
      setCheckErr((e as Error).message);
    } finally {
      setChecking(false);
    }
  }
  // A check is only true for the rule it ran on.
  useEffect(() => { setRows(null); }, [newRule]);

  if (err) {
    return (
      <div class="why-panel">
        <div class="why-head"><h3>Why not?</h3><a class="linkish" href={closeHref}>Close</a></div>
        <p class="err pad" role="alert">{err} <button type="button" class="linkish" onClick={() => void load()}>Try again</button></p>
      </div>
    );
  }
  if (!data) {
    return (
      <div class="why-panel" aria-busy="true">
        <div class="why-head"><h3>Working out why…</h3><a class="linkish" href={closeHref}>Close</a></div>
        <div class="pad skeleton"><span /><span /><span /></div>
      </div>
    );
  }

  const { folder, explanation: x, email } = data;
  const near = new Set(x.closest.filter((c) => c.verdict !== "match").map((c) => c.index));
  const senderMatters = x.keywords.some((k) => k.source === "sender");
  const self = rows?.find((r) => r.this);
  const others = rows?.filter((r) => !r.this && !r.error) ?? [];
  const newlyIn = others.filter((r) => r.changed && r.after?.in);
  const newlyOut = others.filter((r) => r.changed && !r.after?.in);
  const sentenceCount = folder.sentences.length + (addition ? 1 : 0);
  const justFile = (
    <form method="post" action={`${base}/${messageId}/folder`}>
      <input type="hidden" name="folder" value={folder.id} />
      <button type="submit" class="btn-s">Just file this one</button>
    </form>
  );

  if (view === "tidy") {
    return (
      <div class="why-panel">
        <TidyPanel base={base} name={folder.name} rule={newRule} onCancel={() => setView("fix")} onUse={(t) => { setTidied(t); setView("fix"); }} />
      </div>
    );
  }

  if (view === "why") {
    return (
      <div class="why-panel">
        <div class="why-head">
          <h3>{data.filedHere ? `Why this is in ${folder.name}` : `Why this isn't in ${folder.name}`} <span>· Busta's read of it</span></h3>
          <a class="linkish" href={closeHref}>Close</a>
        </div>
        <Meter name={folder.name} before={data.score} none={data.none} threshold={data.threshold} />
        {x.summary && <p class="summary">{x.summary}</p>}
        <div class="why-body">
          <section>
            <p class="h4">Closest parts of your rule</p>
            <ul class="reasons">
              {x.closest.map((c) => (
                <li class="reason">
                  <span class={`v ${c.verdict}`} aria-label={c.verdict === "near" ? "Nearly fits" : c.verdict === "match" ? "Fits" : "Doesn't fit"}>{c.verdict === "near" ? "~" : c.verdict === "match" ? "✓" : "✕"}</span>
                  <span><q>{folder.sentences[c.index]}</q><p>{c.reason}</p></span>
                </li>
              ))}
            </ul>
            {x.others && <p class="fine">{x.others}</p>}
          </section>
          <section>
            <p class="h4">What it looked at</p>
            <div class="mail">
              <div class="hdr">
                <span>From {senderMatters ? <mark class="me">{email.from}</mark> : <b>{email.from}</b>}</span>
                <span>Subject <b>{highlight(email.subject || "(no subject)", x.evidence)}</b></span>
              </div>
              <div class="txt">{highlight(email.text || "(no text)", x.evidence)}</div>
            </div>
            <p class="h4">Your {folder.name} rule</p>
            <p class="rule-full">{folder.sentences.map((s, i) => <Fragment><span class={near.has(i) ? "s near" : "s"}>{s}</span>{" "}</Fragment>)}</p>
          </section>
        </div>
        <div class="why-foot">
          <span class="fine">The score is from the model that files your mail. The reasons are a second model's reading of the same email. <button type="button" class="linkish" onClick={() => void load(true)}>Ask again</button></span>
          <span class="grow" />
          {!data.filedHere && justFile}
          <button type="button" class="btn-p" onClick={() => setView("fix")}>+ Add keywords to {folder.name}</button>
        </div>
      </div>
    );
  }

  // view === "fix"
  return (
    <form class="why-panel" method="post" action={`${base}/${messageId}/why/save`}>
      <input type="hidden" name="folder" value={folder.id} />
      <input type="hidden" name="rule" value={newRule} />
      <div class="why-head"><h3>Add to {folder.name}</h3><button type="button" class="linkish" onClick={() => setView("why")}>← Why</button></div>
      <Meter name={folder.name} before={data.score} after={self?.after?.p} none={data.none} threshold={data.threshold} />
      <div class="why-body">
        <section>
          {tidied ? (
            <Fragment>
              <p class="h4">Your rule after, tidied</p>
              <pre class="rule-tidied">{tidied}</pre>
              <p class="fine"><button type="button" class="linkish" onClick={() => setTidied(null)}>Undo tidy</button> to go back to adding a sentence.</p>
            </Fragment>
          ) : (
            <Fragment>
              {x.keywords.length > 0 && (
                <Fragment>
                  <p class="h4">Keywords</p>
                  <div class="kws">
                    {x.keywords.map((k) => {
                      const inSentence = sentence.toLowerCase().includes(k.text.toLowerCase());
                      const on = inSentence || picked.includes(k.text);
                      return (
                        <button type="button" class={on ? "kwc on" : "kwc"} aria-pressed={on} disabled={inSentence}
                          title={inSentence ? "Already in the sentence" : on ? "Remove" : "Add"}
                          onClick={() => setPicked(on ? picked.filter((p) => p !== k.text) : [...picked, k.text])}>
                          {on ? "✓" : "+"} {k.text}<span class="src">{k.source === "sender" ? "from you" : k.source}</span>
                        </button>
                      );
                    })}
                  </div>
                </Fragment>
              )}
              <label class="h4" for="why-sentence">Sentence to add</label>
              <textarea id="why-sentence" class="addition" rows={3} value={sentence} onInput={(e) => setSentence((e.target as HTMLTextAreaElement).value)} />
              <p class="fine">Edit it however you like. Keywords that aren't in the sentence are added after it.</p>
              <p class="h4">Your rule after</p>
              <p class="rule-preview">{folder.rule} <ins>{addition}</ins></p>
              {sentenceCount >= 6 && (
                <p class="nudge">Your rule is {sentenceCount} sentences now. <button type="button" class="small" onClick={() => setView("tidy")}>Tidy it up</button></p>
              )}
            </Fragment>
          )}
        </section>
        <section>
          <div class="cb-head"><b>Check it</b><span class="fine">this message + your recent mail</span><span class="grow" />
            <button type="button" class="small" onClick={() => void check()} disabled={checking}>{checking ? "Checking…" : rows ? "Check again" : "Check it"}</button></div>
          {!rows && !checking && <p class="fine">Scores this message and your newest mail with the old and new rule. Nothing is filed.</p>}
          {checking && <p class="loading"><i class="spin" aria-hidden="true" />Scoring with both rules…</p>}
          {checkErr && <p class="err" role="alert">Couldn't check: {checkErr}</p>}
          {rows && (
            <ul class="ck-list">
              {self && !self.error && (
                <li class="this"><span class="m"><b>{self.subject || "(no subject)"}</b><span>{self.from} · this message</span></span>
                  <span class={`move ${self.after!.in ? "in" : "out"}`}><s>{pct(self.before!.p)}</s> {self.after!.in ? "✓ In" : "✕ Out"} · {pct(self.after!.p)}</span></li>
              )}
              {[...newlyIn, ...newlyOut].map((r) => (
                <li><span class="m"><b>{r.subject || "(no subject)"}</b><span>{r.from}</span></span>
                  <span class={`move ${r.after!.in ? "in" : "out"}`}><s>{pct(r.before!.p)}</s> {r.after!.in ? "✓ In" : "✕ Out"} · {pct(r.after!.p)}</span></li>
              ))}
            </ul>
          )}
          {rows && newlyIn.length === 0 && newlyOut.length === 0 && <p class="same">✓ None of your other {others.length} recent messages change.</p>}
          {newlyIn.length > 0 && (
            <p class="warnline"><b>{newlyIn.length === 1 ? "1 other message" : `${newlyIn.length} other messages`} would also go in.</b> If that's more than you meant, remove a keyword or narrow the sentence.</p>
          )}
          {newlyOut.length > 0 && <p class="warnline"><b>{newlyOut.length} would come out</b> of {folder.name} with the new rule.</p>}
        </section>
      </div>
      <div class="why-foot">
        <button type="button" class="btn-g" onClick={() => setView("why")}>Cancel</button>
        <span class="grow" />
        {!data.filedHere && (
          <button type="submit" class="btn-s" formAction={`${base}/${messageId}/folder`} name="folder" value={folder.id}>Just file this one</button>
        )}
        <button type="submit" class="btn-p" disabled={!newRule.trim() || newRule.trim() === folder.rule.trim()}>✓ Add to rule and re-sort</button>
      </div>
    </form>
  );
}
