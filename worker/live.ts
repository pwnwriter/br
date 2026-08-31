import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  DEFAULT_URL,
  ESC,
  describeBytes,
  parseMouseEvents,
  toUrl,
} from "./live/input";
import { renderFrame } from "./live/render";
import type { MouseInput, PromptAction, Tab } from "./live/types";

// argv after the script: [url?] and/or [--refresh <ms>]. Refresh is opt-in:
// 0 means event-driven (redraw only on input/navigation) — best for browsing.
// A positive value continuously re-renders every <ms> so motion (video,
// animations) updates instead of freezing. Floored to keep the CPU sane.
let startUrl = DEFAULT_URL;
let refreshMs = 0;
let recordPath = "";
let appendRecord = false;
let recordPane = false;
const recordLog: string[] = [];
{
  const rest = Bun.argv.slice(2);
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a === "--refresh") {
      const v = parseInt(rest[++i] ?? "", 10);
      if (Number.isFinite(v) && v > 0) refreshMs = Math.max(30, v);
    } else if (a === "--record" || a === "--append-record") {
      recordPath = rest[++i] ?? "";
      if (!recordPath || recordPath.startsWith("--")) {
        console.error(`${a} requires a path`);
        process.exit(2);
      }
      appendRecord = a === "--append-record";
    } else if (a === "--pane" || a === "--split") {
      recordPane = true;
    } else if (!a.startsWith("--")) {
      startUrl = a;
    }
  }
}
if (recordPath) {
  mkdirSync(dirname(recordPath), { recursive: true });
  if (!appendRecord) writeFileSync(recordPath, "");
}

// A real (screenshot-able) start page: a WebView left at about:blank cannot be
// captured, so an empty `br live` would otherwise render nothing.
const START_PAGE =
  "data:text/html," +
  encodeURIComponent(
    `<!doctype html><meta charset="utf8"><body style="margin:0;height:100vh;display:grid;place-items:center;background:#0b0f17;color:#8695a8;font:16px ui-monospace,SFMono-Regular,Menlo,monospace"><div>br &middot; press <b style="color:#2dd4bf">o</b> to open a URL &middot; <b style="color:#2dd4bf">t</b> new tab &middot; <b style="color:#2dd4bf">q</b> quit</div></body>`,
  );

let tabs: Tab[] = [];
let active = 0;
let width = Math.max(640, (process.stdout.columns || 100) * 10);
let height = Math.max(360, ((process.stdout.rows || 30) - 2) * 20);
let rendering = false;
let needsRender = false;
let commandMode = false;
// Normal: single keys are app shortcuts. Insert: every key goes to the page,
// so you can type into a focused search box (t/q/j no longer hijacked). Esc
// leaves insert; clicking into a text field auto-enters it.
let mode: "normal" | "insert" = "normal";
let commandBuffer = "";
let promptAction: PromptAction = "command";
let status = "";
let debugInput = false;
let viewLock: Promise<unknown> = Promise.resolve();

// Bun.WebView is not reentrant: letting a screenshot overlap a navigate throws
// a native "unknown error". Funnel every view call through one queue so they
// run strictly one at a time.
function locked<T>(fn: () => T | Promise<T>): Promise<T> {
  const run = viewLock.then(fn, fn);
  viewLock = run.then(
    () => {},
    () => {},
  );
  return run;
}

if (!(Bun as any).WebView) {
  console.error(
    "Bun.WebView is unavailable. br live requires Bun 1.4+ with WebView support.",
  );
  process.exit(10);
}

// Keep a transient WebView error from tearing down the session; show it and
// carry on rendering.
process.on("uncaughtException", onError);
process.on("unhandledRejection", onError);
function onError(err: any) {
  setStatus("error: " + (err?.message ?? err));
}

setupTerminal();

// Attach input before the first paint so the session stays interactive even if
// the initial render fails (e.g. screenshotting a page that has not painted).
process.stdin.on("data", (chunk) => {
  void handleInput(Buffer.from(chunk).toString("utf8"));
});

await newTab(startUrl);
scheduleRender();

// Opt-in continuous refresh: keep re-rendering so video/animations update.
// scheduleRender() already coalesces, so a fast tick never stacks work.
if (refreshMs > 0) setInterval(scheduleRender, refreshMs);

