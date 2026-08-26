const std = @import("std");

pub fn sanitizeAlloc(allocator: std.mem.Allocator, text: []const u8, limit: usize) ![]u8 {
    const n = @min(text.len, limit);
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);
    for (text[0..n]) |c| {
        switch (c) {
            0x1b => try out.appendSlice(allocator, "?"),
            '\r' => try out.appendSlice(allocator, "\\r"),
            else => if (c < 0x20 and c != '\n' and c != '\t') {
                try out.appendSlice(allocator, "?");
            } else {
                try out.append(allocator, c);
            },
        }
    }
    if (text.len > limit) try out.appendSlice(allocator, "\n... truncated\n");
    return out.toOwnedSlice(allocator);
}

test "terminal escapes are sanitized" {
    const got = try sanitizeAlloc(std.testing.allocator, "a\x1b[31mb", 100);
    defer std.testing.allocator.free(got);
    try std.testing.expectEqualStrings("a?[31mb", got);
}
