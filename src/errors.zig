const std = @import("std");

pub const Code = enum(u8) {
    success = 0,
    invalid_arguments = 2,
    browser_unavailable = 10,
    navigation_failed = 11,
    element_not_found = 12,
    stale_ref = 13,
    timeout = 14,
    evaluation_failed = 15,
    protocol_error = 16,
    internal_error = 70,

    pub fn name(self: Code) []const u8 {
        return switch (self) {
            .success => "SUCCESS",
            .invalid_arguments => "INVALID_ARGUMENTS",
            .browser_unavailable => "BROWSER_UNAVAILABLE",
            .navigation_failed => "NAVIGATION_FAILED",
            .element_not_found => "ELEMENT_NOT_FOUND",
            .stale_ref => "STALE_REF",
            .timeout => "TIMEOUT",
            .evaluation_failed => "EVALUATION_FAILED",
            .protocol_error => "PROTOCOL_ERROR",
            .internal_error => "INTERNAL_ERROR",
        };
    }

    pub fn exitStatus(self: Code) u8 {
        return @intFromEnum(self);
    }

    pub fn fromName(value: []const u8) Code {
        inline for (@typeInfo(Code).@"enum".fields) |field| {
            const code: Code = @enumFromInt(field.value);
            if (std.mem.eql(u8, value, code.name())) return code;
        }
        return .internal_error;
    }
};

test "documented exit codes are stable" {
    try std.testing.expectEqual(@as(u8, 0), Code.success.exitStatus());
    try std.testing.expectEqual(@as(u8, 2), Code.invalid_arguments.exitStatus());
    try std.testing.expectEqual(@as(u8, 13), Code.stale_ref.exitStatus());
    try std.testing.expectEqual(Code.element_not_found, Code.fromName("ELEMENT_NOT_FOUND"));
}
