import { fail, ok, type Request } from "./protocol";
import { RefStore } from "./refs";
import { snapshot, formatLine } from "./snapshot";

type Session = {
  view: any;
  refs: RefStore;
  console: { type: string; args: any[] }[];
  profileDir?: string;
};

const sessions = new Map<string, Session>();

function validIdentifier(name: string) {
  return /^[A-Za-z0-9_.-]{1,64}$/.test(name);
}

function requireWebView() {
  if (!(Bun as any).WebView)
    throw Object.assign(
      new Error("Bun.WebView is unavailable in this Bun build"),
      { code: "BROWSER_UNAVAILABLE" },
    );
}

const BACKENDS = ["webkit", "chrome"];

function getSession(
  name: string,
  profileDir?: string,
  backend?: string,
): Session {
  if (!validIdentifier(name))
    throw Object.assign(new Error("invalid session name"), {
      code: "INVALID_ARGUMENTS",
    });
  if (backend && !BACKENDS.includes(backend))
    throw Object.assign(
      new Error(`unknown backend "${backend}" (use ${BACKENDS.join(" | ")})`),
      { code: "INVALID_ARGUMENTS" },
    );
  let s = sessions.get(name);
  if (s) return s;
  requireWebView();
  const consoleEvents: { type: string; args: any[] }[] = [];
  const options: any = {
    width: 1280,
    height: 720,
    console: (type: string, ...args: any[]) => {
      consoleEvents.push({ type, args: args.map(safeConsole) });
      if (consoleEvents.length > 100) consoleEvents.shift();
    },
  };
  if (backend) options.backend = backend;
  if (profileDir) options.dataStore = { directory: profileDir };
  s = {
    view: new (Bun as any).WebView(options),
    refs: new RefStore(),
    console: consoleEvents,
    profileDir,
  };
  sessions.set(name, s);
  return s;
}

