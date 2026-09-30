fn main() {
    // Android 15+ devices may use 16 KB memory pages. NDK r27 links with 4 KB segment
    // alignment by default. This lives here rather than in .cargo/config.toml because the
    // Tauri CLI sets RUSTFLAGS for Android builds, which overrides config rustflags.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android") {
        println!("cargo:rustc-cdylib-link-arg=-Wl,-z,max-page-size=16384");
    }
    // Release builds bake in the public Desktop OAuth client (see docs/google-setup.md).
    println!("cargo:rerun-if-env-changed=READER_GOOGLE_CLIENT_ID");
    println!("cargo:rerun-if-env-changed=READER_GOOGLE_CLIENT_SECRET");
    tauri_build::build()
}
