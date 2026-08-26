const std = @import("std");

pub const version: u32 = 1;
pub const max_message_bytes = 8 * 1024 * 1024;

pub const Method = enum {
    open,
    snapshot,
    click,
    fill,
    type,
    press,
    hover,
    text,
    html,
    get,
    attr,
    value,
    find,
    scroll,
    scroll_to,
    url,
    title,
    back,
    forward,
    reload,
    wait,
    eval,
    screenshot,
    view,
    resize,
    cookies,
    console,
    close,
    cdp,

    pub fn wireName(self: Method) []const u8 {
        return switch (self) {
            .open => "open",
            .snapshot => "snapshot",
            .click => "click",
            .fill => "fill",
            .type => "type",
            .press => "press",
            .hover => "hover",
            .text => "text",
            .html => "html",
            .get => "get",
            .attr => "attr",
            .value => "value",
            .find => "find",
            .scroll => "scroll",
            .scroll_to => "scrollTo",
            .url => "url",
            .title => "title",
            .back => "back",
            .forward => "forward",
            .reload => "reload",
            .wait => "wait",
            .eval => "eval",
            .screenshot => "screenshot",
            .view => "view",
            .resize => "resize",
            .cookies => "cookies",
            .console => "console",
            .close => "close",
            .cdp => "cdp",
        };
    }
};

pub const Request = struct {
    id: u64,
    session: []const u8,
    method: Method,
    json: bool = false,
    compact: bool = false,
    url: ?[]const u8 = null,
    target: ?[]const u8 = null,
    text: ?[]const u8 = null,
    key: ?[]const u8 = null,
    attribute: ?[]const u8 = null,
    amount: ?i64 = null,
    duration_ms: ?u64 = null,
    width: ?u32 = null,
    height: ?u32 = null,
    path: ?[]const u8 = null,
    format: ?[]const u8 = null,
    quality: ?u8 = null,
    profile_dir: ?[]const u8 = null,
    backend: ?[]const u8 = null,
    cdp_method: ?[]const u8 = null,
    cdp_params_raw: ?[]const u8 = null,
};

pub fn writeRequest(writer: anytype, req: Request) !void {
    try writer.print(
        "{{\"version\":{},\"id\":{},\"session\":",
        .{ version, req.id },
    );
    try std.json.Stringify.value(req.session, .{}, writer);
    try writer.print(",\"method\":", .{});
    try std.json.Stringify.value(req.method.wireName(), .{}, writer);
    try writer.print(",\"params\":{{", .{});
    var first = true;
    try fieldBool(writer, &first, "json", req.json);
    try fieldBool(writer, &first, "compact", req.compact);
    try fieldString(writer, &first, "url", req.url);
    try fieldString(writer, &first, "target", req.target);
    try fieldString(writer, &first, "text", req.text);
    try fieldString(writer, &first, "key", req.key);
    try fieldString(writer, &first, "attribute", req.attribute);
    try fieldString(writer, &first, "path", req.path);
    try fieldString(writer, &first, "format", req.format);
    try fieldString(writer, &first, "profileDir", req.profile_dir);
    try fieldString(writer, &first, "backend", req.backend);
    try fieldString(writer, &first, "cdpMethod", req.cdp_method);
    if (req.amount) |v| try fieldInt(writer, &first, "amount", v);
    if (req.duration_ms) |v| try fieldInt(writer, &first, "durationMs", v);
    if (req.width) |v| try fieldInt(writer, &first, "width", v);
    if (req.height) |v| try fieldInt(writer, &first, "height", v);
    if (req.quality) |v| try fieldInt(writer, &first, "quality", v);
    if (req.cdp_params_raw) |raw| {
        try comma(writer, &first);
        try writer.print("\"cdpParams\":{s}", .{raw});
    }
    try writer.print("}}}}\n", .{});
}

fn comma(writer: anytype, first: *bool) !void {
    if (first.*) {
        first.* = false;
    } else {
        try writer.print(",", .{});
    }
}

fn fieldBool(writer: anytype, first: *bool, name: []const u8, value: bool) !void {
    if (!value) return;
    try comma(writer, first);
    try writer.print("\"{s}\":{}", .{ name, value });
}

fn fieldString(writer: anytype, first: *bool, name: []const u8, value: ?[]const u8) !void {
    const s = value orelse return;
    try comma(writer, first);
    try writer.print("\"{s}\":", .{name});
    try std.json.Stringify.value(s, .{}, writer);
}

fn fieldInt(writer: anytype, first: *bool, name: []const u8, value: anytype) !void {
    try comma(writer, first);
    try writer.print("\"{s}\":{}", .{ name, value });
}

pub fn classifyResponseError(line: []const u8) ?[]const u8 {
    if (std.mem.indexOf(u8, line, "\"ok\":false") == null) return null;
    if (std.mem.indexOf(u8, line, "\"code\":\"")) |start| {
        const code_start = start + "\"code\":\"".len;
        if (std.mem.indexOfScalarPos(u8, line, code_start, '"')) |end| return line[code_start..end];
    }
    return "INTERNAL_ERROR";
}

test "request jsonl is stable" {
    var buf: [512]u8 = undefined;
    var stream = std.Io.Writer.fixed(&buf);
    try writeRequest(&stream, .{
        .id = 42,
        .session = "default",
        .method = .fill,
        .target = "@1",
        .text = "hello@example.com",
    });
    try std.testing.expectEqualStrings(
        "{\"version\":1,\"id\":42,\"session\":\"default\",\"method\":\"fill\",\"params\":{\"target\":\"@1\",\"text\":\"hello@example.com\"}}\n",
        stream.buffered(),
    );
}
