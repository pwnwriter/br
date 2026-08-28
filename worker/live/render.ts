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
  mode: "normal" | "insert";
  recordLines?: string[];
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
    mode,
    recordLines = [],
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
    mode,
    recordLines,
  );
}

// Double-buffered image ids. Each frame is transmitted under a fresh id and
// placed over the same cells; only AFTER it lands do we delete the previous
// id. The new frame always covers the old one, so there is never a blank gap
// (the flicker). We alternate two ids so terminal image storage stays bounded.
let prevImageId: number | null = null;
function nextImageId() {
  const id = prevImageId === 41 ? 42 : 41;
  return id;
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
  mode: "normal" | "insert",
  recordLines: string[],
) {
  const chrome = `${ESC}[H${ESC}[2K${tabBar(tabs, active, cols)}`;
  const footer = `${ESC}[${rows + 2};1H${ESC}[2K${statusLine(tabs, active, cols, commandMode, status, mode)}`;
  const logRows = recordLines.length > 0 ? Math.min(8, Math.max(4, Math.floor(rows * 0.32))) : 0;
  const separatorRows = logRows > 0 ? 1 : 0;
  const imageRows = Math.max(1, rows - logRows - separatorRows);

  // Command mode: blank the viewport under the prompt box and drop the image.
  if (commandMode) {
    const clear = prevImageId != null ? deleteImage(prevImageId) : "";
    prevImageId = null;
    return `${clear}${chrome}${ESC}[2;1H${blankViewport(cols, rows)}${promptOverlay(cols, rows, true, commandBuffer, promptAction)}${footer}`;
  }

  const id = nextImageId();
  const image = await screenshotImage(view, cols, imageRows, id);
  // If the screenshot failed we get a blank viewport (no image drawn); in that
  // case don't retire the previous id — there is nothing new covering it.
  const drewImage = image.includes("_G");
  const retire =
    drewImage && prevImageId != null ? deleteImage(prevImageId) : "";
  if (drewImage) prevImageId = id;
  return `${chrome}${ESC}[2;1H${image}${retire}${renderRecordPane(recordLines, cols, imageRows, logRows)}${footer}`;
}

// A page that has not painted yet (or a blank view) can make screenshot throw.
// Fall back to an empty viewport so a bad frame never breaks the render loop.
async function screenshotImage(
  view: any,
  cols: number,
  rows: number,
  id: number,
) {
  try {
    const shot = await view.screenshot({ format: "png", encoding: "base64" });
    return kittyImage(shot, cols, rows, id);
  } catch {
    return blankViewport(cols, rows);
  }
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
  mode: "normal" | "insert",
) {
  if (commandMode) return fit("Enter to confirm  Esc to cancel", cols, status);
  if (mode === "insert")
    return fit(
      "-- INSERT --  keys go to the page  |  Esc to exit",
      cols,
      status,
    );
  const tab = tabs[active];
  return fit(
    `${tab.url || "about:blank"}  |  q quit  o open  t tab  x close  i insert  j/k scroll`,
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

function renderRecordPane(lines: string[], cols: number, imageRows: number, logRows: number) {
  if (logRows === 0) return "";
  const top = 2 + imageRows;
  const visible = lines.slice(-logRows);
  const border = fit(" record log " + "-".repeat(cols), cols, "");
  let out = `${ESC}[${top};1H${border}`;
  for (let i = 0; i < logRows; i += 1) {
    const line = visible[i] || "";
    out += `${ESC}[${top + 1 + i};1H${fit(line, cols, "")}`;
  }
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

function kittyImage(base64: string, cols: number, rows: number, id: number) {
  const chunkSize = 4096;
  let out = "";
  // Control keys go ONLY on the first chunk; continuation chunks carry just m=
  // (Ghostty/WezTerm drop the image otherwise). i=<id> tags the image so we can
  // retire the previous frame by id; q=2 suppresses terminal ack replies.
  for (let i = 0; i < base64.length; i += chunkSize) {
    const chunk = base64.slice(i, i + chunkSize);
    const more = i + chunkSize < base64.length ? 1 : 0;
    const control =
      i === 0
        ? `a=T,f=100,i=${id},c=${cols},r=${rows},q=2,m=${more}`
        : `m=${more}`;
    out += `${ESC}_G${control};${chunk}${ESC}\\`;
  }
  return out;
}

// Delete one image (and its placements) by id, freeing its storage.
function deleteImage(id: number) {
  return `${ESC}_Ga=d,d=i,i=${id},q=2${ESC}\\`;
}
