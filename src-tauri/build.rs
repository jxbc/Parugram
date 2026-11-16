use std::path::PathBuf;

fn main() {
    let tdlib = PathBuf::from(std::env::var_os("OUT_DIR").unwrap()).join("tdlib");
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
