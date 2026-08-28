const std = @import("std");
const protocol = @import("protocol.zig");
const session = @import("session.zig");

pub const Mode = enum { request, batch, live, record, patch, replay, recipes, recipes_clear, recipes_delete, show, export_recipe, session_list, session_close, session_close_all, daemon_status, daemon_stop, daemon_run, help, version };

const GlobalOption = enum { json, session, profile, backend, help, version };
const RequestOption = enum { compact, format, quality };
const RecipeOption = enum { refresh, pause_on_secret, pause_on_fail, jsonl, yes, all, pane };
const Command = enum {
    batch,
    live,
    record,
    replay,
    recipes,
    show,
    export_cmd,
    patch,
    daemon,
    session,
    open,
    snap,
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
};

pub const Parsed = struct {
    mode: Mode = .request,
    request: protocol.Request = .{ .id = 1, .session = session.default_session, .method = .url },
    close_session: ?[]const u8 = null,
    live_url: ?[]const u8 = null,
    live_refresh: ?[]const u8 = null,
    recipe_name: ?[]const u8 = null,
    recipe_url: ?[]const u8 = null,
    pause_on_secret: bool = false,
    pause_on_fail: bool = false,
    export_jsonl: bool = false,
    assume_yes: bool = false,
    delete_all: bool = false,
    record_pane: bool = false,
};

pub const ParseError = error{InvalidArguments};

pub fn parse(allocator: std.mem.Allocator, args: []const []const u8) !Parsed {
    var parsed = Parsed{};
    var i: usize = 1;
    while (i < args.len and isGlobalOption(args[i])) : (i += 1) {
        switch (parseGlobalOption(args[i]).?) {
            .json => parsed.request.json = true,
            .session => parsed.request.session = try readGlobalValue(args, &i),
            .profile => parsed.request.profile_dir =
                try session.profileDir(allocator, try readGlobalValue(args, &i)),
            .backend => parsed.request.backend = try readGlobalValue(args, &i),
            .help => {
                parsed.mode = .help;
                return parsed;
            },
            .version => {
                parsed.mode = .version;
                return parsed;
            },
        }
    }
    if (i >= args.len) {
        parsed.mode = .help;
        return parsed;
    }

    const command = parseCommand(args[i]) orelse return ParseError.InvalidArguments;
    i += 1;
    switch (command) {
        .batch => parsed.mode = .batch,
        .live => {
            parsed.mode = .live;
            while (i < args.len) {
                if (std.mem.eql(u8, args[i], "--refresh")) {
                    i += 1;
                    if (i >= args.len) return ParseError.InvalidArguments;
                    _ = std.fmt.parseInt(u64, args[i], 10) catch return ParseError.InvalidArguments;
                    parsed.live_refresh = args[i];
                    i += 1;
                } else if (!std.mem.startsWith(u8, args[i], "--")) {
                    parsed.live_url = args[i];
                    i += 1;
                } else return ParseError.InvalidArguments;
            }
        },
        .record, .patch => {
            parsed.mode = if (command == .record) .record else .patch;
            parsed.recipe_name = try readRecipeName(args, &i);
            while (i < args.len) {
                if (std.mem.eql(u8, args[i], "--refresh")) {
                    i += 1;
                    if (i >= args.len) return ParseError.InvalidArguments;
                    _ = std.fmt.parseInt(u64, args[i], 10) catch return ParseError.InvalidArguments;
                    parsed.live_refresh = args[i];
                    i += 1;
                } else if (std.mem.eql(u8, args[i], "--pane") or std.mem.eql(u8, args[i], "--split")) {
                    parsed.record_pane = true;
                    i += 1;
                } else if (!std.mem.startsWith(u8, args[i], "--") and parsed.recipe_url == null) {
                    parsed.recipe_url = args[i];
                    i += 1;
                } else return ParseError.InvalidArguments;
            }
        },
        .replay => {
            parsed.mode = .replay;
            parsed.recipe_name = try readRecipeName(args, &i);
            while (i < args.len) {
                switch (parseRecipeOption(args[i]) orelse return ParseError.InvalidArguments) {
                    .pause_on_secret => parsed.pause_on_secret = true,
                    .pause_on_fail => parsed.pause_on_fail = true,
                    else => return ParseError.InvalidArguments,
                }
                i += 1;
            }
        },
        .recipes => {
            parsed.mode = .recipes;
            if (i < args.len and std.mem.eql(u8, args[i], "clear")) {
                parsed.mode = .recipes_clear;
                i += 1;
                while (i < args.len) {
                    switch (parseRecipeOption(args[i]) orelse return ParseError.InvalidArguments) {
                        .yes => parsed.assume_yes = true,
                        else => return ParseError.InvalidArguments,
                    }
                    i += 1;
                }
                if (!parsed.assume_yes) return ParseError.InvalidArguments;
            } else if (i < args.len and (std.mem.eql(u8, args[i], "delete") or std.mem.eql(u8, args[i], "rm"))) {
                parsed.mode = .recipes_delete;
                i += 1;
                if (i >= args.len) return ParseError.InvalidArguments;
                if (parseRecipeOption(args[i]) == .all) {
                    parsed.delete_all = true;
                    i += 1;
                } else {
                    parsed.recipe_name = try readRecipeName(args, &i);
                }
                if (i != args.len) return ParseError.InvalidArguments;
            } else if (i != args.len) return ParseError.InvalidArguments;
        },
        .show => {
            parsed.mode = .show;
            parsed.recipe_name = try readRecipeName(args, &i);
            if (i != args.len) return ParseError.InvalidArguments;
        },
        .export_cmd => {
            parsed.mode = .export_recipe;
            parsed.recipe_name = try readRecipeName(args, &i);
            while (i < args.len) {
                switch (parseRecipeOption(args[i]) orelse return ParseError.InvalidArguments) {
                    .jsonl => parsed.export_jsonl = true,
                    else => return ParseError.InvalidArguments,
                }
                i += 1;
            }
        },
        .daemon => {
            if (i >= args.len) return ParseError.InvalidArguments;
            parsed.mode = try parseDaemonCommand(args[i]);
            i += 1;
            if (i != args.len) return ParseError.InvalidArguments;
        },
        .session => {
            if (i >= args.len) return ParseError.InvalidArguments;
            parsed.mode = try parseSessionCommand(args, &i, &parsed);
            if (i != args.len) return ParseError.InvalidArguments;
        },
        else => {
            parsed.request.method = try parseRequestCommand(command, args, &i, &parsed.request);
            try parseRequestOptions(args, &i, &parsed.request);
        },
    }
    return parsed;
}