process.stdout.on("resize", () => {
  width = Math.max(640, (process.stdout.columns || 100) * 10);
  height = Math.max(360, ((process.stdout.rows || 30) - 2) * 20);
  for (const tab of tabs)
    locked(() => tab.view.resize(width, height)).catch(() => {});
  scheduleRender();
});

function setupTerminal() {
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  process.stdout.write(
    `${ESC}[?1049h${ESC}[?25l${ESC}[?1000h${ESC}[?1006h${ESC}[2J`,
  );
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("exit", restoreTerminal);
}

function restoreTerminal() {
  process.stdout.write(
    `${ESC}[?1015l${ESC}[?1006l${ESC}[?1005l${ESC}[?1003l${ESC}[?1002l${ESC}[?1000l${ESC}[?25h${ESC}[?1049l`,
  );
  process.stdin.setRawMode?.(false);
}

function shutdown() {
  for (const tab of tabs) {
    try {
      tab.view.close();
    } catch {}
  }
  restoreTerminal();
  process.exit(0);
}

async function newTab(url: string) {
  const view = new (Bun as any).WebView({ width, height });
  const tab: Tab = { view, url: "", title: "" };
  view.onNavigated = (u: string, title: string) => {
    if (u.startsWith("data:")) return; // start page stays shown as a blank tab
    tab.url = u;
    tab.title = title;
    scheduleRender();
  };
  tabs.push(tab);
  active = tabs.length - 1;
  if (url && url !== DEFAULT_URL) {
    await navigate(url);
  } else {
    await locked(() => view.navigate(START_PAGE)).catch(() => {});
    scheduleRender();
    setTimeout(scheduleRender, 250);
  }
}

async function navigate(url: string) {
  const tab = tabs[active];
  mode = "normal"; // a fresh page starts without a focused field
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) url = "https://" + url;
  const requestedUrl = url;
  await locked(async () => {
    await tab.view.navigate(url);
    tab.url = tab.view.url;
    tab.title = tab.view.title;
  }).catch((err) => setStatus(`navigation failed: ${err?.message ?? err}`));
  recordAction({ command: "open", url: tab.url || requestedUrl });
  // Re-render once now and again shortly: navigate can resolve before the page
  // has painted, so the first frame may still be blank.
  scheduleRender();
  setTimeout(scheduleRender, 250);
}

async function handleInput(input: string) {
  if (commandMode) {
    for (const ch of input) {
      if (ch === "\r" || ch === "\n") {
        const value = commandBuffer.trim();
        const action = promptAction;
        commandMode = false;
        commandBuffer = "";
        promptAction = "command";
        if (action === "tab") await openPromptedTab(value);
        else if (action === "open") await openPromptedUrl(value);
        else await runCommand(value);
      } else if (ch === "\x7f") {
        commandBuffer = commandBuffer.slice(0, -1);
      } else if (ch === "\x1b") {
        commandMode = false;
        commandBuffer = "";
      } else if (ch >= " ") {
        commandBuffer += ch;
      }
    }
    scheduleRender();
    return;
  }

  const parsedMouse = parseMouseEvents(input);
  const mouseEvents = parsedMouse.events;
  if (mouseEvents.length > 0) {
    for (const mouse of mouseEvents) await handleMouse(mouse);
    input = parsedMouse.rest;
    if (input.length === 0) return;
  }
  if (debugInput) setStatus("input " + describeBytes(input));

  // Insert mode: forward every key to the page. Only Esc (or Ctrl-C) escapes
  // back to Normal, so page inputs get t/q/space/etc. verbatim.
  if (mode === "insert") {
    if (input === "\x1b" || input === "\x03") {
      mode = "normal";
      setStatus("");
      scheduleRender();
      return;
    }
    await handleInsertKey(input);
    scheduleRender();
    return;
  }

  // Normal mode: single keys are app shortcuts.
  if (input === "i") {
    mode = "insert";
    scheduleRender();
    return;
  }
  if (input === "a") {
    await answerPage();
    return;
  }
  if (input === "q" || input === "\x03") shutdown();
  if (input === ":") {
    startPrompt("command", "");
    scheduleRender();
    return;
  }
  if (input === "t") {
    startPrompt("tab", "");
    scheduleRender();
    return;
  }
  if (input === "o" || input === "g") {
    startPrompt(
      "open",
      tabs[active].url && tabs[active].url !== DEFAULT_URL
        ? tabs[active].url
        : "",
    );
    scheduleRender();
    return;
  }
  if (input === "x" && tabs.length > 1) {
    const dead = tabs[active];
    tabs.splice(active, 1);
    active = Math.max(0, active - 1);
    locked(() => dead.view.close()).catch(() => {});
    scheduleRender();
    return;
  }
  if (input === "\t") {
    active = (active + 1) % tabs.length;
    scheduleRender();
    return;
  }
  if (input === "\x1b[Z") {
    active = (active + tabs.length - 1) % tabs.length;
    scheduleRender();
    return;
  }
  if (input === "\x1b[A") await press("ArrowUp");
  else if (input === "\x1b[B") await press("ArrowDown");
  else if (input === "\x1b[C") await press("ArrowRight");
  else if (input === "\x1b[D") await press("ArrowLeft");
  else if (input === "\x1b[5~") await scrollPage(-height * 0.85);
  else if (input === "\x1b[6~") await scrollPage(height * 0.85);
  else if (input === "j") await scrollPage(240);
  else if (input === "k") await scrollPage(-240);
  else if (input === " ") await scrollPage(height * 0.85);
  else if (input === "\r") await press("Enter");
  else if (input === "\x1b") await press("Escape");
  else if (input === "\x7f") await press("Backspace");
  // Unbound printable keys do nothing in Normal mode — press `i` to type.
  scheduleRender();
}

