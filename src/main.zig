const std = @import("std");
const br = @import("br");

const Io = std.Io;

pub fn main(init: std.process.Init) !void {
    const allocator = init.arena.allocator();
    const io = init.io;
    const args = try init.minimal.args.toSlice(allocator);

    const parsed = br.cli.parse(allocator, args) catch {
        try fatal(io, br.errors.Code.invalid_arguments, false, "invalid arguments\n");
    };

    switch (parsed.mode) {
        .help => try writeOut(io, br.cli.help),
        .version => try writeOut(io, "br 0.1.0\n"),
        .daemon_run => {
            const worker = try workerScript(allocator, "main.ts");
            try runBunPassthrough(allocator, io, &.{ bunExe(), worker, "--server" });
        },
        .daemon_status => try daemonStatus(allocator, io),
        .daemon_stop => try daemonStop(allocator, io),
        .session_list => try sendAdmin(allocator, io, parsed.request.json, "sessionList", null),
        .session_close => try sendAdmin(allocator, io, parsed.request.json, "sessionClose", parsed.close_session),
        .session_close_all => try sendAdmin(allocator, io, parsed.request.json, "sessionCloseAll", null),
        .batch => try runBatchClient(allocator, io, parsed.request.session),
        .live => try runLive(allocator, io, parsed.live_url),
        .request => try runRequest(allocator, io, parsed.request),
    }
}

fn runRequest(allocator: std.mem.Allocator, io: Io, req: br.protocol.Request) !void {
    if (req.profile_dir) |dir| std.Io.Dir.cwd().createDirPath(io, dir) catch {};
    try ensureDaemon(allocator, io);
    const sock = try br.session.socketPath(allocator);
    defer allocator.free(sock);

    var req_buf: [4096]u8 = undefined;
    var req_writer = Io.Writer.fixed(&req_buf);
    try br.protocol.writeRequest(&req_writer, req);
    const request_line = req_writer.buffered();

    const result = try std.process.run(allocator, io, .{
        .argv = &.{ bunExe(), try workerScript(allocator, "client.ts"), sock, request_line },
        .stdout_limit = .limited(br.protocol.max_message_bytes),
        .stderr_limit = .limited(64 * 1024),
    });
    defer allocator.free(result.stdout);
    defer allocator.free(result.stderr);

    if (result.stderr.len > 0) try writeErr(io, result.stderr);
    switch (result.term) {
        .exited => |code| if (code != 0) {
            if (result.stdout.len > 0) {
                try writeOut(io, result.stdout);
                if (br.protocol.classifyResponseError(result.stdout)) |code_name| {
                    std.process.exit(br.errors.Code.fromName(code_name).exitStatus());
                }
            }
            try fatal(io, br.errors.Code.protocol_error, req.json, "protocol client failed\n");
        },
        else => try fatal(io, br.errors.Code.protocol_error, req.json, "protocol client terminated\n"),
    }
    if (req.method == .view and !req.json) {
        try writeOut(io, result.stdout);
        return;
    }
    const sanitized = try br.output.sanitizeAlloc(allocator, result.stdout, br.protocol.max_message_bytes);
    defer allocator.free(sanitized);
    try writeOut(io, sanitized);
    if (br.protocol.classifyResponseError(sanitized)) |code_name| {
        std.process.exit(br.errors.Code.fromName(code_name).exitStatus());
    }
}

fn ensureDaemon(allocator: std.mem.Allocator, io: Io) !void {
    const sock = try br.session.socketPath(allocator);
    defer allocator.free(sock);
    if (pingDaemon(allocator, io, sock)) return;

    const dir = try br.session.runtimeDir(allocator);
    defer allocator.free(dir);
    std.Io.Dir.cwd().createDirPath(io, dir) catch {};

    const child = std.process.spawn(io, .{
        .argv = &.{ bunExe(), try workerScript(allocator, "main.ts"), "--server", sock },
        .stdin = .ignore,
        .stdout = .ignore,
        .stderr = .inherit,
    }) catch try fatal(io, br.errors.Code.browser_unavailable, false, "Bun is required. Install Bun >= 1.4 with Bun.WebView support.\n");
    _ = child;

    var attempts: usize = 0;
    while (attempts < 40) : (attempts += 1) {
        io.vtable.sleep(io.userdata, .{ .duration = .{ .raw = .fromMilliseconds(50), .clock = .awake } }) catch {};
        if (pingDaemon(allocator, io, sock)) return;
    }
    try fatal(io, br.errors.Code.browser_unavailable, false, "browser daemon did not become ready\n");
}

fn pingDaemon(allocator: std.mem.Allocator, io: Io, sock: []const u8) bool {
    const client = workerScript(allocator, "client.ts") catch return false;
    const result = std.process.run(allocator, io, .{
        .argv = &.{ bunExe(), client, sock, "{\"version\":1,\"id\":0,\"session\":\"default\",\"method\":\"ping\",\"params\":{}}\n" },
        .stdout_limit = .limited(4096),
        .stderr_limit = .limited(4096),
    }) catch return false;
    defer allocator.free(result.stdout);
    defer allocator.free(result.stderr);
    return switch (result.term) {
        .exited => |code| code == 0 and std.mem.indexOf(u8, result.stdout, "\"ok\":true") != null,
        else => false,
    };
}

