//! 授权：机器绑定 + Ed25519 离线验签。
//!
//! 设计要点：
//!  - 激活时联网一次，服务端签发绑定本机硬件指纹的授权文件；之后完全离线运行。
//!  - 授权文件只验签、不解密：内置的是**公钥**，私钥只在发行方手里，因此别人伪造不出授权。
//!  - 硬件指纹由 3 个因子组成（系统 MachineGuid / 主板+BIOS / CPU），校验时要求至少 2 项命中：
//!    这样用户重装系统（MachineGuid 会变）不至于授权作废，而换一台电脑则 3 项全变、必然拒绝。

use base64::{engine::general_purpose::STANDARD as B64, engine::general_purpose::URL_SAFE_NO_PAD as B64URL, Engine as _};
use ed25519_dalek::{Signature, VerifyingKey};
use sha2::{Digest, Sha256};
use std::path::Path;

/// 发行方公钥（raw 32 字节 base64）。换密钥对后必须同步更新这里，否则旧授权全部失效。
pub const LICENSE_PUBKEY_B64: &str = "6pJsCZom+9PVkxHAMAV8dUYeTRiLaNd5EzwqgjyCuTk=";

/// 默认授权服务地址。可用环境变量 AV_LICENSE_SERVER 覆盖（便于本地联调）。
/// 改成用户可控地址是安全的：假服务器没有私钥，签不出能通过验签的授权文件。
pub const DEFAULT_SERVER: &str = "https://license.example.com/api/activate";

pub const LICENSE_FILE: &str = "license.key";

fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

fn sha_hex(text: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(text.as_bytes());
    hex(&hasher.finalize())
}

#[cfg(windows)]
fn reg_string(subkey: &str, value: &str) -> String {
    use winreg::enums::HKEY_LOCAL_MACHINE;
    use winreg::RegKey;
    RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey(subkey)
        .and_then(|k| k.get_value::<String, _>(value))
        .map(|v| v.trim_end_matches('\0').trim().to_string())
        .unwrap_or_default()
}

#[cfg(not(windows))]
fn reg_string(_subkey: &str, _value: &str) -> String {
    String::new()
}

/// 采集 3 个硬件因子，返回它们的哈希（不暴露硬件原文，便于用户发给客服也不会泄露敏感信息）。
pub fn machine_factors() -> Vec<String> {
    let guid = reg_string(r"SOFTWARE\Microsoft\Cryptography", "MachineGuid");
    let bios = format!(
        "{}|{}|{}",
        reg_string(r"HARDWARE\DESCRIPTION\System\BIOS", "SystemProductName"),
        reg_string(r"HARDWARE\DESCRIPTION\System\BIOS", "BaseBoardProduct"),
        reg_string(r"HARDWARE\DESCRIPTION\System\BIOS", "BIOSReleaseDate"),
    );
    let cpu = format!(
        "{}|{}",
        reg_string(r"HARDWARE\DESCRIPTION\System\CentralProcessor\0", "ProcessorNameString"),
        reg_string(r"HARDWARE\DESCRIPTION\System\CentralProcessor\0", "Identifier"),
    );
    vec![
        sha_hex(&format!("guid:{guid}")),
        sha_hex(&format!("bios:{bios}")),
        sha_hex(&format!("cpu:{cpu}")),
    ]
}

/// 展示给用户的机器码（供人工核对 / 售后解绑用）。它由三个因子聚合而来，
/// 换机就变，重装系统也变——所以换机判定不用它，而用 `verify` 里的因子逐项比对。
pub fn machine_code(factors: &[String]) -> String {
    let h = sha_hex(&factors.join("|")).to_uppercase();
    let h = format!("{h:0<16}");
    format!("{}-{}-{}-{}", &h[0..4], &h[4..8], &h[8..12], &h[12..16])
}

/// 机器指纹串：把 3 个因子拼成一段可直接外发给发行方的文本。
/// 因子本身是 SHA-256 哈希（不含硬件原文），所以外发不会泄露敏感信息。
/// 格式：AVFP1.<f1>.<f2>.<f3>
pub fn fingerprint(factors: &[String]) -> String {
    format!("AVFP1.{}", factors.join("."))
}

