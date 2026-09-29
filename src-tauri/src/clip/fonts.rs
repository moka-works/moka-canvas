//! The faces the burn-in is written in.
//!
//! Words must leave the app looking like words on every machine, not only on
//! the ones whose owner happens to have the right fonts installed: libass is
//! handed a directory of faces beside its script, and the family names the
//! script asks for are the ones these files carry. Inter answers for the
//! Latin scripts the picker offers; Noto Sans SC — instanced from the variable
//! face to a plain Regular, so its name reads the way the renderer matches —
//! answers for Chinese and everything else that reaches past Latin.
//!
//! Both are SIL Open Font License works, vendored with their licenses beside
//! them in `assets/fonts`. The reserved name in Noto Sans SC's license is
//! 'Source', which the family kept here does not carry.

use std::path::Path;

/// The directory, inside a render's scratch space, the faces are written into;
/// the graph names it as the `ass` filter's `fontsdir`.
pub const FONTS_DIR: &str = "fonts";

/// The family a Latin-only style falls back to when its stack names no family
/// a renderer could be asked for.
pub const LATIN_FAMILY: &str = "Inter";

/// The family every block that reaches past Latin scripts is written in.
pub const CJK_FAMILY: &str = "Noto Sans SC";

/// What travels with the app, as (file name, bytes).
const BUNDLED: [(&str, &[u8]); 2] = [
    (
        "Inter-Regular.ttf",
        include_bytes!("../../assets/fonts/Inter-Regular.ttf"),
    ),
    (
        "NotoSansSC-Regular.ttf",
        include_bytes!("../../assets/fonts/NotoSansSC-Regular.ttf"),
    ),
];

/// Writes every bundled face into `dir`, making the directory first.
pub fn install(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    for (name, bytes) in BUNDLED {
        std::fs::write(dir.join(name), bytes)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installing_writes_every_bundled_face_whole() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join(FONTS_DIR);
        install(&dir).expect("the faces land");
        for (name, bytes) in BUNDLED {
            assert!(!bytes.is_empty(), "{name} carries bytes");
            let written = std::fs::read(dir.join(name)).expect("a face is there");
            assert_eq!(written, bytes, "{name} lands byte for byte");
        }
    }
}
