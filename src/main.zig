const std = @import("std");
const br = @import("br");

pub fn main(init: std.process.Init) !void {
    return br.runner.run(init);
}