fn parseRequestCommand(cmd: Command, args: []const []const u8, i: *usize, req: *protocol.Request) !protocol.Method {
    return switch (cmd) {
        .open => blk: {
            req.url = try readRequired(args, i);
            break :blk .open;
        },
        .snap, .snapshot => .snapshot,
        .click => blk: {
            req.target = try readRequired(args, i);
            break :blk .click;
        },
        .fill => blk: {
            req.target = try readRequired(args, i);
            req.text = try readRequired(args, i);
            break :blk .fill;
        },
        .type => blk: {
            req.text = try readRequired(args, i);
            break :blk .type;
        },
        .press => blk: {
            req.key = try readRequired(args, i);
            break :blk .press;
        },
        .hover => blk: {
            req.target = try readRequired(args, i);
            break :blk .hover;
        },
        .text => blk: {
            req.target = readOptionalValue(args, i);
            break :blk .text;
        },
        .html => blk: {
            req.target = readOptionalValue(args, i);
            break :blk .html;
        },
        .get => blk: {
            req.target = try readRequired(args, i);
            break :blk .get;
        },
        .attr => blk: {
            req.target = try readRequired(args, i);
            req.attribute = try readRequired(args, i);
            break :blk .attr;
        },
        .value => blk: {
            req.target = try readRequired(args, i);
            break :blk .value;
        },
        .find => blk: {
            req.text = try readRequired(args, i);
            break :blk .find;
        },
        .scroll => blk: {
            req.amount = std.fmt.parseInt(i64, try readRequired(args, i), 10) catch return ParseError.InvalidArguments;
            break :blk .scroll;
        },
        .scroll_to => blk: {
            req.target = try readRequired(args, i);
            break :blk .scroll_to;
        },
        .url => .url,
        .title => .title,
        .back => .back,
        .forward => .forward,
        .reload => .reload,
        .wait => blk: {
            const value = try readRequired(args, i);
            if (std.fmt.parseInt(u64, value, 10)) |ms| req.duration_ms = ms else |_| req.target = value;
            break :blk .wait;
        },
        .eval => blk: {
            req.text = try readRequired(args, i);
            break :blk .eval;
        },
        .screenshot => blk: {
            req.path = readOptionalValue(args, i);
            break :blk .screenshot;
        },
        .view => .view,
        .resize => blk: {
            req.width = std.fmt.parseInt(u32, try readRequired(args, i), 10) catch return ParseError.InvalidArguments;
            req.height = std.fmt.parseInt(u32, try readRequired(args, i), 10) catch return ParseError.InvalidArguments;
            break :blk .resize;
        },
        .cookies => .cookies,
        .console => .console,
        .close => .close,
        .cdp => blk: {
            req.cdp_method = try readRequired(args, i);
            req.cdp_params_raw = readOptionalValue(args, i);
            break :blk .cdp;
        },
        else => return ParseError.InvalidArguments,
    };
}