// Insert mode: translate the keystroke to a page action. Arrows/Enter/etc. go
// through as key presses; everything printable is typed into the focused input.
async function handleInsertKey(input: string) {
  if (input === "\x1b[A") return press("ArrowUp");
  if (input === "\x1b[B") return press("ArrowDown");
  if (input === "\x1b[C") return press("ArrowRight");
  if (input === "\x1b[D") return press("ArrowLeft");
  if (input === "\r" || input === "\n") return press("Enter");
  if (input === "\x7f") return press("Backspace");
  if (input === "\t") return press("Tab");
  if (input >= " ") {
    const meta = await activeElement();
    await locked(() => tabs[active].view.type(input)).catch(() => {});
    recordAction({ command: "type", text: input, target: meta?.selector });
  }
}

async function runCommand(command: string) {
  if (!command) return;
  const [name, ...rest] = command.split(/\s+/);
  const arg = rest.join(" ");
  if (name === "open" || name === "o") await navigate(arg);
  else if (name === "tab" || name === "t") await newTab(arg || DEFAULT_URL);
  else if (name === "q" || name === "quit") shutdown();
  else if (name === "reload" || name === "r") await tabs[active].view.reload();
  else if (name === "back") await tabs[active].view.goBack();
  else if (name === "forward") await tabs[active].view.goForward();
  else if (name === "snap" || name === "snapshot") {
    recordAction({ command: "snapshot", compact: true });
    setStatus("recorded snapshot");
  } else if (name === "wait") {
    const durationMs = Math.max(0, parseInt(arg || "250", 10) || 250);
    recordAction({ command: "wait", durationMs });
    setStatus(`recorded wait ${durationMs}ms`);
  } else if (name === "debug-input") {
    debugInput = !debugInput;
    setStatus(debugInput ? "debug input on" : "debug input off");
  } else setStatus(`unknown command: ${name}`);
}

function startPrompt(action: PromptAction, initial: string) {
  promptAction = action;
  commandMode = true;
  commandBuffer = initial;
}

async function openPromptedTab(value: string) {
  if (!value) {
    await newTab(DEFAULT_URL);
    return;
  }
  await newTab(toUrl(value));
}

async function openPromptedUrl(value: string) {
  if (!value) return;
  await navigate(toUrl(value));
}

