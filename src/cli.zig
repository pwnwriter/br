const std = @import("std");
const protocol = @import("protocol.zig");
const session = @import("session.zig");

pub const Mode = enum { request, batch, live, session_list, session_close, session_close_all, daemon_status, daemon_stop, daemon_run, help, version };

pub const Parsed = struct {
    mode: Mode = .request,
    request: protocol.Request = .{ .id = 1, .session = session.default_session, .method = .url },
    close_session: ?[]const u8 = null,
    live_url: ?[]const u8 = null,
};

pub const ParseError = error{InvalidArguments};

pub fn parse(allocator: std.mem.Allocator, args: []const []const u8) !Parsed {
    var parsed = Parsed{};
    var i: usize = 1;
    while (i < args.len and std.mem.startsWith(u8, args[i], "--")) : (i += 1) {
        const arg = args[i];
        if (std.mem.eql(u8, arg, "--json")) parsed.request.json = true else if (std.mem.eql(u8, arg, "--session")) {
            i += 1;
            if (i >= args.len or !session.validateIdentifier(args[i])) return ParseError.InvalidArguments;
            parsed.request.session = args[i];
        } else if (std.mem.eql(u8, arg, "--profile")) {
            i += 1;
            if (i >= args.len or !session.validateIdentifier(args[i])) return ParseError.InvalidArguments;
            parsed.request.profile_dir = try session.profileDir(allocator, args[i]);
        } else if (std.mem.eql(u8, arg, "--help") or std.mem.eql(u8, arg, "-h")) {
            parsed.mode = .help;
            return parsed;
        } else if (std.mem.eql(u8, arg, "--version")) {
            parsed.mode = .version;
            return parsed;
        } else return ParseError.InvalidArguments;
    }
    if (i >= args.len) {
        parsed.mode = .help;
        return parsed;
    }

    const cmd = args[i];
    i += 1;
    if (std.mem.eql(u8, cmd, "batch")) {
        parsed.mode = .batch;
    } else if (std.mem.eql(u8, cmd, "live") or std.mem.eql(u8, cmd, "browse")) {
        parsed.mode = .live;
        if (i < args.len) {
            parsed.live_url = args[i];
            i += 1;
        }
        if (i != args.len) return ParseError.InvalidArguments;
    } else if (std.mem.eql(u8, cmd, "daemon")) {
        if (i >= args.len) return ParseError.InvalidArguments;
        if (std.mem.eql(u8, args[i], "status")) parsed.mode = .daemon_status else if (std.mem.eql(u8, args[i], "stop")) parsed.mode = .daemon_stop else if (std.mem.eql(u8, args[i], "run")) parsed.mode = .daemon_run else return ParseError.InvalidArguments;
    } else if (std.mem.eql(u8, cmd, "session")) {
        if (i >= args.len) return ParseError.InvalidArguments;
        if (std.mem.eql(u8, args[i], "list")) parsed.mode = .session_list else if (std.mem.eql(u8, args[i], "close-all")) parsed.mode = .session_close_all else if (std.mem.eql(u8, args[i], "close")) {
            i += 1;
            if (i >= args.len or !session.validateIdentifier(args[i])) return ParseError.InvalidArguments;
            parsed.mode = .session_close;
            parsed.close_session = args[i];
        } else return ParseError.InvalidArguments;
    } else {
        parsed.request.method = try parseRequestCommand(cmd, args, &i, &parsed.request);
        while (i < args.len) : (i += 1) {
            if (std.mem.eql(u8, args[i], "--compact")) parsed.request.compact = true else if (std.mem.eql(u8, args[i], "--interactive")) parsed.request.interactive = true else if (std.mem.eql(u8, args[i], "--format")) {
                i += 1;
                if (i >= args.len) return ParseError.InvalidArguments;
                parsed.request.format = args[i];
            } else if (std.mem.eql(u8, args[i], "--quality")) {
                i += 1;
                if (i >= args.len) return ParseError.InvalidArguments;
                parsed.request.quality = std.fmt.parseInt(u8, args[i], 10) catch return ParseError.InvalidArguments;
            } else return ParseError.InvalidArguments;
        }
    }
    return parsed;
}

