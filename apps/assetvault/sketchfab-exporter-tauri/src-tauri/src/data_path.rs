use std::io;
use std::path::{Path, PathBuf};

/// 保留旧路径的目录链接，让历史下载记录中的绝对路径继续有效。
pub fn resolve(legacy: &Path) -> io::Result<PathBuf> {
    let next = legacy.parent().ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "用户数据目录无父目录"))?.join("AssetVault");
    if legacy == next {
        return Ok(next);
    }
    if next.exists() {
        if legacy.exists() && std::fs::canonicalize(legacy)? != std::fs::canonicalize(&next)? {
            // 两个独立目录不自动合并，避免覆盖用户数据。
            eprintln!("新旧数据目录同时存在，继续使用旧目录：{}", legacy.display());
            return Ok(legacy.to_path_buf());
        }
        return Ok(next);
    }
    if !legacy.exists() {
        std::fs::create_dir_all(&next)?;
        return Ok(next);
    }
    if let Err(error) = std::fs::rename(legacy, &next) {
        eprintln!("数据目录正在使用或无法迁移，继续使用旧目录：{error}");
        return Ok(legacy.to_path_buf());
    }
    if let Err(error) = link_legacy(legacy, &next) {
        // 兼容链接失败时回滚，不能留下路径失效的下载记录。
        std::fs::rename(&next, legacy)?;
        eprintln!("建立旧数据路径兼容链接失败，已回滚：{error}");
        return Ok(legacy.to_path_buf());
    }
    Ok(next)
}

#[cfg(windows)]
fn link_legacy(legacy: &Path, next: &Path) -> io::Result<()> {
    use std::os::windows::process::CommandExt;
    let result = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; New-Item -ItemType Junction -Path $env:ASSETVAULT_LEGACY_DATA -Target $env:ASSETVAULT_NEW_DATA | Out-Null"])
        .env("ASSETVAULT_LEGACY_DATA", legacy)
        .env("ASSETVAULT_NEW_DATA", next)
        .creation_flags(0x08000000)
        .output()?;
    if result.status.success() { Ok(()) } else {
        Err(io::Error::other(String::from_utf8_lossy(&result.stderr).into_owned()))
    }
}

#[cfg(not(windows))]
fn link_legacy(legacy: &Path, next: &Path) -> io::Result<()> {
    std::os::unix::fs::symlink(next, legacy)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migration_preserves_absolute_paths_and_never_merges_directories() {
        let root = std::env::temp_dir().join(format!("assetvault-path-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let legacy = root.join("com.assetvault.desktop");
        let next = root.join("AssetVault");
        std::fs::create_dir_all(legacy.join("downloads")).unwrap();
        std::fs::write(legacy.join("downloads/model.glb"), b"asset").unwrap();
        assert_eq!(resolve(&legacy).unwrap(), next);
        assert_eq!(std::fs::read(legacy.join("downloads/model.glb")).unwrap(), b"asset");
        assert_eq!(resolve(&legacy).unwrap(), next);
        // 移除的只是测试目录链接，目标内容仍在。
        #[cfg(windows)]
        std::fs::remove_dir(&legacy).unwrap();
        #[cfg(not(windows))]
        std::fs::remove_file(&legacy).unwrap();
        std::fs::create_dir(&legacy).unwrap();
        assert_eq!(resolve(&legacy).unwrap(), legacy);
        assert!(next.join("downloads/model.glb").exists());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn fresh_install_uses_short_directory() {
        let root = std::env::temp_dir().join(format!("assetvault-fresh-{}", std::process::id()));
        let legacy = root.join("com.assetvault.desktop");
        assert_eq!(resolve(&legacy).unwrap(), root.join("AssetVault"));
        assert!(!legacy.exists());
        std::fs::remove_dir_all(root).unwrap();
    }
}