async function handleMouse(mouse: MouseInput) {
  const rows = Math.max(1, (process.stdout.rows || 30) - 2);
  const cols = Math.max(1, process.stdout.columns || 100);
  if (mouse.wheel === "up") {
    await scrollPage(-620);
    setStatus("wheel up");
    scheduleRender();
    return;
  }
  if (mouse.wheel === "down") {
    await scrollPage(620);
    setStatus("wheel down");
    scheduleRender();
    return;
  }
  if (mouse.y <= 1) {
    const idx = Math.floor((mouse.x - 1) / 18);
    if (idx >= 0 && idx < tabs.length) {
      active = idx;
      scheduleRender();
    }
    return;
  }
  if (mouse.down && mouse.button === 0) {
    const x = Math.round(((mouse.x - 1) / cols) * width);
    const y = Math.round(((mouse.y - 2) / rows) * height);
    const target = await targetAtPoint(x, y);
    await locked(() => tabs[active].view.click(x, y)).catch(() => {});
    recordAction({
      command: "click",
      target: target?.selector,
      x,
      y,
      element: target,
    });
    // Clicking into a text field should let you type immediately.
    if (mode === "normal" && (await focusIsEditable())) mode = "insert";
  }
  scheduleRender();
}

// True when the page's active element accepts text input, so we can auto-enter
// Insert on click. One eval per click (not per keystroke) — cheap.
async function focusIsEditable(): Promise<boolean> {
  try {
    const r = await locked(() =>
      tabs[active].view.evaluate(
        `(() => { const e = document.activeElement; if (!e) return 0;` +
          ` const t = (e.tagName || "").toLowerCase();` +
          ` return (e.isContentEditable || t === "input" || t === "textarea" || t === "select") ? 1 : 0; })()`,
      ),
    );
    return Number(r) === 1;
  } catch {
    return false;
  }
}

async function press(key: string) {
  await locked(() => tabs[active].view.press(key)).catch(() => {});
  recordAction({ command: "press", key });
}

// AI-answer the current page: multiple-choice AND free text. br is the eyes and
// hands: it collects the clickable options (@refs) and the writable text fields
// (#refs), hands them plus the page prose to a solver command ($BR_SOLVER,
// default `claude -p`), then clicks the options and writes the essay/short
// answers the solver returns. The model is the brain and stays external, so br
// never embeds an API key or provider.
async function answerPage() {
  setStatus("answering...");
  scheduleRender();

  let collected: {
    options: { ref: string; label: string }[];
    fields: { ref: string; prompt: string; kind: string }[];
  };
  try {
    collected = await locked(() =>
      tabs[active].view.evaluate(COLLECT_TARGETS_SCRIPT),
    );
  } catch {
    setStatus("answer: could not read the page");
    return;
  }
  const options = collected?.options ?? [];
  const fields = collected?.fields ?? [];
  if (options.length === 0 && fields.length === 0) {
    setStatus("answer: no questions or writable fields found");
    return;
  }

  const text = await locked(() =>
    tabs[active].view.evaluate(
      `(() => { const t = document.body ? document.body.innerText : ""; return t.replace(/\\s+/g, " ").trim().slice(0, 8000); })()`,
    ),
  ).catch(() => "");

  setStatus(
    `answering... (${options.length} options, ${fields.length} fields)`,
  );
  scheduleRender();

  let plan: { clicks: string[]; fills: { ref: string; text: string }[] };
  try {
    plan = await runSolver(String(text || ""), options, fields);
  } catch (err: any) {
    setStatus("solver failed: " + (err?.message ?? err));
    return;
  }
  if (plan.clicks.length === 0 && plan.fills.length === 0) {
    setStatus("solver returned no answer");
    return;
  }

  const done: string[] = [];
  for (const ref of plan.clicks) {
    const opt = options.find((o) => o.ref === ref);
    if (!opt) continue;
    const ok = await locked(() =>
      tabs[active].view.evaluate(
        `(() => { const el = document.querySelector('[data-br-opt="${ref.slice(1)}"]');` +
          ` if (!el) return false; el.scrollIntoView({ block: "center" }); el.click(); return true; })()`,
      ),
    ).catch(() => false);
    if (!ok) continue;
    recordAction({ command: "click", element: { name: opt.label } });
    done.push(`click ${opt.label}`.slice(0, 30));
  }
  for (const fill of plan.fills) {
    const field = fields.find((f) => f.ref === fill.ref);
    if (!field || !fill.text) continue;
    const ok = await locked(() =>
      tabs[active].view.evaluate(fillFieldScript(fill.ref.slice(1), fill.text)),
    ).catch(() => false);
    if (!ok) continue;
    recordAction({
      command: "fill",
      target: `[data-br-field="${fill.ref.slice(1)}"]`,
      text: fill.text.slice(0, 80),
    });
    done.push(`wrote ${field.prompt || fill.ref}`.slice(0, 30));
  }
  setStatus(
    done.length
      ? `answered: ${done.join("  ")}`
      : "nothing matched on the page",
  );
  scheduleRender();
}