fn parseRequestOptions(args: []const []const u8, i: *usize, req: *protocol.Request) !void {
    while (i.* < args.len) {
        switch (parseRequestOption(args[i.*]) orelse return ParseError.InvalidArguments) {
            .compact => {
                req.compact = true;
                i.* += 1;
            },
            .format => {
                req.format = try readNext(args, i);
            },
            .quality => {
                req.quality = std.fmt.parseInt(u8, try readNext(args, i), 10) catch return ParseError.InvalidArguments;
            },
        }
    }
}

fn parseDaemonCommand(cmd: []const u8) !Mode {
    if (std.mem.eql(u8, cmd, "status")) return .daemon_status;
    if (std.mem.eql(u8, cmd, "stop")) return .daemon_stop;
    if (std.mem.eql(u8, cmd, "run")) return .daemon_run;
    return ParseError.InvalidArguments;
}

fn parseSessionCommand(args: []const []const u8, i: *usize, parsed: *Parsed) !Mode {
    const value = try readNext(args, i);
    if (std.mem.eql(u8, value, "list")) return .session_list;
    if (std.mem.eql(u8, value, "close-all")) return .session_close_all;
    if (std.mem.eql(u8, value, "close")) {
        const name = try readRequired(args, i);
        if (!session.validateIdentifier(name)) return ParseError.InvalidArguments;
        parsed.close_session = name;
        return .session_close;
    }
    return ParseError.InvalidArguments;
}

fn parseGlobalOption(arg: []const u8) ?GlobalOption {
    if (std.mem.eql(u8, arg, "--json")) return .json;
    if (std.mem.eql(u8, arg, "--session")) return .session;
    if (std.mem.eql(u8, arg, "--profile")) return .profile;
    if (std.mem.eql(u8, arg, "--backend")) return .backend;
    if (std.mem.eql(u8, arg, "--help") or std.mem.eql(u8, arg, "-h")) return .help;
    if (std.mem.eql(u8, arg, "--version")) return .version;
    return null;
}

fn parseRequestOption(arg: []const u8) ?RequestOption {
    if (std.mem.eql(u8, arg, "--compact")) return .compact;
    if (std.mem.eql(u8, arg, "--format")) return .format;
    if (std.mem.eql(u8, arg, "--quality")) return .quality;
    return null;
}

fn parseRecipeOption(arg: []const u8) ?RecipeOption {
    if (std.mem.eql(u8, arg, "--refresh")) return .refresh;
    if (std.mem.eql(u8, arg, "--pause-on-secret")) return .pause_on_secret;
    if (std.mem.eql(u8, arg, "--pause-on-fail")) return .pause_on_fail;
    if (std.mem.eql(u8, arg, "--jsonl")) return .jsonl;
    if (std.mem.eql(u8, arg, "--yes") or std.mem.eql(u8, arg, "-y")) return .yes;
    if (std.mem.eql(u8, arg, "--all")) return .all;
    if (std.mem.eql(u8, arg, "--pane") or std.mem.eql(u8, arg, "--split")) return .pane;
    return null;
}

fn parseCommand(arg: []const u8) ?Command {
    if (std.mem.eql(u8, arg, "snapshot")) return .snapshot;
    if (std.mem.eql(u8, arg, "browse")) return .live;
    if (std.mem.eql(u8, arg, "scroll-to")) return .scroll_to;
    if (std.mem.eql(u8, arg, "export")) return .export_cmd;
    return std.meta.stringToEnum(Command, arg);
}

fn isGlobalOption(arg: []const u8) bool {
    return parseGlobalOption(arg) != null;
}

/// Reads the value following a global flag. `i` points at the flag; the value
/// is the next token. Advances `i` onto the value in place — the caller's loop
/// increment steps past it. Every global value is a session/profile identifier.
fn readGlobalValue(args: []const []const u8, i: *usize) ![]const u8 {
    i.* += 1;
    if (i.* >= args.len) return ParseError.InvalidArguments;
    if (!session.validateIdentifier(args[i.*])) return ParseError.InvalidArguments;
    return args[i.*];
}

fn readNext(args: []const []const u8, i: *usize) ![]const u8 {
    if (i.* >= args.len) return ParseError.InvalidArguments;
    const value = args[i.*];
    i.* += 1;
    return value;
}