export async function handle(req: Request) {
  try {
    const p = req.params || {};
    if (req.method === "ping") return ok(req.id, { ready: true });
    if (req.method === "daemonStop") {
      setTimeout(() => process.exit(0), 20);
      return ok(req.id, {});
    }
    if (req.method === "sessionList") {
      const names = [...sessions.keys()].sort();
      return p.json
        ? ok(req.id, { sessions: names })
        : ok(req.id, { text: names.join("\n") + (names.length ? "\n" : "") });
    }
    if (req.method === "sessionClose" && typeof p.name === "string") {
      const s = sessions.get(p.name);
      if (s) s.view.close();
      sessions.delete(p.name);
      return ok(req.id, { text: "ok\n" });
    }
    if (req.method === "sessionCloseAll") {
      for (const s of sessions.values()) s.view.close();
      sessions.clear();
      return ok(req.id, { text: "ok\n" });
    }

    const s = getSession(req.session, p.profileDir, p.backend);
    const view = s.view;
    switch (req.method) {
      case "open": {
        let url = required(p.url, "url");
        // Accept bare hosts like "news.ycombinator.com" — default to https://.
        if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) url = "https://" + url;
        await view.navigate(url);
        return cliOk(
          req,
          { url: view.url, title: view.title },
          view.url + "\n",
        );
      }
      case "snapshot": {
        const snap = await snapshot(view);
        s.refs.replace(snap.all);
        return cliOk(
          req,
          { url: snap.url, title: snap.title, elements: snap.all },
          p.compact ? snap.compact : snap.text,
        );
      }
      case "click":
        if (typeof p.target === "string" && p.target.length > 0) {
          try {
            await view.click(await resolve(s, p.target));
          } catch (err) {
            if (Number.isFinite(p.x) && Number.isFinite(p.y)) {
              await view.click(Number(p.x), Number(p.y));
            } else {
              throw err;
            }
          }
        } else if (Number.isFinite(p.x) && Number.isFinite(p.y)) {
          await view.click(Number(p.x), Number(p.y));
        } else {
          required(p.target, "target");
        }
        return cliOk(req, { url: view.url }, "ok\n");
      case "fill": {
        const selector = await resolve(s, required(p.target, "target"));
        await view.click(selector);
        await view
          .press("a", { modifiers: ["Meta"] })
          .catch(() => view.press("a", { modifiers: ["Control"] }));
        await view.press("Backspace");
        await view.type(required(p.text, "text"));
        return cliOk(req, { url: view.url }, "ok\n");
      }
      case "type":
        await view.type(required(p.text, "text"));
        return cliOk(req, {}, "ok\n");
      case "press":
        await view.press(required(p.key, "key"));
        return cliOk(req, { url: view.url }, "ok\n");
      case "hover":
        await view.evaluate(
          `document.querySelector(${JSON.stringify(await resolve(s, required(p.target, "target")))}).dispatchEvent(new MouseEvent("mouseover",{bubbles:true}))`,
        );
        return cliOk(req, {}, "ok\n");
      case "text":
        return valueResult(
          req,
          await evalForTarget(view, p.target, "innerText"),
        );
      case "html":
        return valueResult(
          req,
          await evalForTarget(view, p.target, "outerHTML"),
        );
      case "get": {
        const item = refEntry(s, required(p.target, "target"));
        if (item)
          return cliOk(
            req,
            item,
            `${item.ref}\nrole: ${item.role}\nname: ${item.name}\nvisible: true\n`,
          );
        const data = await inspectSelector(view, required(p.target, "target"));
        return cliOk(
          req,
          data,
          Object.entries(data)
            .map(([k, v]) => `${k}: ${v}`)
            .join("\n") + "\n",
        );
      }
      case "attr":
        return valueResult(
          req,
          await view.evaluate(
            `document.querySelector(${JSON.stringify(await resolve(s, required(p.target, "target")))}).getAttribute(${JSON.stringify(required(p.attribute, "attribute"))})`,
          ),
        );
      case "value":
        return valueResult(
          req,
          await view.evaluate(
            `document.querySelector(${JSON.stringify(await resolve(s, required(p.target, "target")))}).value ?? ""`,
          ),
        );
      case "find": {
        const q = String(required(p.text, "text")).toLowerCase();
        const matches = s.refs
          .list()
          .filter((r) => (r.name + " " + r.role).toLowerCase().includes(q))
          .slice(0, 20);
        return cliOk(
          req,
          { elements: matches },
          matches.map((m) => formatLine(m, false)).join("\n") +
            (matches.length ? "\n" : ""),
        );
      }
      case "scroll":
        await view.scroll(0, Number(p.amount || 0));
        return cliOk(req, {}, "ok\n");
      case "scrollTo":
        await view.scrollTo(await resolve(s, required(p.target, "target")));
        return cliOk(req, {}, "ok\n");
      case "url":
        return cliOk(req, { url: view.url }, view.url + "\n");
      case "title":
        return cliOk(req, { title: view.title }, view.title + "\n");
      case "back":
        await view.goBack();
        return cliOk(req, { url: view.url }, "ok\n");
      case "forward":
        await view.goForward();
        return cliOk(req, { url: view.url }, "ok\n");
      case "reload":
        await view.reload();
        return cliOk(req, { url: view.url }, "ok\n");
      case "wait":
        if (p.durationMs) await Bun.sleep(Number(p.durationMs));
        else
          await view.evaluate(
            `new Promise((res, rej) => { const s=${JSON.stringify(required(p.target, "selector"))}; const t=setTimeout(()=>rej(new Error("timeout")),30000); const f=()=>{ if(document.querySelector(s)){clearTimeout(t);res(true)} else requestAnimationFrame(f)}; f(); })`,
          );
        return cliOk(req, {}, "ok\n");
      case "eval": {
        const value = await view.evaluate(required(p.text, "javascript"));
        return valueResult(req, value);
      }
      case "screenshot": {
        const path = p.path || "br-screenshot.png";
        const bytes = await view.screenshot({
          format: p.format || "png",
          quality: p.quality ?? 80,
          encoding: "buffer",
        });
        await Bun.write(path, bytes);
        return cliOk(
          req,
          { path: path.startsWith("/") ? path : `${process.cwd()}/${path}` },
          `${path}\n`,
        );
      }
      case "view": {
        const base64 = await view.screenshot({
          format: "png",
          encoding: "base64",
        });
        if (req.params?.json)
          return ok(req.id, {
            command: "view",
            protocol: "kitty",
            bytes: Math.floor((base64.length * 3) / 4),
          });
        const path = `${process.env.TMPDIR || "/tmp"}/br-view-${process.pid}-${req.id}.kitty`;
        const text = kittyImage(base64);
        await Bun.write(path, text);
        return ok(req.id, { kittyPath: path, bytes: text.length });
      }
      case "resize":
        await view.resize(Number(p.width), Number(p.height));
        return cliOk(req, {}, "ok\n");
      case "cookies":
        return valueResult(req, await view.evaluate("document.cookie"));
      case "console":
        return cliOk(
          req,
          { events: s.console },
          s.console.map((e) => `${e.type} ${e.args.join(" ")}`).join("\n") +
            (s.console.length ? "\n" : ""),
        );
      case "close":
        view.close();
        sessions.delete(req.session);
        return cliOk(req, {}, "ok\n");
      case "cdp":
        return valueResult(
          req,
          await view.cdp(
            required(p.cdpMethod, "cdp method"),
            p.cdpParams || {},
          ),
        );
      default:
        return fail(
          req.id,
          "INVALID_ARGUMENTS",
          `unknown method ${req.method}`,
        );
    }
  } catch (err: any) {
    const code = classify(err);
    return fail(
      req.id,
      code,
      err?.message || String(err),
      err?.ref ? { ref: err.ref } : {},
    );
  }
}

