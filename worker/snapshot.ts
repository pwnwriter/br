import type { RefEntry } from "./refs";

export type SnapshotResult = {
  text: string;
  compact: string;
  interactive: RefEntry[];
  all: RefEntry[];
  title: string;
  url: string;
};

const SNAPSHOT_SCRIPT = String.raw`(() => {
  const MAX_ITEMS = 180;
  const MAX_TEXT = 90;
  const seen = new Set();
  const out = [];
  const roleMap = {
    A: "link", BUTTON: "button", INPUT: "textbox", TEXTAREA: "textbox", SELECT: "combobox",
    H1: "heading", H2: "heading", H3: "heading", H4: "heading", H5: "heading", H6: "heading"
  };
  function clean(s) { return String(s || "").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT); }
  function visible(el) {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none" && Number(st.opacity || 1) !== 0;
  }
  function cssPath(el) {
    if (el.id && !/[\s"'<>]/.test(el.id)) return "#" + CSS.escape(el.id);
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && n !== document.body; n = n.parentElement) {
      let part = n.localName;
      if (!part) break;
      const parent = n.parentElement;
      if (parent) {
        const same = [...parent.children].filter(c => c.localName === n.localName);
        if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(n) + 1) + ")";
      }
      parts.unshift(part);
      if (parts.length >= 6) break;
    }
    return parts.length ? parts.join(" > ") : "body";
  }
  function label(el) {
    const aria = clean(el.getAttribute("aria-label"));
    if (aria) return aria;
    if (el.id) {
      const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (l) { const t = clean(l.innerText); if (t) return t; }
    }
    const wrapped = el.closest("label");
    if (wrapped) { const t = clean(wrapped.innerText); if (t) return t; }
    if (el.placeholder) return clean(el.placeholder);
    if (el.alt) return clean(el.alt);
    if (el.title) return clean(el.title);
    return clean(el.innerText || el.value || el.textContent);
  }
  function role(el) {
    const explicit = clean(el.getAttribute("role"));
    if (explicit) return explicit;
    if (el.tagName === "INPUT") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (["submit", "button", "reset"].includes(type)) return "button";
      return "textbox";
    }
    return roleMap[el.tagName] || (el.isContentEditable ? "textbox" : "");
  }
  function interactive(role, el) {
    return ["link","button","textbox","combobox","checkbox","radio","tab","menuitem","switch"].includes(role) || el.isContentEditable;
  }
  function fingerprint(el, r, name) {
    return [r, name, el.tagName, el.id || "", el.getAttribute("name") || "", el.getAttribute("href") || "", el.getAttribute("type") || ""].join("|");
  }
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_ELEMENT);
  let node;
  while ((node = walker.nextNode()) && out.length < MAX_ITEMS) {
    const el = node;
    if (!visible(el)) continue;
    const r = role(el);
    const name = label(el);
    if (!r && (!name || name.length > 70)) continue;
    if (!r && out.length > 40) continue;
    const key = r + "|" + name + "|" + cssPath(el);
    if (seen.has(key)) continue;
    seen.add(key);
    if (!r && name.length < 18) continue;
    const item = {
      selector: cssPath(el),
      role: r || "text",
      name,
      interactive: interactive(r, el),
      fingerprint: fingerprint(el, r || "text", name),
      attrs: {}
    };
    for (const a of ["href","placeholder","type","checked","disabled","value","aria-expanded","aria-selected"]) {
      if (a in el || el.hasAttribute(a)) {
        const v = a in el ? el[a] : el.getAttribute(a);
        if (typeof v === "string" ? v.length < 120 : true) item.attrs[a] = v;
      }
    }
    out.push(item);
  }
  return { title: document.title || "", url: location.href, items: out };
})()`;

export async function snapshot(
  view: any,
  opts: { compact?: boolean; interactive?: boolean },
): Promise<SnapshotResult> {
  const raw = (await view.evaluate(SNAPSHOT_SCRIPT)) as any;
  const all: RefEntry[] = [];
  let n = 1;
  for (const item of raw.items || []) {
    if (item.interactive) {
      all.push({ ref: "@" + n++, ...item });
    }
  }
  const selected = opts.interactive ? all : all;
  const lines = [`page "${escapeText(raw.title || "")}" ${raw.url || ""}`];
  const compactLines = [`${escapeText(raw.title || "")} | ${raw.url || ""}`];
  for (const item of selected) {
    lines.push(formatLine(item, false));
    compactLines.push(formatLine(item, true));
  }
  return {
    text: lines.join("\n") + "\n",
    compact: compactLines.join("\n") + "\n",
    interactive: selected,
    all,
    title: raw.title || "",
    url: raw.url || "",
  };
}

export function formatLine(item: RefEntry, compact: boolean) {
  const name = compact ? escapeBare(item.name) : `"${escapeText(item.name)}"`;
  const bits = [`${item.ref} ${item.role} ${name}`];
  if (!compact) {
    for (const [k, v] of Object.entries(item.attrs || {})) {
      if (v === "" || v == null) continue;
      bits.push(
        `${k}=${typeof v === "string" ? `"${escapeText(v)}"` : String(v)}`,
      );
    }
  }
  return bits.join(" ");
}

function escapeText(s: string) {
  return String(s)
    .replace(/\x1b/g, "?")
    .replace(/"/g, '\\"')
    .replace(/\s+/g, " ")
    .trim();
}

function escapeBare(s: string) {
  return escapeText(s).replace(/\s+/g, " ");
}
