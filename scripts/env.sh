# Source this before building or testing. Agave 4.3.2 for this repo only, so other projects on
# this machine keep their own toolchains. Builds stay on two threads to be gentle on the machine.
export PATH="$HOME/.local/share/solana/install/releases/4.3.2/solana-release/bin:$PATH"
export CARGO_BUILD_JOBS=2

