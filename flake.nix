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
          nativeBuildInputs = [ pkgs.zig pkgs.bun pkgs.makeWrapper ];
          buildPhase = "zig build -Doptimize=ReleaseSafe";
          installPhase = ''
            mkdir -p $out/bin $out/share/br
            cp zig-out/bin/br $out/bin/br
            cp -R worker $out/share/br/worker
            wrapProgram $out/bin/br \
              --set BR_WORKER_DIR $out/share/br/worker \
              --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.bun ]}
          '';
        };

        devShells.default = pkgs.mkShell {
          packages = [ pkgs.zig pkgs.bun ];
          shellHook = ''
            echo "DevShell🚀: initiated"
          '';
        };
      });
}