function cliOk(req: Request, result: Record<string, any>, text: string) {
  if (req.params?.json) return ok(req.id, { command: req.method, ...result });
  return ok(req.id, { text });
}

function valueResult(req: Request, value: any) {
  if (value === undefined) value = null;
  if (req.params?.json) return ok(req.id, { command: req.method, value });
  return ok(req.id, {
    text:
      typeof value === "string" ? value + "\n" : JSON.stringify(value) + "\n",
  });
}

function required(value: any, name: string) {
  if (typeof value !== "string" || value.length === 0)
    throw Object.assign(new Error(`missing ${name}`), {
      code: "INVALID_ARGUMENTS",
    });
  return value;
}

async function resolve(s: Session, target: string) {
  if (!target.startsWith("@")) return target;
  const entry = s.refs.get(target);
  if (!entry)
    throw Object.assign(
      new Error(`Element ${target} is no longer valid; run \`br snap\` again`),
      { code: "STALE_REF", ref: target },
    );
  const current = await s.view.evaluate(
    `(() => { const el = document.querySelector(${JSON.stringify(entry.selector)}); if (!el) return null; return [${JSON.stringify(entry.role)}, ${JSON.stringify(entry.name)}, el.tagName, el.id || "", el.getAttribute("name") || "", el.getAttribute("href") || "", el.getAttribute("type") || ""].join("|"); })()`,
  );
  if (current !== entry.fingerprint)
    throw Object.assign(
      new Error(`Element ${target} is no longer valid; run \`br snap\` again`),
      { code: "STALE_REF", ref: target },
    );
  return entry.selector;
}

function refEntry(s: Session, target: string) {
  return target.startsWith("@") ? s.refs.get(target) : null;
}

async function evalForTarget(
  view: any,
  target: string | undefined,
  prop: string,
) {
  if (!target) return await view.evaluate(`document.body?.innerText || ""`);
  return await view.evaluate(
    `document.querySelector(${JSON.stringify(target)}).${prop} || ""`,
  );
}

async function inspectSelector(view: any, selector: string) {
  return await view.evaluate(
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error("element not found"); return { role: el.getAttribute("role") || el.tagName.toLowerCase(), name: (el.innerText || el.getAttribute("aria-label") || el.value || "").trim(), visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length), disabled: !!el.disabled }; })()`,
  );
}

function safeConsole(v: any) {
  if (typeof v === "string") return v.slice(0, 500);
  if (typeof v === "number" || typeof v === "boolean" || v == null) return v;
  return JSON.stringify(v).slice(0, 500);
}

function classify(err: any) {
  if (err?.code) return err.code;
  const msg = String(err?.message || err);
  if (/timeout/i.test(msg)) return "TIMEOUT";
  if (/navigation|navigate|load/i.test(msg)) return "NAVIGATION_FAILED";
  if (/not found|querySelector.*null/i.test(msg)) return "ELEMENT_NOT_FOUND";
  if (/evaluate|script/i.test(msg)) return "EVALUATION_FAILED";
  if (/WebView|browser|Bun/i.test(msg)) return "BROWSER_UNAVAILABLE";
  return "INTERNAL_ERROR";
}

function kittyImage(base64: string) {
  const chunkSize = 4096;
  let out = "";
  // Per the Kitty graphics protocol, control keys (a=T,f=100) go ONLY on the
  // first chunk; continuation chunks carry just m=. Kitty tolerates repeating
  // them, but Ghostty/WezTerm are strict and will drop the image otherwise.
  for (let i = 0; i < base64.length; i += chunkSize) {
    const chunk = base64.slice(i, i + chunkSize);
    const more = i + chunkSize < base64.length ? 1 : 0;
    const control = i === 0 ? `a=T,f=100,m=${more}` : `m=${more}`;
    out += `\x1b_G${control};${chunk}\x1b\\`;
  }
  return out + "\n";
}
