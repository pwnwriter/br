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
{
  const rest = Bun.argv.slice(2);
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a === "--refresh") {
      const v = parseInt(rest[++i] ?? "", 10);
      if (Number.isFinite(v) && v > 0) refreshMs = Math.max(30, v);
    } else if (!a.startsWith("--")) {
      startUrl = a;
    }
  }
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
  await locked(async () => {
    await tab.view.navigate(url);
    tab.url = tab.view.url;
    tab.title = tab.view.title;
  }).catch((err) => setStatus(`navigation failed: ${err?.message ?? err}`));
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
  if (input >= " ")
    await locked(() => tabs[active].view.type(input)).catch(() => {});
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
  else if (name === "debug-input") {
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
    await locked(() => tabs[active].view.click(x, y)).catch(() => {});
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
}

async function scrollPage(deltaY: number) {
  const view = tabs[active].view;
  await locked(async () => {
    await view.scroll(0, deltaY);
    await view.evaluate(
      `window.scrollBy({ top: ${JSON.stringify(deltaY)}, left: 0, behavior: "instant" }); true`,
    );
  }).catch(() => {});
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
