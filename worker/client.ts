import { connect } from "node:net";

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

if (Bun.argv[2] === "--batch") {
  const socketPath = Bun.argv[3];
  const session = Bun.argv[4] || "default";
  let seq = 0;
  for await (const chunk of Bun.stdin.stream()) {
    const text = Buffer.from(chunk).toString("utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const obj = JSON.parse(line);
      const req = {
        version: 1,
        // Monotonic per-line id: Date.now() collides when lines run inside the
        // same millisecond, making responses impossible to correlate.
        id: typeof obj.id === "number" ? obj.id : ++seq,
        session: obj.session || session,
        method: obj.command || obj.method,
        params: { ...obj, json: true },
      };
      delete req.params.command;
      delete req.params.method;
      process.stdout.write(await send(socketPath, JSON.stringify(req)));
    }
  }
} else {
  const socketPath = Bun.argv[2];
  const line = Bun.argv[3];
  if (!socketPath || !line) process.exit(2);
  const response = await send(socketPath, line);
  const request = JSON.parse(line);
  const parsed = JSON.parse(response);
  if (request.method === "view" && !request.params?.json) {
    if (parsed.ok === false) {
      process.stdout.write(JSON.stringify(parsed) + "\n");
      process.exit(1);
    }
    const path = parsed.result?.kittyPath;
    if (!path) process.exit(1);
    // Write the Kitty frame and AWAIT the pipe drain before exiting.
    // process.stdout.write() is async on a pipe; a bare process.exit(0) after
    // it truncates a >~200KB frame mid-payload, so the terminal never receives
    // the final m=0 chunk and renders nothing.
    const frame = await Bun.file(path).bytes();
    await new Promise<void>((resolve, reject) =>
      process.stdout.write(frame, (err) => (err ? reject(err) : resolve())),
    );
    await Bun.file(path)
      .delete()
      .catch(() => {});
    process.exit(0);
  }
  if (parsed?.result?.text && !line.includes('"json":true'))
    process.stdout.write(parsed.result.text);
  else
    process.stdout.write(
      JSON.stringify(
        parsed.result && line.includes('"json":true')
          ? { ok: true, ...parsed.result }
          : parsed,
      ) + "\n",
    );
  if (parsed.ok === false) process.exit(1);
}
