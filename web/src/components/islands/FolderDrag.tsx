/**
 * Drag folders into order (designs/2026-09-25-folder-order): on the Folders
 * page and in the sidebar. Any element marked `data-folder-order="<POST url>"`
 * whose children carry `data-name` becomes sortable: drag a row, or focus it
 * and press Alt+↑ / Alt+↓. The new order is saved on drop (JSON {names}).
 *
 * Listens on the document, so it keeps working when the live refresh swaps
 * the sidebar's markup. Renders nothing; without JavaScript the Folders
 * page's arrows still work.
 */
import { useEffect } from "preact/hooks";

declare global { interface Window { __bustaFolderDrag?: boolean } }

function rows(list: Element): HTMLElement[] {
  return [...list.children].filter((c): c is HTMLElement => c instanceof HTMLElement && !!c.dataset.name);
}

/** After a reorder: renumber, fix the first/last arrows, and save. */
async function commit(list: HTMLElement) {
  const items = rows(list);
  items.forEach((el, i) => {
    const rank = el.querySelector("[data-rank]");
    if (rank) rank.textContent = String(i + 1);
    el.querySelector<HTMLButtonElement>("[data-up]")?.toggleAttribute("disabled", i === 0);
    el.querySelector<HTMLButtonElement>("[data-down]")?.toggleAttribute("disabled", i === items.length - 1);
  });
  list.setAttribute("aria-busy", "true");
  try {
    const res = await fetch(list.dataset.folderOrder!, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ names: items.map((el) => el.dataset.name) }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch {
    location.reload(); // show the order the server actually has
  } finally {
    list.removeAttribute("aria-busy");
  }
}

export default function FolderDrag() {
  useEffect(() => {
    if (window.__bustaFolderDrag) return;
    window.__bustaFolderDrag = true;
    let dragged: HTMLElement | null = null;
    const rowOf = (t: EventTarget | null) => (t instanceof Element ? t.closest<HTMLElement>("[data-folder-order] > [data-name]") : null);
    const clear = () => document.querySelectorAll(".drop-before, .drop-after").forEach((el) => el.classList.remove("drop-before", "drop-after"));

    document.addEventListener("dragstart", (e) => {
      const row = rowOf(e.target);
      if (!row) return;
      dragged = row;
      row.classList.add("dragging");
      e.dataTransfer?.setData("text/plain", row.dataset.name!);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    });
    document.addEventListener("dragover", (e) => {
      const row = rowOf(e.target);
      if (!dragged || !row || row === dragged || row.parentElement !== dragged.parentElement) return;
      e.preventDefault();
      const after = e.clientY > row.getBoundingClientRect().top + row.offsetHeight / 2;
      clear();
      row.classList.add(after ? "drop-after" : "drop-before");
    });
    document.addEventListener("drop", (e) => {
      const row = rowOf(e.target);
      if (!dragged || !row || row === dragged || row.parentElement !== dragged.parentElement) return;
      e.preventDefault();
      const after = row.classList.contains("drop-after");
      clear();
      row.parentElement!.insertBefore(dragged, after ? row.nextSibling : row);
      void commit(row.parentElement as HTMLElement);
    });
    document.addEventListener("dragend", () => {
      dragged?.classList.remove("dragging");
      dragged = null;
      clear();
    });
    document.addEventListener("keydown", (e) => {
      if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
      const row = rowOf(document.activeElement);
      if (!row) return;
      const sib = e.key === "ArrowUp" ? row.previousElementSibling : row.nextElementSibling?.nextElementSibling ?? null;
      if (e.key === "ArrowUp" && !sib) return;
      if (e.key === "ArrowDown" && !row.nextElementSibling) return;
      e.preventDefault();
      row.parentElement!.insertBefore(row, sib);
      (row.matches("[tabindex]") ? row : row.querySelector<HTMLElement>("a, [tabindex]"))?.focus();
      void commit(row.parentElement as HTMLElement);
    });
  }, []);
  return null;
}
