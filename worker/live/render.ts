import type { PromptAction, Tab } from "./types";
import { ESC } from "./input";

export function renderFrame(args: {
  tabs: Tab[];
  active: number;
  cols: number;
  rows: number;
  commandMode: boolean;
  commandBuffer: string;
  promptAction: PromptAction;
  status: string;
}) {
  const {
    tabs,
    active,
    cols,
    rows,
    commandMode,
    commandBuffer,
    promptAction,
    status,
  } = args;
  const tab = tabs[active];
  return renderFrameAsync(
    tab.view,
    tabs,
    active,
    cols,
    rows,
    commandMode,
    commandBuffer,
    promptAction,
    status,
  );
}

async function renderFrameAsync(
  view: any,
  tabs: Tab[],
  active: number,
  cols: number,
  rows: number,
  commandMode: boolean,
  commandBuffer: string,
  promptAction: PromptAction,
  status: string,
) {
  const image = commandMode
    ? blankViewport(cols, rows)
    : kittyImage(
        await view.screenshot({ format: "png", encoding: "base64" }),
        cols,
        rows,
      );
  return `${deleteKittyImages()}${ESC}[H${ESC}[2K${tabBar(tabs, active, cols)}${ESC}[2;1H${image}${promptOverlay(cols, rows, commandMode, commandBuffer, promptAction)}${ESC}[${rows + 2};1H${ESC}[2K${statusLine(tabs, active, cols, commandMode, status)}`;
}

function tabBar(tabs: Tab[], active: number, cols: number) {
  const parts = tabs.map((tab, i) => {
    const title = (tab.title || tab.url || "blank")
      .replace(/\s+/g, " ")
      .slice(0, 14);
    return `${i === active ? "[" : " "}${i + 1}:${title}${i === active ? "]" : " "}`;
  });
  return fit(parts.join(" "), cols, "");
}

function statusLine(
  tabs: Tab[],
  active: number,
  cols: number,
  commandMode: boolean,
  status: string,
) {
  if (commandMode) return fit("Enter to confirm  Esc to cancel", cols, status);
  const tab = tabs[active];
  return fit(
    `${tab.url || "about:blank"}  |  q quit  o open  t new tab  x close tab  tab switch  j/k scroll`,
    cols,
    status,
  );
}

function promptOverlay(
  cols: number,
  rows: number,
  commandMode: boolean,
  commandBuffer: string,
  promptAction: PromptAction,
) {
  if (!commandMode) return "";
  const boxWidth = Math.min(
    Math.max(44, Math.floor(cols * 0.62)),
    Math.max(20, cols - 4),
  );
  const left = Math.max(1, Math.floor((cols - boxWidth) / 2) + 1);
  const top = Math.max(3, Math.floor((rows + 2 - 3) / 2));
  const prompt =
    promptAction === "tab"
      ? "new tab:"
      : promptAction === "open"
        ? "open:"
        : ":";
  const inputWidth = boxWidth - 4;
  const input =
    commandBuffer.length > inputWidth
      ? commandBuffer.slice(commandBuffer.length - inputWidth)
      : commandBuffer;
  const border = "+" + "-".repeat(boxWidth - 2) + "+";
  const inputLine = "| " + pad(`${prompt} ${input}`, boxWidth - 4) + " |";
  return [
    `${ESC}[${top};${left}H${border}`,
    `${ESC}[${top + 1};${left}H${inputLine}`,
    `${ESC}[${top + 2};${left}H${border}`,
  ].join("");
}

function blankViewport(cols: number, rows: number) {
  let out = "";
  for (let row = 0; row < rows; row += 1)
    out += `${ESC}[${row + 2};1H${" ".repeat(cols)}`;
  return out;
}

function pad(s: string, width: number) {
  const text = s.length > width ? s.slice(0, width) : s;
  return text + " ".repeat(Math.max(0, width - text.length));
}

function fit(s: string, cols: number, status: string) {
  const text = status ? `${status} | ${s}` : s;
  return text.length > cols
    ? text.slice(0, cols)
    : text + " ".repeat(cols - text.length);
}

function kittyImage(base64: string, cols: number, rows: number) {
  const chunkSize = 4096;
  let out = "";
  for (let i = 0; i < base64.length; i += chunkSize) {
    const chunk = base64.slice(i, i + chunkSize);
    const more = i + chunkSize < base64.length ? 1 : 0;
    const placement = i === 0 ? `,c=${cols},r=${rows}` : "";
    out += `${ESC}_Ga=T,f=100${placement},m=${more};${chunk}${ESC}\\`;
  }
  return out;
}

function deleteKittyImages() {
  return `${ESC}_Ga=d,d=A${ESC}\\`;
}
