import { unlinkSync } from "node:fs";
import { handle } from "./browser";
import { parseLine } from "./protocol";

const args = Bun.argv.slice(2);
if (args[0] !== "--server") {
  console.error("usage: bun worker/main.ts --server <socket>");
  process.exit(2);
}

const socketPath = args[1];
if (!socketPath) {
  console.error("missing socket path");
  process.exit(2);
}

try {
  unlinkSync(socketPath);
} catch {}

const server = Bun.listen({
  unix: socketPath,
  socket: {
    async data(socket, data) {
      const input = Buffer.from(data).toString("utf8");
      for (const line of input.split("\n")) {
        if (!line.trim()) continue;
        try {
          const req = parseLine(line);
          const response = await handle(req);
          socket.write(JSON.stringify(response) + "\n");
        } catch (err: any) {
          socket.write(
            JSON.stringify({
              version: 1,
              id: 0,
              ok: false,
              error: {
                code: "PROTOCOL_ERROR",
                message: err?.message || String(err),
              },
            }) + "\n",
          );
        }
      }
      socket.end();
    },
  },
});
(server as any).ref?.();

process.on("SIGTERM", () => shutdown());
process.on("SIGINT", () => shutdown());

function shutdown() {
  try {
    server.stop(true);
  } catch {}
  try {
    (Bun as any).WebView?.closeAll?.();
  } catch {}
  try {
    unlinkSync(socketPath);
  } catch {}
  process.exit(0);
}