fn readRequired(args: []const []const u8, i: *usize) ![]const u8 {
    return readNext(args, i);
}

fn readRecipeName(args: []const []const u8, i: *usize) ![]const u8 {
    const name = try readRequired(args, i);
    if (!session.validateIdentifier(name)) return ParseError.InvalidArguments;
    return name;
}

fn readOptionalValue(args: []const []const u8, i: *usize) ?[]const u8 {
    if (i.* >= args.len) return null;
    if (std.mem.startsWith(u8, args[i.*], "--")) return null;
    const value = args[i.*];
    i.* += 1;
    return value;
}

pub const help =
    \\br - browser CLI built for agents
    \\
    \\Usage:
    \\  br [--json] [--session name] [--profile name] [--backend chrome|webkit] <command>
    \\  br batch
    \\  br live [url] [--refresh <ms>]
    \\  br record <name> [url] [--refresh <ms>] [--pane]
    \\  br replay <name> [--pause-on-secret] [--pause-on-fail]
    \\  br recipes [delete <name>|delete --all|clear --yes]
    \\  br show <name>
    \\  br patch <name> [url] [--refresh <ms>] [--pane]
    \\  br export <name> --jsonl
    \\
    \\Core:
    \\  open <url>                 snap|snapshot [--compact]
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
    \\  live [url] [--refresh ms]  interactive Kitty terminal browser
    \\
    \\Recipes:
    \\  record <name> [url]       teach br a workflow from live browsing
    \\  record <name> --pane      record with an in-terminal log pane
    \\  replay <name>             run a saved workflow
    \\  recipes                   list saved workflows
    \\  recipes delete <name>     delete one saved workflow
    \\  recipes delete --all      delete all saved workflows
    \\  recipes clear --yes       delete all saved workflows
    \\  show <name>               print a saved workflow
    \\  patch <name> [url]        append more live actions to a workflow
    \\  export <name> --jsonl     print workflow JSONL for agents/scripts
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

test "parse record recipe" {
    const args = [_][]const u8{ "br", "record", "yeswehack-login", "yeswehack.com/login", "--refresh", "250", "--pane" };
    const parsed = try parse(std.testing.allocator, &args);
    try std.testing.expectEqual(Mode.record, parsed.mode);
    try std.testing.expectEqualStrings("yeswehack-login", parsed.recipe_name.?);
    try std.testing.expectEqualStrings("yeswehack.com/login", parsed.recipe_url.?);
    try std.testing.expectEqualStrings("250", parsed.live_refresh.?);
    try std.testing.expect(parsed.record_pane);
}

test "parse replay recipe options" {
    const args = [_][]const u8{ "br", "--session", "ywh", "replay", "login", "--pause-on-secret", "--pause-on-fail" };
    const parsed = try parse(std.testing.allocator, &args);
    try std.testing.expectEqual(Mode.replay, parsed.mode);
    try std.testing.expectEqualStrings("login", parsed.recipe_name.?);
    try std.testing.expectEqualStrings("ywh", parsed.request.session);
    try std.testing.expect(parsed.pause_on_secret);
    try std.testing.expect(parsed.pause_on_fail);
}

test "parse recipe commands reject traversal names" {
    const args = [_][]const u8{ "br", "show", "../login" };
    try std.testing.expectError(ParseError.InvalidArguments, parse(std.testing.allocator, &args));
}

test "parse recipes clear requires yes" {
    const bad = [_][]const u8{ "br", "recipes", "clear" };
    try std.testing.expectError(ParseError.InvalidArguments, parse(std.testing.allocator, &bad));

    const good = [_][]const u8{ "br", "recipes", "clear", "--yes" };
    const parsed = try parse(std.testing.allocator, &good);
    try std.testing.expectEqual(Mode.recipes_clear, parsed.mode);
    try std.testing.expect(parsed.assume_yes);
}

test "parse recipes delete one or all" {
    const one_args = [_][]const u8{ "br", "recipes", "delete", "login" };
    const one = try parse(std.testing.allocator, &one_args);
    try std.testing.expectEqual(Mode.recipes_delete, one.mode);
    try std.testing.expectEqualStrings("login", one.recipe_name.?);
    try std.testing.expect(!one.delete_all);

    const all_args = [_][]const u8{ "br", "recipes", "delete", "--all" };
    const all = try parse(std.testing.allocator, &all_args);
    try std.testing.expectEqual(Mode.recipes_delete, all.mode);
    try std.testing.expect(all.delete_all);
}