/// 解析指纹串（签发工具与客户端共用同一格式）。必须恰好 3 段且每段非空 ——
/// 少一段会签出「缺因子」的授权，把「3 选 2」的判定悄悄放宽成必然通过。
///
/// 客户端只需要「生成」指纹，解析由发行方的 Node 签发工具完成，所以这里暂未被调用。
/// 保留实现并配套单测，是为了让两端格式始终对齐：万一格式改动，单测会立刻报警。
#[allow(dead_code)]
pub fn parse_fingerprint(text: &str) -> Option<Vec<String>> {
    let rest = text.trim().strip_prefix("AVFP1.")?;
    let parts: Vec<String> = rest.split('.').map(|s| s.trim().to_string()).collect();
    if parts.len() == 3 && parts.iter().all(|p| !p.is_empty()) {
        Some(parts)
    } else {
        None
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LicensePayload {
    #[serde(default)]
    pub key: String,
    #[serde(default)]
    pub machine_id: String,
    #[serde(default)]
    pub factors: Vec<String>,
    #[serde(default)]
    pub max_devices: u32,
    #[serde(default)]
    pub perpetual: bool,
    #[serde(default)]
    pub issued_at: String,
}

/// 只做「验签 + 解析」：证明这份授权确由发行方签发、且内容未被篡改。
/// 不涉及机器判定，因此也可以单独用来查看授权内容（例如售后核对密钥）。
pub fn payload_of(license: &str) -> Result<LicensePayload, String> {
    let parts: Vec<&str> = license.trim().split('.').collect();
    if parts.len() != 3 || parts[0] != "AVLIC1" {
        return Err("授权文件格式不正确，请确认复制完整".to_string());
    }
    // 签名对象是 base64url 文本本身（与签发端 crypto.sign(null, body) 一致）；
    // 解码出来的 JSON 只用来读内容。两者绝不能混用，否则真授权也会被判成被篡改。
    let body_text = parts[1];
    let body = B64URL.decode(body_text).map_err(|_| "授权内容损坏".to_string())?;
    let sig_raw = B64URL.decode(parts[2]).map_err(|_| "授权签名损坏".to_string())?;
    let sig = Signature::from_slice(&sig_raw).map_err(|_| "授权签名长度不正确".to_string())?;

    let pk_raw = B64.decode(LICENSE_PUBKEY_B64).map_err(|_| "内置公钥无效".to_string())?;
    let pk_arr: [u8; 32] = pk_raw
        .as_slice()
        .try_into()
        .map_err(|_| "内置公钥长度不正确".to_string())?;
    let pk = VerifyingKey::from_bytes(&pk_arr).map_err(|_| "内置公钥无效".to_string())?;

    pk.verify_strict(body_text.as_bytes(), &sig)
        .map_err(|_| "授权文件签名校验失败（文件可能被篡改）".to_string())?;

    serde_json::from_slice(&body).map_err(|_| "授权内容无法解析".to_string())
}

/// 完整校验：先验签（证明是发行方签发的），再比对硬件因子（证明是这台机器）。
pub fn verify(license: &str, factors: &[String]) -> Result<LicensePayload, String> {
    let payload = payload_of(license)?;

    // 3 个硬件因子中至少命中 2 个 —— 容忍重装系统，但换电脑必定拒绝。
    let hit = payload
        .factors
        .iter()
        .zip(factors.iter())
        .filter(|(a, b)| a == b)
        .count();
    if hit < 2 {
        return Err("该授权不属于这台电脑".to_string());
    }
    Ok(payload)
}

/// 读取并校验已保存的授权文件。
pub fn load(path: &Path, factors: &[String]) -> Result<LicensePayload, String> {
    if !path.exists() {
        return Err("尚未激活".to_string());
    }
    let text = std::fs::read_to_string(path).map_err(|_| "无法读取授权文件".to_string())?;
    if text.trim().is_empty() {
        return Err("尚未激活".to_string());
    }
    verify(&text, factors)
}

/// 保存授权文件（先写临时文件再改名，避免中途断电留下半个文件）。
pub fn save(path: &Path, license: &str) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, license.trim()).map_err(|e| format!("保存授权失败: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("保存授权失败: {e}"))?;
    Ok(())
}

pub fn server_url() -> String {
    std::env::var("AV_LICENSE_SERVER").unwrap_or_else(|_| DEFAULT_SERVER.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 由发行方私钥真实签发的样例授权（对应 licensing/sample-license.txt）。
    const SAMPLE: &str = "AVLIC1.eyJ2IjoxLCJrZXkiOiJBVi1URVNUMS1URVNUMi1URVNUMy1URVNUNCIsIm1hY2hpbmVJZCI6IkFBQUEtQkJCQi1DQ0NDLUREREQiLCJmYWN0b3JzIjpbImExYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWEiLCJiMmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiIiwiYzNjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjYyJdLCJtYXhEZXZpY2VzIjoyLCJwZXJwZXR1YWwiOnRydWUsImZlYXR1cmVzIjpbImFsbCJdLCJpc3N1ZWRBdCI6IjIwMjYtMTAtMTVUMDA6MDA6MDAuMDAwWiJ9.gFyyS3TkxK70Z6pJHTw1-drCla3nAMjxfFWJkNEVLt8UvChtqM-TGRmkflQpcAZfQv0n8-uMqbCJpFkbtpMcAA";

    #[test]
    fn 真实签发的授权可以验签并解析() {
        let p = payload_of(SAMPLE).expect("签名应有效");
        assert_eq!(p.key, "AV-TEST1-TEST2-TEST3-TEST4");
        assert_eq!(p.max_devices, 2);
        assert!(p.perpetual);
        assert_eq!(p.factors.len(), 3);
    }

    #[test]
    fn 同一台机器应当通过() {
        let p = payload_of(SAMPLE).unwrap();
        assert!(verify(SAMPLE, &p.factors).is_ok());
    }

    #[test]
    fn 重装系统只丢一个因子仍然通过() {
        let p = payload_of(SAMPLE).unwrap();
        let mut factors = p.factors.clone();
        factors[2] = "reinstalled-system".to_string();
        assert!(verify(SAMPLE, &factors).is_ok(), "2/3 命中应放行");
    }

    #[test]
    fn 换一台电脑必须拒绝() {
        let p = payload_of(SAMPLE).unwrap();
        let factors = vec![p.factors[0].clone(), "other-board".to_string(), "other-cpu".to_string()];
        let err = verify(SAMPLE, &factors).unwrap_err();
        assert!(err.contains("不属于这台电脑"), "实际错误: {err}");
    }

    #[test]
    fn 篡改内容会导致验签失败() {
        let p = payload_of(SAMPLE).unwrap();
        let mut bad = SAMPLE.to_string();
        bad.replace_range(10..11, "X");
        assert!(payload_of(&bad).is_err(), "改动载荷后签名必须失配");
        assert!(verify(&bad, &p.factors).is_err());
    }

    #[test]
    fn 格式非法要被挡住() {
        assert!(payload_of("随便一段字符串").is_err());
        assert!(payload_of("AVLIC1.abc").is_err());
        assert!(verify("", &["a".into(), "b".into(), "c".into()]).is_err());
    }

    #[test]
    fn 机器码格式稳定() {
        let code = machine_code(&["a".into(), "b".into(), "c".into()]);
        assert_eq!(code.len(), 19, "应为 XXXX-XXXX-XXXX-XXXX");
        assert_eq!(code.chars().filter(|c| *c == '-').count(), 3);
        assert_eq!(code, machine_code(&["a".into(), "b".into(), "c".into()]));
    }

    #[test]
    fn 指纹串可往返解析且拒绝残缺输入() {
        let f = vec!["aa".to_string(), "bb".to_string(), "cc".to_string()];
        let fp = fingerprint(&f);
        assert_eq!(fp, "AVFP1.aa.bb.cc");
        assert_eq!(parse_fingerprint(&fp).unwrap(), f);
        assert!(parse_fingerprint("AVFP1.aa.bb").is_none(), "缺一段必须拒绝");
        assert!(parse_fingerprint("AVFP1.aa..cc").is_none(), "空段必须拒绝");
        assert!(parse_fingerprint("没有前缀").is_none());
    }

    /// 闭环自测：把 `keygen.mjs sign` 真正签出来的授权经环境变量传进来，
    /// 验证它能被本模块验签通过。未设该变量时直接跳过，不影响日常 `cargo test`。
    /// 这条专门守住「签发端与验签端的签名对象必须一致」——历史上真在这儿栽过。
    #[test]
    fn 签发工具产出的授权能通过验签() {
        let Ok(lic) = std::env::var("AV_TEST_LICENSE") else {
            return;
        };
        let p = payload_of(&lic).expect("新签发的授权必须能通过验签");
        assert_eq!(p.factors.len(), 3, "授权必须绑定 3 个因子");
        assert!(verify(&lic, &p.factors).is_ok(), "同机校验应通过");
    }
}
