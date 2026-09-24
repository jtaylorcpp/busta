/**
 * To / Cc / Bcc field. Without JavaScript it is the plain comma-separated
 * text input the send handler reads. Hydrated, each address becomes a
 * removable chip and a hidden input carries the same comma-separated value,
 * so the form posts exactly what it always did.
 *
 * Each new address is checked against this mailbox's bounce list. A match is
 * shown in crimson with a note, and nothing more: sending is still allowed.
 */
import { useEffect, useRef, useState } from "preact/hooks";

interface Props {
  id: string;
  name: string;
  label: string;
  value?: string;
  placeholder?: string;
  hint?: string;
  /** GET endpoint: ?a=<addr>&a=… → { bounced: string[] } */
  checkUrl: string;
  /** Addresses already known to have bounced (server-side check of the prefill). */
  bounced?: string[];
  autofocus?: boolean;
}

const split = (s: string) => s.split(/[,;\s]+/).map((a) => a.trim()).filter(Boolean);
const looksValid = (a: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a);

export default function RecipientInput({ id, name, label, value = "", placeholder, hint, checkUrl, bounced: known = [], autofocus }: Props) {
  const [hydrated, setHydrated] = useState(false);
  const [chips, setChips] = useState<string[]>(() => split(value));
  const [draft, setDraft] = useState("");
  const [bounced, setBounced] = useState<Set<string>>(() => new Set(known.map((a) => a.toLowerCase())));
  const checked = useRef(new Set<string>(known.map((a) => a.toLowerCase())));
  useEffect(() => setHydrated(true), []);

  async function check(addrs: string[]) {
    const fresh = addrs.map((a) => a.toLowerCase()).filter((a) => looksValid(a) && !checked.current.has(a));
    if (!fresh.length) return;
    fresh.forEach((a) => checked.current.add(a));
    try {
      const res = await fetch(`${checkUrl}?${fresh.map((a) => `a=${encodeURIComponent(a)}`).join("&")}`);
      if (!res.ok) return;
      const { bounced: hits } = (await res.json()) as { bounced: string[] };
      if (hits.length) setBounced((s) => new Set([...s, ...hits.map((h) => h.toLowerCase())]));
    } catch {
      // Advisory only; a failed check never gets in the way of writing mail.
    }
  }

  useEffect(() => { if (hydrated) void check(chips); }, [hydrated]);

  function commit(text: string) {
    const add = split(text).filter((a) => !chips.some((c) => c.toLowerCase() === a.toLowerCase()));
    if (add.length) { setChips((c) => [...c, ...add]); void check(add); }
    setDraft("");
  }

  const hintId = `${id}-hint`;
  const flagged = chips.filter((c) => bounced.has(c.toLowerCase()));

  if (!hydrated) {
    return (
      <div class="rcpt">
        <label for={id}>{label}</label>
        <input id={id} name={name} type="text" value={value} placeholder={placeholder} autocomplete="email" aria-describedby={hint ? hintId : undefined} autofocus={autofocus} />
        {hint && <p class="note" id={hintId}>{hint}</p>}
      </div>
    );
  }

  return (
    <div class="rcpt">
      <label for={id}>{label}</label>
      <div class={`box${flagged.length ? " has-bounce" : ""}`} onClick={(e) => (e.currentTarget.querySelector("input") as HTMLInputElement)?.focus()}>
        {chips.map((c) => {
          const bad = bounced.has(c.toLowerCase());
          const invalid = !looksValid(c);
          return (
            <span class={`chip${bad ? " bounced" : ""}${invalid ? " invalid" : ""}`} title={bad ? "Previously bounced" : invalid ? "Doesn't look like an email address" : c}>
              {c}
              <button type="button" aria-label={`Remove ${c}`} onClick={() => setChips((cs) => cs.filter((x) => x !== c))}>×</button>
            </span>
          );
        })}
        <input
          id={id}
          type="text"
          value={draft}
          placeholder={chips.length ? "" : placeholder}
          autocomplete="email"
          aria-describedby={hint || flagged.length ? hintId : undefined}
          autofocus={autofocus}
          onInput={(e) => {
            const v = (e.target as HTMLInputElement).value;
            if (/[,;\s]$/.test(v)) commit(v); else setDraft(v);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && draft.trim()) { e.preventDefault(); commit(draft); }
            if (e.key === "Backspace" && !draft && chips.length) setChips((cs) => cs.slice(0, -1));
          }}
          onBlur={() => draft.trim() && commit(draft)}
        />
      </div>
      <input type="hidden" name={name} value={[...chips, ...split(draft)].join(", ")} />
      {flagged.length > 0 ? (
        <p class="note bounce" id={hintId} role="status">
          {flagged.join(", ")} previously bounced. You can still send, but it may bounce again.
        </p>
      ) : hint ? <p class="note" id={hintId}>{hint}</p> : null}
    </div>
  );
}
