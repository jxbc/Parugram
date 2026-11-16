use std::path::{Path, PathBuf};

fn embed_telegram_credentials(out_dir: &Path) {
    println!("cargo:rerun-if-env-changed=PARUGRAM_BUILD_API_ID");
    println!("cargo:rerun-if-env-changed=PARUGRAM_BUILD_API_HASH");
    let id = std::env::var("PARUGRAM_BUILD_API_ID").unwrap_or_default();
    let hash = std::env::var("PARUGRAM_BUILD_API_HASH").unwrap_or_default();
    let (id, hash) = (id.trim(), hash.trim());
    let mut encoded = Vec::new();
    if !id.is_empty() || !hash.is_empty() {
        let api_id = id
            .parse::<i32>()
            .ok()
            .filter(|&value| value > 0)
            .expect("PARUGRAM_BUILD_API_ID must be a positive Telegram API ID");
        assert!(
            hash.len() == 32 && hash.bytes().all(|byte| byte.is_ascii_hexdigit()),
            "PARUGRAM_BUILD_API_HASH must be a 32-digit hexadecimal Telegram API hash"
        );

        let mut mask = [0; 36];
        getrandom::fill(&mut mask).expect("Could not mask Telegram app credentials");
        let payload = api_id.to_le_bytes().into_iter().chain(hash.bytes());
        encoded.extend(mask);
        encoded.extend(payload.zip(mask).map(|(byte, key)| byte ^ key));
    }
    std::fs::write(out_dir.join("telegram-credentials"), encoded)
        .expect("Could not write the bundled Telegram app credentials");
}

fn main() {
    let out_dir = PathBuf::from(std::env::var_os("OUT_DIR").unwrap());
    embed_telegram_credentials(&out_dir);
    let tdlib = out_dir.join("tdlib");
    let lib_dir = tdlib.join("lib");
    let bin_dir = tdlib.join("bin");
    let windows = std::env::var_os("CARGO_CFG_WINDOWS").is_some();
    if windows && lib_dir.join("tdjson.lib").is_file() {
        println!("cargo:rustc-link-search=native={}", lib_dir.display());
        println!("cargo:rustc-link-search=native={}", bin_dir.display());
        println!("cargo:rustc-link-lib=dylib=tdjson");
    } else {
        tdlib_rs::build::build(None);
    }

    if windows {
        let runtime_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/tdlib-runtime");
        std::fs::create_dir_all(&runtime_dir).expect("TDLib runtime directory is unavailable");
        let entries = std::fs::read_dir(bin_dir).expect("TDLib DLL directory is unavailable");
        for entry in entries {
            let entry = entry.expect("Failed to read TDLib runtime entry");
            let path = entry.path();
            if path.extension().is_some_and(|extension| extension == "dll") {
                std::fs::copy(path, runtime_dir.join(entry.file_name()))
                    .expect("Failed to package TDLib runtime");
            }
        }
    }

    tauri_build::build()
}
