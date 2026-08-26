const std = @import("std");

pub const default_session = "default";
pub const max_identifier_len = 64;

pub fn validateIdentifier(value: []const u8) bool {
    if (value.len == 0 or value.len > max_identifier_len) return false;
    for (value) |c| {
        const ok = (c >= 'a' and c <= 'z') or
            (c >= 'A' and c <= 'Z') or
            (c >= '0' and c <= '9') or
            c == '_' or c == '-' or c == '.';
        if (!ok) return false;
    }
    return true;
}

pub fn runtimeDir(allocator: std.mem.Allocator) ![]u8 {
    if (getenv("XDG_RUNTIME_DIR")) |dir| {
        return std.fs.path.join(allocator, &.{ dir, "br" });
    }
    if (getenv("TMPDIR")) |dir| {
        return std.fs.path.join(allocator, &.{ dir, "br-runtime" });
    }
    return std.fs.path.join(allocator, &.{ "/tmp", "br-runtime" });
}

pub fn socketPath(allocator: std.mem.Allocator) ![]u8 {
    const dir = try runtimeDir(allocator);
    defer allocator.free(dir);
    return std.fs.path.join(allocator, &.{ dir, "daemon.sock" });
}

pub fn pidPath(allocator: std.mem.Allocator) ![]u8 {
    const dir = try runtimeDir(allocator);
    defer allocator.free(dir);
    return std.fs.path.join(allocator, &.{ dir, "daemon.pid" });
}

pub fn profileDir(allocator: std.mem.Allocator, profile: []const u8) ![]u8 {
    if (!validateIdentifier(profile)) return error.InvalidIdentifier;
    const home = getenv("HOME") orelse return error.HomeUnavailable;
    return std.fs.path.join(allocator, &.{ home, ".local", "share", "br", "profiles", profile });
}

fn getenv(comptime name: []const u8) ?[]const u8 {
    const raw = std.c.getenv(name ++ "\x00") orelse return null;
    return std.mem.span(raw);
}

test "identifier validation rejects traversal and shell-ish names" {
    try std.testing.expect(validateIdentifier("default"));
    try std.testing.expect(validateIdentifier("github.docs-1"));
    try std.testing.expect(!validateIdentifier(""));
    try std.testing.expect(!validateIdentifier("../x"));
    try std.testing.expect(!validateIdentifier("x/y"));
    try std.testing.expect(!validateIdentifier("x y"));
    try std.testing.expect(!validateIdentifier("$(x)"));
}
