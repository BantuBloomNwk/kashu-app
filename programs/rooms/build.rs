// The on-chain security.txt reads its values from SECURITY_TXT.env at the repo root, so anyone rebuilding
// from the repo (a verified build) gets byte-identical output without needing any environment set.
use std::fs;

fn main() {
    // read where the repo is now (not where this script was compiled), so a build in Docker finds it too
    let path = format!("{}/../../SECURITY_TXT.env", std::env::var("CARGO_MANIFEST_DIR").expect("cargo sets this"));
    println!("cargo:rerun-if-changed={path}");
    let text = fs::read_to_string(&path).expect("SECURITY_TXT.env at the repo root");
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else { continue };
        if key.starts_with("KASHU_") {
            println!("cargo:rustc-env={}={}", key.trim(), value.trim().trim_matches('"'));
        }
    }
}