// Collect both kinds of answer target the way real quizzes/forms mark them up:
//   options -> clickable choices (@refs, tagged data-br-opt): native radios /
//     checkboxes whose <input> is hidden behind a styled <label>, plus ARIA
//     role=radio/option/menuitemradio widgets.
//   fields  -> writable inputs (#refs, tagged data-br-field): textareas,
//     text-like <input>s, and contenteditable boxes, each with the nearest
//     prompt text so the solver knows what to write.
const COLLECT_TARGETS_SCRIPT = String.raw`(() => {
  const MAXOPT = 80, MAXFIELD = 40, MAXT = 160;
  const clean = s => String(s || "").replace(/\s+/g, " ").trim().slice(0, MAXT);
  const visible = el => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none";
  };
  document.querySelectorAll("[data-br-opt]").forEach(e => e.removeAttribute("data-br-opt"));
  document.querySelectorAll("[data-br-field]").forEach(e => e.removeAttribute("data-br-field"));

  const options = [];
  const seen = new Set();
  let oi = 0;
  const addOption = (clickEl, label) => {
    label = clean(label);
    if (!clickEl || !label) return;
    const key = label + "|" + (clickEl.getBoundingClientRect().top | 0);
    if (seen.has(key)) return;
    seen.add(key);
    clickEl.setAttribute("data-br-opt", String(oi));
    options.push({ ref: "@" + oi, label });
    oi++;
  };
  for (const inp of document.querySelectorAll('input[type="radio"], input[type="checkbox"]')) {
    let labelEl = null, txt = "";
    if (inp.id) {
      const l = document.querySelector('label[for="' + CSS.escape(inp.id) + '"]');
      if (l) { labelEl = l; txt = l.innerText; }
    }
    const wrap = inp.closest("label");
    if (!txt && wrap) { labelEl = wrap; txt = wrap.innerText; }
    if (!txt) txt = inp.value || inp.getAttribute("aria-label") || "";
    const target = labelEl && visible(labelEl) ? labelEl : (visible(inp) ? inp : (labelEl || inp));
    addOption(target, txt);
  }
  for (const el of document.querySelectorAll('[role="radio"], [role="option"], [role="menuitemradio"]')) {
    if (!visible(el)) continue;
    addOption(el, el.getAttribute("aria-label") || el.innerText);
  }

  // What is this field asking? label, aria-label, placeholder, aria-labelledby,
  // or the nearest heading/paragraph above it.
  const promptFor = el => {
    if (el.id) {
      const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (l && clean(l.innerText)) return clean(l.innerText);
    }
    const wrap = el.closest("label");
    if (wrap && clean(wrap.innerText)) return clean(wrap.innerText);
    const aria = el.getAttribute("aria-label");
    if (aria) return clean(aria);
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const n = document.getElementById(by);
      if (n && clean(n.innerText)) return clean(n.innerText);
    }
    if (el.placeholder) return clean(el.placeholder);
    let node = el.closest("li, .question, [class*=question], .form-group, fieldset") || el.parentElement;
    for (let hops = 0; node && hops < 4; hops++, node = node.parentElement) {
      const h = node.querySelector && node.querySelector("h1,h2,h3,h4,legend,label,.question,[class*=question]");
      if (h && clean(h.innerText)) return clean(h.innerText);
    }
    return "";
  };

  const fields = [];
  let fi = 0;
  const TEXT_TYPES = ["text", "email", "search", "url", "tel", "number", ""];
  const candidates = document.querySelectorAll(
    'textarea, input, [contenteditable=""], [contenteditable="true"]'
  );
  for (const el of candidates) {
    if (fi >= MAXFIELD) break;
    if (!visible(el)) continue;
    if (el.disabled || el.readOnly) continue;
    let kind = "short";
    if (el.tagName === "TEXTAREA" || el.isContentEditable) kind = "long";
    else if (el.tagName === "INPUT") {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      if (!TEXT_TYPES.includes(t)) continue; // skip radio/checkbox/submit/file/etc
    } else continue;
    el.setAttribute("data-br-field", String(fi));
    fields.push({ ref: "#" + fi, prompt: promptFor(el), kind });
    fi++;
  }

  return { options: options.slice(0, MAXOPT), fields };
})()`;

