use std::path::PathBuf;

fn main() {
    let cached = PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("tdlib");
    if std::env::var("CARGO_CFG_WINDOWS").is_ok() && cached.join("lib/tdjson.lib").is_file() {
        println!("cargo:rustc-link-search=native={}", cached.join("lib").display());
        println!("cargo:rustc-link-search=native={}", cached.join("bin").display());
        println!("cargo:rustc-link-lib=dylib=tdjson");
    } else {
        tdlib_rs::build::build(None);
    }

    // На Windows tdjson.dll и его зависимости должны лежать рядом с exe,
    // иначе приложение не найдёт их при запуске. OUT_DIR указывает на
    // target/<profile>/build/<crate>-<hash>/out, поэтому три уровня вверх —
    // это target/<profile>, куда cargo кладёт бинарник.
    if std::env::var("CARGO_CFG_WINDOWS").is_ok() {
        if let Ok(out_dir) = std::env::var("OUT_DIR") {
            let out = PathBuf::from(&out_dir);
            let bin = out.join("tdlib").join("bin");
            let profile_dir = out.ancestors().nth(3).unwrap().to_path_buf();
            let runtime_dir = profile_dir.parent().unwrap().join("tdlib-runtime");
            std::fs::create_dir_all(&runtime_dir).expect("TDLib runtime directory is unavailable");
            if let Ok(entries) = std::fs::read_dir(&bin) {
                for entry in entries.flatten() {
                    if entry.path().extension().is_some_and(|e| e == "dll") {
                        let dest = profile_dir.join(entry.file_name());
                        std::fs::copy(entry.path(), runtime_dir.join(entry.file_name())).expect("Failed to package TDLib runtime");
                        if std::fs::copy(entry.path(), &dest).is_ok() {
                            println!("cargo:warning=copied {} -> {}", entry.path().display(), dest.display());
                        }
                    }
                }
            }
        }
    }

    tauri_build::build()
}
