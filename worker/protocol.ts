export type Request = {
  version: number;
  id: number;
  session: string;
  method: string;
  params?: Record<string, any>;
};

export type BrError = {
  code: string;
  message: string;
  ref?: string;
};

export function ok(id: number, result: Record<string, any> = {}) {
  return { version: 1, id, ok: true, result };
}

export function fail(
  id: number,
  code: string,
  message: string,
  extra: Record<string, any> = {},
) {
  return { version: 1, id, ok: false, error: { code, message, ...extra } };
}

export function parseLine(line: string): Request {
  if (line.length > 1024 * 1024) throw new Error("message too large");
  const req = JSON.parse(line);
  if (req.version !== 1) throw new Error("unsupported protocol version");
  if (
    typeof req.id !== "number" ||
    typeof req.session !== "string" ||
    typeof req.method !== "string"
  ) {
    throw new Error("invalid protocol request");
  }
  return req;
}