fn parseRequestCommand(cmd: []const u8, args: []const []const u8, i: *usize, req: *protocol.Request) !protocol.Method {
    if (std.mem.eql(u8, cmd, "open")) {
        req.url = try need(args, i);
        return .open;
    } else if (std.mem.eql(u8, cmd, "snap") or std.mem.eql(u8, cmd, "snapshot")) return .snapshot else if (std.mem.eql(u8, cmd, "click")) {
        req.target = try need(args, i);
        return .click;
    } else if (std.mem.eql(u8, cmd, "fill")) {
        req.target = try need(args, i);
        req.text = try need(args, i);
        return .fill;
    } else if (std.mem.eql(u8, cmd, "type")) {
        req.text = try need(args, i);
        return .type;
    } else if (std.mem.eql(u8, cmd, "press")) {
        req.key = try need(args, i);
        return .press;
    } else if (std.mem.eql(u8, cmd, "hover")) {
        req.target = try need(args, i);
        return .hover;
    } else if (std.mem.eql(u8, cmd, "text")) {
        if (i.* < args.len and !std.mem.startsWith(u8, args[i.*], "--")) req.target = args[i.*];
        if (req.target != null) i.* += 1;
        return .text;
    } else if (std.mem.eql(u8, cmd, "html")) {
        if (i.* < args.len and !std.mem.startsWith(u8, args[i.*], "--")) req.target = args[i.*];
        if (req.target != null) i.* += 1;
        return .html;
    } else if (std.mem.eql(u8, cmd, "get")) {
        req.target = try need(args, i);
        return .get;
    } else if (std.mem.eql(u8, cmd, "attr")) {
        req.target = try need(args, i);
        req.attribute = try need(args, i);
        return .attr;
    } else if (std.mem.eql(u8, cmd, "value")) {
        req.target = try need(args, i);
        return .value;
    } else if (std.mem.eql(u8, cmd, "find")) {
        req.text = try need(args, i);
        return .find;
    } else if (std.mem.eql(u8, cmd, "scroll")) {
        req.amount = std.fmt.parseInt(i64, try need(args, i), 10) catch return ParseError.InvalidArguments;
        return .scroll;
    } else if (std.mem.eql(u8, cmd, "scroll-to")) {
        req.target = try need(args, i);
        return .scroll_to;
    } else if (std.mem.eql(u8, cmd, "url")) return .url else if (std.mem.eql(u8, cmd, "title")) return .title else if (std.mem.eql(u8, cmd, "back")) return .back else if (std.mem.eql(u8, cmd, "forward")) return .forward else if (std.mem.eql(u8, cmd, "reload")) return .reload else if (std.mem.eql(u8, cmd, "wait")) {
        const value = try need(args, i);
        if (std.fmt.parseInt(u64, value, 10)) |ms| req.duration_ms = ms else |_| req.target = value;
        return .wait;
    } else if (std.mem.eql(u8, cmd, "eval")) {
        req.text = try need(args, i);
        return .eval;
    } else if (std.mem.eql(u8, cmd, "screenshot")) {
        if (i.* < args.len and !std.mem.startsWith(u8, args[i.*], "--")) {
            req.path = args[i.*];
            i.* += 1;
        }
        return .screenshot;
    } else if (std.mem.eql(u8, cmd, "view")) {
        return .view;
    } else if (std.mem.eql(u8, cmd, "resize")) {
        req.width = std.fmt.parseInt(u32, try need(args, i), 10) catch return ParseError.InvalidArguments;
        req.height = std.fmt.parseInt(u32, try need(args, i), 10) catch return ParseError.InvalidArguments;
        return .resize;
    } else if (std.mem.eql(u8, cmd, "cookies")) return .cookies else if (std.mem.eql(u8, cmd, "console")) return .console else if (std.mem.eql(u8, cmd, "close")) return .close else if (std.mem.eql(u8, cmd, "cdp")) {
        req.cdp_method = try need(args, i);
        if (i.* < args.len) {
            req.cdp_params_raw = args[i.*];
            i.* += 1;
        }
        return .cdp;
    }
    return ParseError.InvalidArguments;
}

fn need(args: []const []const u8, i: *usize) ![]const u8 {
    if (i.* >= args.len) return ParseError.InvalidArguments;
    const value = args[i.*];
    i.* += 1;
    return value;
}

pub const help =
    \\br - browser CLI built for agents
    \\
    \\Usage:
    \\  br [--json] [--session name] [--profile name] <command>
    \\  br batch
    \\  br live [url]
    \\
    \\Core:
    \\  open <url>                 snap|snapshot [--compact] [--interactive]
    \\  click <ref|selector>       fill <ref|selector> <text>
    \\  type <text>                press <key>                hover <ref|selector>
    \\  text [ref|selector]        html [ref|selector]        get <ref|selector>
    \\  attr <ref|selector> <attr> value <ref|selector>       find <text>
    \\  scroll <amount>            scroll-to <ref|selector>
    \\  url                        title                      back|forward|reload
    \\  wait <selector|ms>          eval <javascript>
    \\  screenshot [path] [--format png|jpeg|webp] [--quality 0-100]
    \\  view                       render viewport with Kitty graphics
    \\  resize <width> <height>    cookies                    console
    \\  close
    \\  live [url]                 interactive Kitty terminal browser
    \\
    \\Admin:
    \\  session list|close <name>|close-all
    \\  daemon status|stop
    \\
;

test "parse compact snapshot" {
    const args = [_][]const u8{ "br", "--json", "--session", "docs", "snap", "--compact" };
    const parsed = try parse(std.testing.allocator, &args);
    try std.testing.expectEqual(protocol.Method.snapshot, parsed.request.method);
    try std.testing.expect(parsed.request.json);
    try std.testing.expect(parsed.request.compact);
    try std.testing.expectEqualStrings("docs", parsed.request.session);
}

test "parse rejects bad profile" {
    const args = [_][]const u8{ "br", "--profile", "../x", "url" };
    try std.testing.expectError(ParseError.InvalidArguments, parse(std.testing.allocator, &args));
}
