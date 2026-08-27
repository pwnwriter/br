const std = @import("std");
const cli = @import("cli.zig");
const errors = @import("errors.zig");
const output = @import("output.zig");
const protocol = @import("protocol.zig");
const session = @import("session.zig");

const Io = std.Io;
const Allocator = std.mem.Allocator;
const Code = errors.Code;

const stderr_limit = 64 * 1024;
const ready_attempts = 40;
const ready_poll_ms = 50;

const ping_request =
    "{\"version\":1,\"id\":0,\"session\":\"default\",\"method\":\"ping\",\"params\":{}}\n";
const admin_named =
    "{{\"version\":1,\"id\":1,\"session\":\"default\",\"method\":\"{s}\",\"params\":{{\"name\":\"{s}\",\"json\":{}}}}}\n";
const admin_plain =
    "{{\"version\":1,\"id\":1,\"session\":\"default\",\"method\":\"{s}\",\"params\":{{\"json\":{}}}}}\n";

// A process arena backs every allocation, so nothing is freed by hand.
pub fn run(init: std.process.Init) !void {
    const gpa = init.arena.allocator();
    const io = init.io;
    const args = try init.minimal.args.toSlice(gpa);
    const p = cli.parse(gpa, args) catch fatal(io, .invalid_arguments, false, "invalid arguments\n");

    switch (p.mode) {
        .help => try writeOut(io, cli.help),
        .version => try writeOut(io, "br 0.1.0\n"),
        .daemon_run => try passthrough(io, &.{ bunExe(), try workerScript(gpa, "main.ts"), "--server" }),
        .daemon_status => try writeOut(io, if (pingDaemon(gpa, io, try session.socketPath(gpa))) "running\n" else "stopped\n"),
        .daemon_stop => try sendAdmin(gpa, io, false, "daemonStop", null),
        .session_list => try sendAdmin(gpa, io, p.request.json, "sessionList", null),
        .session_close => try sendAdmin(gpa, io, p.request.json, "sessionClose", p.close_session),
        .session_close_all => try sendAdmin(gpa, io, p.request.json, "sessionCloseAll", null),
        .batch => try passthrough(io, &.{ bunExe(), try workerScript(gpa, "client.ts"), "--batch", try ensureDaemon(gpa, io), p.request.session }),
        .live => try runLive(gpa, io, p.live_url, p.live_refresh),
        .request => try runRequest(gpa, io, p.request),
    }
}

fn runRequest(gpa: Allocator, io: Io, req: protocol.Request) !void {
    if (req.profile_dir) |dir| Io.Dir.cwd().createDirPath(io, dir) catch {};
    const sock = try ensureDaemon(gpa, io);

    var body: Io.Writer.Allocating = .init(gpa);
    try protocol.writeRequest(&body.writer, req);
    const result = try callClient(gpa, io, sock, body.written());
    if (result.stderr.len > 0) try writeErr(io, result.stderr);

    const failed = switch (result.term) {
        .exited => |code| code != 0,
        else => true,
    };
    // `view` emits raw Kitty graphics; every other reply is sanitized text.
    const out = if (req.method == .view and !req.json)
        result.stdout
    else
        try output.sanitizeAlloc(gpa, result.stdout, protocol.max_message_bytes);
    try writeOut(io, out);
    if (failed and out.len == 0) fatal(io, .protocol_error, req.json, "protocol client failed\n");
    exitOnResponseError(out);
}

fn sendAdmin(gpa: Allocator, io: Io, json: bool, method: []const u8, name: ?[]const u8) !void {
    const sock = try ensureDaemon(gpa, io);
    const request = if (name) |n|
        try std.fmt.allocPrint(gpa, admin_named, .{ method, n, json })
    else
        try std.fmt.allocPrint(gpa, admin_plain, .{ method, json });
    const result = try callClient(gpa, io, sock, request);
    try writeOut(io, result.stdout);
}

fn runLive(gpa: Allocator, io: Io, url: ?[]const u8, refresh: ?[]const u8) !void {
    var argv: std.ArrayList([]const u8) = .empty;
    try argv.append(gpa, bunExe());
    try argv.append(gpa, try workerScript(gpa, "live.ts"));
    if (url) |u| try argv.append(gpa, u);
    if (refresh) |r| {
        try argv.append(gpa, "--refresh");
        try argv.append(gpa, r);
    }
    try passthrough(io, argv.items);
}

