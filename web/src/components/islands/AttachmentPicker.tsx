/**
 * "Attach files". The real <input type="file" name="files"> is what gets
 * submitted; this only shows what's in it. Hydrated, picked files appear as
 * chips with their size, can be removed one by one, and anything over the
 * inline limit is marked as going out as an expiring download link.
 */
import { useEffect, useRef, useState } from "preact/hooks";

interface Props { inlineBytes: number; linkDays: number }

const size = (b: number) => (b < 1024 ? `${b} B` : b < 1048576 ? `${Math.round(b / 1024)} KB` : `${(b / 1048576).toFixed(1)} MB`);

export default function AttachmentPicker({ inlineBytes, linkDays }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

  const sync = () => setFiles(Array.from(input.current?.files ?? []));
  function remove(i: number) {
    const dt = new DataTransfer();
    files.forEach((f, j) => j !== i && dt.items.add(f));
    if (input.current) input.current.files = dt.files;
    sync();
  }

  return (
    <div class="picker">
      <label class="attach">
        <input ref={input} type="file" name="files" multiple class={hydrated ? "visually-hidden" : ""} onChange={sync} />
        {hydrated && (
          <span class="lbl">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M16.5 7.5l-7.8 7.8a2 2 0 102.8 2.8l8-8a4 4 0 10-5.7-5.7l-8 8a6 6 0 108.5 8.5l6.2-6.2" /></svg>
            Attach files
          </span>
        )}
      </label>
      {files.map((f, i) => (
        <span class="file">
          <span class="fn">{f.name}</span>
          <span class="sz">{size(f.size)}</span>
          {f.size > inlineBytes && <span class="link-badge" title={`Over ${size(inlineBytes)}: sent as a download link`}>link · {linkDays} days</span>}
          <button type="button" aria-label={`Remove ${f.name}`} onClick={() => remove(i)}>×</button>
        </span>
      ))}
    </div>
  );
}