// Write text into a collected field. Uses the native value setter + input/change
// events so framework-controlled inputs (React/Vue) actually register the value;
// contenteditable boxes get textContent + an input event.
function fillFieldScript(idx: string, value: string) {
  const v = JSON.stringify(value);
  return String.raw`(() => {
    const el = document.querySelector('[data-br-field="${idx}"]');
    if (!el) return false;
    el.scrollIntoView({ block: "center" });
    el.focus();
    const text = ${v};
    if (el.isContentEditable) {
      el.textContent = text;
      el.dispatchEvent(new InputEvent("input", { bubbles: true }));
    } else {
      const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
      setter.call(el, text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
    return true;
  })()`;
}

// Spawn the solver command, feed it the page + options + fields on stdin, and
// parse back a JSON plan: which option refs to click and what to write into each
// field ref. One keypress can answer a whole page (all MCQs + all essays).
async function runSolver(
  question: string,
  options: { ref: string; label: string }[],
  fields: { ref: string; prompt: string; kind: string }[],
): Promise<{ clicks: string[]; fills: { ref: string; text: string }[] }> {
  const cmd = (process.env.BR_SOLVER || "claude -p").trim();
  const parts = cmd.split(/\s+/).filter(Boolean);
  const prompt =
    `You are completing the question(s) on a web page. Answer everything.\n\n` +
    `PAGE TEXT:\n${question}\n\n` +
    `CLICKABLE OPTIONS (multiple choice; each has a ref and label):\n` +
    `${JSON.stringify(options)}\n\n` +
    `WRITABLE FIELDS (free text; each has a ref, the prompt it answers, and ` +
    `kind "short" or "long"):\n${JSON.stringify(fields)}\n\n` +
    `Instructions:\n` +
    `- For each multiple-choice question, pick the single best option and put ` +
    `its ref in "clicks".\n` +
    `- For each writable field, write a complete, well-formed answer for its ` +
    `prompt ("long" = a full paragraph/essay, "short" = a phrase or sentence) ` +
    `and put it in "fills".\n` +
    `- Reply with ONLY a JSON object, no markdown fence, no commentary:\n` +
    `{"clicks": ["@2"], "fills": [{"ref": "#0", "text": "..."}]}`;

  const proc = Bun.spawn(parts, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(prompt);
  await proc.stdin.end();

  // Never let a stuck solver freeze the live UI: kill it after a budget
  // (BR_SOLVER_TIMEOUT seconds, default 120) and report a timeout.
  const budgetMs = (Number(process.env.BR_SOLVER_TIMEOUT) || 120) * 1000;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, budgetMs);

  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  clearTimeout(timer);
  if (timedOut) throw new Error(`${parts[0]} timed out (${budgetMs / 1000}s)`);
  if (code !== 0 && !out.trim()) {
    const err = (await new Response(proc.stderr).text()).trim();
    throw new Error(err || `${parts[0]} exited ${code}`);
  }
  return parsePlan(out);
}

// Pull the answer plan out of the solver's stdout. Prefer a JSON object (the
// requested format, possibly wrapped in prose or a ```json fence); fall back to
// bare @refs so a model that only emits MCQ picks still works.
function parsePlan(out: string): {
  clicks: string[];
  fills: { ref: string; text: string }[];
} {
  const clicks: string[] = [];
  const fills: { ref: string; text: string }[] = [];
  const fence = out.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1] : out;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      const obj = JSON.parse(body.slice(start, end + 1));
      if (Array.isArray(obj.clicks)) {
        for (const c of obj.clicks)
          if (typeof c === "string" && /^@\d+$/.test(c)) clicks.push(c);
      }
      if (Array.isArray(obj.fills)) {
        for (const f of obj.fills) {
          if (f && /^#\d+$/.test(f.ref) && typeof f.text === "string")
            fills.push({ ref: f.ref, text: f.text });
        }
      }
      return { clicks: [...new Set(clicks)], fills };
    } catch {
      // fall through to bare-ref parsing
    }
  }
  for (const m of out.match(/@\d+/g) ?? []) clicks.push(m);
  return { clicks: [...new Set(clicks)], fills };
}

