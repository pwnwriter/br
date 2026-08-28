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

// Per-connection write state. Bun's socket.write() is non-blocking: on a large
// response it writes only what fits the send buffer and returns fewer bytes, so
// calling socket.end() straight after truncates the rest (client then sees an
// unterminated JSON string). Queue the bytes and drain them, ending only once
// everything has flushed.
type Conn = { queue: Buffer; ending: boolean };

function flush(socket: any) {
  const conn: Conn = socket.data;
  if (conn.queue.length > 0) {
    const n = socket.write(conn.queue);
    conn.queue =
      n >= conn.queue.length ? Buffer.alloc(0) : conn.queue.subarray(n);
  }
  if (conn.queue.length === 0 && conn.ending) socket.end();
}

function enqueue(socket: any, text: string) {
  const conn: Conn = socket.data;
  conn.queue = Buffer.concat([conn.queue, Buffer.from(text)]);
  flush(socket);
}

const server = Bun.listen({
  unix: socketPath,
  socket: {
    open(socket) {
      socket.data = { queue: Buffer.alloc(0), ending: false } satisfies Conn;
    },
    drain(socket) {
      flush(socket);
    },
    async data(socket, data) {
      const input = Buffer.from(data).toString("utf8");
      for (const line of input.split("\n")) {
        if (!line.trim()) continue;
        try {
          const req = parseLine(line);
          const response = await handle(req);
          enqueue(socket, JSON.stringify(response) + "\n");
        } catch (err: any) {
          enqueue(
            socket,
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
      (socket.data as Conn).ending = true;
      flush(socket);
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