fn sendAdmin(allocator: std.mem.Allocator, io: Io, json: bool, method: []const u8, value: ?[]const u8) !void {
    try ensureDaemon(allocator, io);
    const sock = try br.session.socketPath(allocator);
    defer allocator.free(sock);
    const request = if (value) |v|
        try std.fmt.allocPrint(allocator, "{{\"version\":1,\"id\":1,\"session\":\"default\",\"method\":\"{s}\",\"params\":{{\"name\":\"{s}\",\"json\":{}}}}}\n", .{ method, v, json })
    else
        try std.fmt.allocPrint(allocator, "{{\"version\":1,\"id\":1,\"session\":\"default\",\"method\":\"{s}\",\"params\":{{\"json\":{}}}}}\n", .{ method, json });
    defer allocator.free(request);
    const result = try std.process.run(allocator, io, .{
        .argv = &.{ bunExe(), try workerScript(allocator, "client.ts"), sock, request },
        .stdout_limit = .limited(br.protocol.max_message_bytes),
        .stderr_limit = .limited(64 * 1024),
    });
    defer allocator.free(result.stdout);
    defer allocator.free(result.stderr);
    try writeOut(io, result.stdout);
}

fn daemonStatus(allocator: std.mem.Allocator, io: Io) !void {
    const sock = try br.session.socketPath(allocator);
    defer allocator.free(sock);
    if (pingDaemon(allocator, io, sock)) try writeOut(io, "running\n") else try writeOut(io, "stopped\n");
}

fn daemonStop(allocator: std.mem.Allocator, io: Io) !void {
    try sendAdmin(allocator, io, false, "daemonStop", null);
}

fn runBatchClient(allocator: std.mem.Allocator, io: Io, sess: []const u8) !void {
    try ensureDaemon(allocator, io);
    const sock = try br.session.socketPath(allocator);
    defer allocator.free(sock);
    try runBunPassthrough(allocator, io, &.{ bunExe(), try workerScript(allocator, "client.ts"), "--batch", sock, sess });
}

fn runLive(allocator: std.mem.Allocator, io: Io, url: ?[]const u8) !void {
    if (url) |u| {
        try runBunPassthrough(allocator, io, &.{ bunExe(), try workerScript(allocator, "live.ts"), u });
    } else {
        try runBunPassthrough(allocator, io, &.{ bunExe(), try workerScript(allocator, "live.ts") });
    }
}

fn runBunPassthrough(allocator: std.mem.Allocator, io: Io, argv: []const []const u8) !void {
    _ = allocator;
    var child = try std.process.spawn(io, .{
        .argv = argv,
        .stdin = .inherit,
        .stdout = .inherit,
        .stderr = .inherit,
    });
    const term = try child.wait(io);
    switch (term) {
        .exited => |code| std.process.exit(code),
        else => std.process.exit(br.errors.Code.internal_error.exitStatus()),
    }
}

fn writeOut(io: Io, bytes: []const u8) !void {
    var buf: [8192]u8 = undefined;
    var file_writer: Io.File.Writer = .init(.stdout(), io, &buf);
    try file_writer.interface.writeAll(bytes);
    try file_writer.interface.flush();
}

fn writeErr(io: Io, bytes: []const u8) !void {
    var buf: [8192]u8 = undefined;
    var file_writer: Io.File.Writer = .init(.stderr(), io, &buf);
    try file_writer.interface.writeAll(bytes);
    try file_writer.interface.flush();
}

fn fatal(io: Io, code: br.errors.Code, json: bool, message: []const u8) noreturn {
    if (json) {
        var buf: [8192]u8 = undefined;
        var file_writer: Io.File.Writer = .init(.stdout(), io, &buf);
        file_writer.interface.print("{{\"ok\":false,\"error\":{{\"code\":\"{s}\",\"message\":", .{code.name()}) catch {};
        std.json.Stringify.value(message, .{}, &file_writer.interface) catch {};
        file_writer.interface.writeAll("}}\n") catch {};
        file_writer.interface.flush() catch {};
    } else {
        writeErr(io, message) catch {};
    }
    std.process.exit(code.exitStatus());
}

fn bunExe() []const u8 {
    if (std.c.getenv("BR_BUN")) |raw| return std.mem.span(raw);
    return "bun";
}

fn workerScript(allocator: std.mem.Allocator, name: []const u8) ![]const u8 {
    if (std.c.getenv("BR_WORKER_DIR")) |raw| {
        return std.fs.path.join(allocator, &.{ std.mem.span(raw), name });
    }
    return std.fs.path.join(allocator, &.{ "worker", name });
}