async function scrollPage(deltaY: number) {
  const view = tabs[active].view;
  await locked(async () => {
    await view.scroll(0, deltaY);
    await view.evaluate(
      `window.scrollBy({ top: ${JSON.stringify(deltaY)}, left: 0, behavior: "instant" }); true`,
    );
  }).catch(() => {});
  recordAction({ command: "scroll", amount: deltaY });
}

async function targetAtPoint(x: number, y: number) {
  try {
    return await locked(() =>
      tabs[active].view.evaluate(
        `(() => {
          const el = document.elementFromPoint(${JSON.stringify(x)}, ${JSON.stringify(y)});
          if (!el) return null;
          const esc = CSS.escape;
          const selector = (node) => {
            if (node.id) return "#" + esc(node.id);
            const parts = [];
            for (let n = node; n && n.nodeType === 1 && n !== document.body; n = n.parentElement) {
              let p = n.localName;
              const name = n.getAttribute("name");
              if (name) p += "[name=" + JSON.stringify(name) + "]";
              else {
                const parent = n.parentElement;
                if (parent) {
                  const same = [...parent.children].filter(c => c.localName === n.localName);
                  if (same.length > 1) p += ":nth-of-type(" + ([...parent.children].filter(c => c.localName === n.localName).indexOf(n) + 1) + ")";
                }
              }
              parts.unshift(p);
            }
            return parts.join(" > ");
          };
          const role = el.getAttribute("role") || el.localName;
          const name = (el.getAttribute("aria-label") || el.innerText || el.getAttribute("placeholder") || el.value || "").trim().slice(0, 120);
          return { selector: selector(el), role, name };
        })()`,
      ),
    );
  } catch {
    return null;
  }
}

async function activeElement() {
  try {
    return await locked(() =>
      tabs[active].view.evaluate(
        `(() => {
          const el = document.activeElement;
          if (!el || el === document.body) return null;
          const esc = CSS.escape;
          const selector = (node) => {
            if (node.id) return "#" + esc(node.id);
            const parts = [];
            for (let n = node; n && n.nodeType === 1 && n !== document.body; n = n.parentElement) {
              let p = n.localName;
              const name = n.getAttribute("name");
              if (name) p += "[name=" + JSON.stringify(name) + "]";
              else {
                const parent = n.parentElement;
                if (parent) {
                  const same = [...parent.children].filter(c => c.localName === n.localName);
                  if (same.length > 1) p += ":nth-of-type(" + (same.indexOf(n) + 1) + ")";
                }
              }
              parts.unshift(p);
            }
            return parts.join(" > ");
          };
          return {
            selector: selector(el),
          };
        })()`,
      ),
    );
  } catch {
    return null;
  }
}

function recordAction(action: Record<string, any>) {
  if (!recordPath) return;
  const clean = Object.fromEntries(
    Object.entries(action).filter(([, value]) => value !== undefined),
  );
  clean.ts = new Date().toISOString();
  const line = JSON.stringify(clean);
  appendFileSync(recordPath, line + "\n");
  recordLog.push(line);
  if (recordLog.length > 200) recordLog.shift();
  if (recordPane) scheduleRender();
}

function scheduleRender() {
  if (rendering) {
    needsRender = true;
    return;
  }
  rendering = true;
  setTimeout(async () => {
    await render().catch((err) => setStatus(err.message));
    rendering = false;
    if (needsRender) {
      needsRender = false;
      scheduleRender();
    }
  }, 25);
}

async function render() {
  const rows = Math.max(1, (process.stdout.rows || 30) - 2);
  const cols = Math.max(1, process.stdout.columns || 100);
  const frame = await locked(() =>
    renderFrame({
      tabs,
      active,
      cols,
      rows,
      commandMode,
      commandBuffer,
      promptAction,
      status,
      mode,
      recordLines: recordPane ? recordLog : [],
    }),
  );
  process.stdout.write(frame);
}

function setStatus(s: string) {
  status = s;
  scheduleRender();
  setTimeout(() => {
    if (status === s) {
      status = "";
      scheduleRender();
    }
  }, 2500);
}
