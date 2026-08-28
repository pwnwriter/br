import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";

const [command, recipeDir, name, ...rest] = Bun.argv.slice(2);

if (!command || !recipeDir) usage();
mkdirSync(recipeDir, { recursive: true });

switch (command) {
  case "list":
    listRecipes();
    break;
  case "clear":
    clearRecipes();
    break;
  case "delete":
    deleteRecipe(name, rest);
    break;
  case "show":
    showRecipe(requiredName(name));
    break;
  case "export":
    exportRecipe(requiredName(name));
    break;
  case "replay":
    await replayRecipe(requiredName(name), rest);
    break;
  default:
    usage();
}

function usage(): never {
  console.error(
    "usage: bun worker/recipe.ts <list|show|export|replay> <recipe-dir> [name]",
  );
  process.exit(2);
}

function requiredName(value: string | undefined) {
  if (!value || !/^[A-Za-z0-9_.-]{1,64}$/.test(value)) {
    console.error("invalid recipe name");
    process.exit(2);
  }
  return value;
}

function recipePath(recipeName: string) {
  return join(recipeDir, `${recipeName}.jsonl`);
}

function readRecipe(recipeName: string) {
  const path = recipePath(recipeName);
  if (!existsSync(path)) {
    console.error(`recipe not found: ${recipeName}`);
    process.exit(2);
  }
  return readFileSync(path, "utf8");
}

function listRecipes() {
  const names = readdirSync(recipeDir)
    .filter((file) => file.endsWith(".jsonl"))
    .map((file) => file.slice(0, -".jsonl".length))
    .sort();
  process.stdout.write(names.join("\n") + (names.length ? "\n" : ""));
}

function clearRecipes() {
  let count = 0;
  for (const file of readdirSync(recipeDir)) {
    if (!file.endsWith(".jsonl")) continue;
    unlinkSync(join(recipeDir, file));
    count += 1;
  }
  process.stdout.write(`deleted ${count} recipe${count === 1 ? "" : "s"}\n`);
}

function deleteRecipe(value: string | undefined, args: string[]) {
  if (value === "--all" || args.includes("--all")) {
    clearRecipes();
    return;
  }
  const recipeName = requiredName(value);
  const path = recipePath(recipeName);
  if (!existsSync(path)) {
    console.error(`recipe not found: ${recipeName}`);
    process.exit(2);
  }
  unlinkSync(path);
  process.stdout.write(`deleted ${recipeName}\n`);
}

function showRecipe(recipeName: string) {
  process.stdout.write(readRecipe(recipeName));
}

function exportRecipe(recipeName: string) {
  process.stdout.write(readRecipe(recipeName));
}

async function replayRecipe(recipeName: string, args: string[]) {
  const socketPath = args[0];
  const session = args[1] || "default";
  const pauseOnFail = args.includes("--pause-on-fail");
  if (!socketPath) usage();

  const actions = readRecipe(recipeName)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  let id = 0;
  for (const action of compileActions(actions)) {
    const method = action.command || action.method;
    if (!method || method === "wait") {
      if (method === "wait")
        await Bun.sleep(Number(action.durationMs || action.ms || 250));
      continue;
    }

    const req = {
      version: 1,
      id: ++id,
      session: action.session || session,
      method,
      params: { ...action, json: true },
    };
    delete req.params.command;
    delete req.params.method;
    delete req.params.ts;

    const responseText = await send(socketPath, JSON.stringify(req));
    process.stdout.write(responseText);
    const response = JSON.parse(responseText);
    if (response.ok === false) {
      if (pauseOnFail) {
        console.error(
          `replay paused after failed ${method}; run \`br patch ${recipeName}\` to append a repaired path`,
        );
      }
      process.exit(1);
    }
  }
}

function compileActions(actions: Record<string, any>[]) {
  const compiled: Record<string, any>[] = [];
  let pending: Record<string, any> | null = null;
  let pendingClick: Record<string, any> | null = null;

  const flush = () => {
    if (pendingClick) {
      compiled.push(pendingClick);
      pendingClick = null;
    }
    if (!pending) return;
    compiled.push(pending);
    pending = null;
  };

  for (const action of actions) {
    const method = action.command || action.method;
    if (method === "click" && typeof action.target === "string") {
      flush();
      pendingClick = action;
      continue;
    }

    if (method === "type" && typeof action.target === "string") {
      if (pendingClick && pendingClick.target !== action.target) {
        compiled.push(pendingClick);
      }
      pendingClick = null;
      if (!pending || pending.target !== action.target) {
        flush();
        pending = { command: "fill", target: action.target, text: "" };
      }
      pending.text += String(action.text ?? "");
      continue;
    }

    if (
      method === "press" &&
      action.key === "Backspace" &&
      pending &&
      typeof pending.text === "string"
    ) {
      pending.text = pending.text.slice(0, -1);
      continue;
    }

    flush();
    compiled.push(action);
  }
  flush();
  return compiled;
}

async function send(socketPath: string, line: string) {
  return await new Promise<string>((resolve, reject) => {
    const socket = connect(socketPath);
    let out = "";
    socket.setEncoding("utf8");
    socket.on("connect", () =>
      socket.write(line.endsWith("\n") ? line : line + "\n"),
    );
    socket.on("data", (chunk) => (out += chunk));
    socket.on("end", () => resolve(out));
    socket.on("error", reject);
  });
}
