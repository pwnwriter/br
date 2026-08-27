# br — browser CLI built for agents
# Run `just` (no args) to list recipes.

# Bun to use for TypeScript tooling; override with `just bun=/path/to/bun <recipe>`.
bun := "bun"

# List available recipes
default:
    @just --list

# Build the release binary → zig-out/bin/br
build:
    zig build -Doptimize=ReleaseSafe

# Build a debug binary
debug:
    zig build

# Run br with args, e.g. `just run open github.com`
run *args:
    zig build run -- {{args}}

# Run the test suite
test:
    zig build test

# Format Zig and TypeScript in place
fmt:
    zig fmt src build.zig
    {{bun}} x prettier --write "worker/**/*.ts"

# Check formatting without writing (used by CI)
fmt-check:
    zig fmt --check src build.zig
    {{bun}} x prettier --check "worker/**/*.ts"

# Everything CI checks: formatting, build, tests
check: fmt-check build test

# Remove build artifacts
clean:
    rm -rf zig-out .zig-cache