/// Ensures the browser daemon is running and returns its socket path.
fn ensureDaemon(gpa: Allocator, io: Io) ![]const u8 {
    const sock = try session.socketPath(gpa);
    if (pingDaemon(gpa, io, sock)) return sock;

    Io.Dir.cwd().createDirPath(io, try session.runtimeDir(gpa)) catch {};
    _ = std.process.spawn(io, .{
        .argv = &.{ bunExe(), try workerScript(gpa, "main.ts"), "--server", sock },
        .stdin = .ignore,
        .stdout = .ignore,
        .stderr = .inherit,
    }) catch fatal(io, .browser_unavailable, false, "Bun is required. Install Bun >= 1.4 with Bun.WebView support.\n");

    var attempts: usize = 0;
    while (attempts < ready_attempts) : (attempts += 1) {
        io.vtable.sleep(io.userdata, .{ .duration = .{ .raw = .fromMilliseconds(ready_poll_ms), .clock = .awake } }) catch {};
        if (pingDaemon(gpa, io, sock)) return sock;
    }
    fatal(io, .browser_unavailable, false, "browser daemon did not become ready\n");
}

fn pingDaemon(gpa: Allocator, io: Io, sock: []const u8) bool {
    const result = callClient(gpa, io, sock, ping_request) catch return false;
    return switch (result.term) {
        .exited => |code| code == 0 and std.mem.indexOf(u8, result.stdout, "\"ok\":true") != null,
        else => false,
    };
}

fn callClient(gpa: Allocator, io: Io, sock: []const u8, line: []const u8) !std.process.RunResult {
    return std.process.run(gpa, io, .{
        .argv = &.{ bunExe(), try workerScript(gpa, "client.ts"), sock, line },
        .stdout_limit = .limited(protocol.max_message_bytes),
        .stderr_limit = .limited(stderr_limit),
    });
}

/// Spawns Bun with the terminal attached and mirrors its exit code.
fn passthrough(io: Io, argv: []const []const u8) !void {
    var child = try std.process.spawn(io, .{ .argv = argv, .stdin = .inherit, .stdout = .inherit, .stderr = .inherit });
    switch (try child.wait(io)) {
        .exited => |code| std.process.exit(code),
        else => std.process.exit(Code.internal_error.exitStatus()),
    }
}

fn exitOnResponseError(line: []const u8) void {
    if (protocol.classifyResponseError(line)) |name| std.process.exit(Code.fromName(name).exitStatus());
}

fn writeOut(io: Io, bytes: []const u8) !void {
    return writeAll(io, .stdout(), bytes);
}

fn writeErr(io: Io, bytes: []const u8) !void {
    return writeAll(io, .stderr(), bytes);
}

fn writeAll(io: Io, file: Io.File, bytes: []const u8) !void {
    var buf: [8192]u8 = undefined;
    var w: Io.File.Writer = .init(file, io, &buf);
    try w.interface.writeAll(bytes);
    try w.interface.flush();
}

fn fatal(io: Io, code: Code, json: bool, message: []const u8) noreturn {
    if (json) {
        var buf: [8192]u8 = undefined;
        var w: Io.File.Writer = .init(.stdout(), io, &buf);
        w.interface.print("{{\"ok\":false,\"error\":{{\"code\":\"{s}\",\"message\":", .{code.name()}) catch {};
        std.json.Stringify.value(message, .{}, &w.interface) catch {};
        w.interface.writeAll("}}\n") catch {};
        w.interface.flush() catch {};
    } else writeErr(io, message) catch {};
    std.process.exit(code.exitStatus());
}

fn bunExe() []const u8 {
    if (std.c.getenv("BR_BUN")) |raw| return std.mem.span(raw);
    return "bun";
}

fn workerScript(gpa: Allocator, name: []const u8) ![]const u8 {
    const dir = if (std.c.getenv("BR_WORKER_DIR")) |raw| std.mem.span(raw) else "worker";
    return std.fs.path.join(gpa, &.{ dir, name });
}
