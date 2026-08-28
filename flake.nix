{
  description = "br - a browser CLI built for agents";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
      in
      {
        packages.default = pkgs.stdenv.mkDerivation {
          pname = "br";
          version = "0.1.0";
          src = ./.;
          # Bun is not pinned from nixpkgs for now; CI installs the latest via
          # `curl -fsSL https://bun.sh/install | bash`. Restore /* pkgs.bun */
          # below (and the PATH prefix in installPhase) to bundle it again.
          nativeBuildInputs = [ pkgs.zig pkgs.makeWrapper /* pkgs.bun */ ];
          buildPhase = "zig build -Doptimize=ReleaseSafe";
          installPhase = ''
            mkdir -p $out/bin $out/share/br
            cp zig-out/bin/br $out/bin/br
            cp -R worker $out/share/br/worker
            # Bun not bundled for now; br finds it via $BR_BUN or `bun` on PATH.
            # Previously appended: --prefix PATH : <makeBinPath [ pkgs.bun ]>
            wrapProgram $out/bin/br \
              --set BR_WORKER_DIR $out/share/br/worker
          '';
        };

        devShells.default = pkgs.mkShell {
          # Bun from nixpkgs is commented out for now; install the latest with
          # `curl -fsSL https://bun.sh/install | bash` or point $BR_BUN at it.
          packages = [ pkgs.zig /* pkgs.bun */ ];
          shellHook = ''
            # Prefer a repo-local Bun checked into .tools/<platform>/ (gitignored)
            # so the devShell works without a system Bun. Prepend its dir to PATH.
            for d in "$PWD"/.tools/*/; do
              if [ -x "$d/bun" ]; then
                export PATH="$d:$PATH"
                export BR_BUN="$d/bun"
                break
              fi
            done
            # Put the built br on PATH if it exists, so `br` works from anywhere
            # in the repo without the ./zig-out/bin/ prefix. Run `zig build` first.
            if [ -x "$PWD/zig-out/bin/br" ]; then
              export PATH="$PWD/zig-out/bin:$PATH"
            fi
            if command -v bun >/dev/null 2>&1; then
              echo "DevShell🚀: bun $(bun --version) ($(command -v bun))"
            else
              echo "DevShell🚀: initiated (Bun not bundled; use \$BR_BUN or PATH)"
            fi
          '';
        };
      });
}
