/**
 * "Tidy up" in the folder editor: opens TidyPanel on whatever is in the rule
 * box right now, and on "Use tidied version" puts the rewrite into the box.
 * Nothing is saved until you press Save. Needs JavaScript; hidden without it.
 */
import { useState } from "preact/hooks";
import TidyPanel from "./TidyPanel";

interface Props { base: string; nameField: string; ruleField: string }

export default function RuleTidy({ base, nameField, ruleField }: Props) {
  const [open, setOpen] = useState<{ name: string; rule: string } | null>(null);
  const [note, setNote] = useState("");
  const box = () => document.getElementById(ruleField) as HTMLTextAreaElement | null;

  if (open) {
    return (
      <TidyPanel
        base={base}
        name={open.name}
        rule={open.rule}
        onCancel={() => setOpen(null)}
        onUse={(text) => {
          const b = box();
          if (b) { b.value = text; b.dispatchEvent(new Event("input", { bubbles: true })); }
          setOpen(null);
          setNote("Tidied. Save to keep it; your old rule stays available to undo after saving.");
        }}
      />
    );
  }
  return (
    <p class="nudge">
      <button type="button" class="small" onClick={() => {
        const rule = box()?.value.trim() ?? "";
        if (!rule) { setNote("Write a rule first."); return; }
        setNote("");
        setOpen({ name: (document.getElementById(nameField) as HTMLInputElement | null)?.value || "This folder", rule });
      }}>Tidy up</button>
      {note || "Rewrites the rule as a readable list. You review it before anything changes."}
    </p>
  );
}
