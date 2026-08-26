import {
  DEFAULT_URL,
  ESC,
  describeBytes,
  parseMouseEvents,
  toUrl,
} from "./live/input";
import { renderFrame } from "./live/render";
import type { MouseInput, PromptAction, Tab } from "./live/types";

const startUrl = Bun.argv[2] || DEFAULT_URL;

let tabs: Tab[] = [];
let active = 0;
let width = Math.max(640, (process.stdout.columns || 100) * 10);
let height = Math.max(360, ((process.stdout.rows || 30) - 2) * 20);
let rendering = false;
let needsRender = false;
let commandMode = false;
let commandBuffer = "";
let promptAction: PromptAction = "command";
let status = "";
let debugInput = false;

if (!(Bun as any).WebView) {
  console.error(
    "Bun.WebView is unavailable. br live requires Bun 1.4+ with WebView support.",
  );
  process.exit(10);
}

setupTerminal();
await newTab(startUrl);
await render();

process.stdin.on("data", (chunk) => {
  void handleInput(Buffer.from(chunk).toString("utf8"));
});

process.stdout.on("resize", () => {
  width = Math.max(640, (process.stdout.columns || 100) * 10);
  height = Math.max(360, ((process.stdout.rows || 30) - 2) * 20);
  for (const tab of tabs) tab.view.resize(width, height).catch(() => {});
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
  view.onNavigated = (url: string, title: string) => {
    tab.url = url;
    tab.title = title;
    scheduleRender();
  };
  tabs.push(tab);
  active = tabs.length - 1;
  if (url && url !== DEFAULT_URL) await navigate(url);
}

async function navigate(url: string) {
  const tab = tabs[active];
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) url = "https://" + url;
  await tab.view
    .navigate(url)
    .catch((err) => setStatus(`navigation failed: ${err.message}`));
  tab.url = tab.view.url;
  tab.title = tab.view.title;
  scheduleRender();
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
    tabs[active].view.close();
    tabs.splice(active, 1);
    active = Math.max(0, active - 1);
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
  else if (input.length === 1 && input >= " ")
    await tabs[active].view.type(input);
  scheduleRender();
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
    await tabs[active].view.click(x, y);
  }
  scheduleRender();
}

async function press(key: string) {
  await tabs[active].view.press(key).catch(() => {});
}

async function scrollPage(deltaY: number) {
  const view = tabs[active].view;
  await view.scroll(0, deltaY).catch(() => {});
  await view
    .evaluate(
      `window.scrollBy({ top: ${JSON.stringify(deltaY)}, left: 0, behavior: "instant" }); true`,
    )
    .catch(() => {});
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
  const frame = await renderFrame({
    tabs,
    active,
    cols,
    rows,
    commandMode,
    commandBuffer,
    promptAction,
    status,
  });
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
