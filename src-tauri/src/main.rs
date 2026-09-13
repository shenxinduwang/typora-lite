// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{Emitter, Manager};

/// 启动时从命令行参数里捕获要打开的文件路径（用于 .md 双击关联）。
struct LaunchFile(Mutex<Option<String>>);

/// 单实例转发的路径先入队再 emit：前端「订阅完成之前」发来的事件会丢，
/// 队列兜住这个竞态窗口，前端初始化完主动 take 一次。
struct PendingOpen(Mutex<Vec<String>>);

/// 从一组 argv 里找第一个真实存在的文件路径（跳过程序名，容错引号）。
fn find_file_in_args<I: IntoIterator<Item = String>>(args: I) -> Option<String> {
    args.into_iter().skip(1).find(|a| {
        let trimmed = a.trim_matches('"');
        std::path::Path::new(trimmed).is_file()
    })
}

const UTF8_BOM: &[u8] = &[0xEF, 0xBB, 0xBF];

/// 读出来的文本 + 记住的编码标签，保存时按原编码写回。
#[derive(serde::Serialize)]
struct LoadedText {
    text: String,
    encoding: String,
}

/// 按 BOM 识别 UTF-8/UTF-16；无 BOM 时先按严格 UTF-8 试，失败回退 GBK。
/// （Windows 上 GBK/ANSI 编码的 .md 很常见，纯 fs::read_to_string 会直接报错。）
fn decode_bytes(bytes: &[u8]) -> LoadedText {
    if bytes.starts_with(UTF8_BOM) {
        LoadedText {
            text: String::from_utf8_lossy(&bytes[3..]).into_owned(),
            encoding: "utf8bom".into(),
        }
    } else if bytes.starts_with(&[0xFF, 0xFE]) {
        let (text, _, _) = encoding_rs::UTF_16LE.decode(bytes); // decode 自动剥 BOM
        LoadedText {
            text: text.into_owned(),
            encoding: "utf16le".into(),
        }
    } else if bytes.starts_with(&[0xFE, 0xFF]) {
        let (text, _, _) = encoding_rs::UTF_16BE.decode(bytes);
        LoadedText {
            text: text.into_owned(),
            encoding: "utf16be".into(),
        }
    } else if let Ok(s) = std::str::from_utf8(bytes) {
        LoadedText {
            text: s.to_owned(),
            encoding: "utf8".into(),
        }
    } else {
        let (text, _, _) = encoding_rs::GBK.decode(bytes);
        LoadedText {
            text: text.into_owned(),
            encoding: "gbk".into(),
        }
    }
}

/// 与 decode_bytes 对应的写回：utf16/带 BOM 的补回 BOM，gbk 按原编码编码。
/// GBK 遇到不可映射字符（emoji/部分生僻字）时返回 Err——encoding_rs 默认会把
/// 它们替换成 `&#128512;` 这类数字字符引用写进文件，属于静默数据损坏，必须上抛。
fn encode_text(text: &str, encoding: &str) -> Result<Vec<u8>, String> {
    match encoding {
        "utf8bom" => {
            let mut out = UTF8_BOM.to_vec();
            out.extend_from_slice(text.as_bytes());
            Ok(out)
        }
        "utf16le" | "utf16be" => {
            // 注意：encoding_rs 的 encode() 遵循 Encoding Standard 的表单编码
            // 语义——对 UTF-16 标签直接返回 UTF-8 字节，不能用来写回 UTF-16
            // 文件（否则存成 "FF FE + UTF-8" 的损坏文件，下次打开全是乱码）。
            // str 恒可编码为 UTF-16，这里手动按端序写码元。
            let little = encoding == "utf16le";
            let mut out = if little {
                vec![0xFF, 0xFE]
            } else {
                vec![0xFE, 0xFF]
            };
            for unit in text.encode_utf16() {
                let b = if little {
                    unit.to_le_bytes()
                } else {
                    unit.to_be_bytes()
                };
                out.extend_from_slice(&b);
            }
            Ok(out)
        }
        "gbk" => {
            let (bytes, _, had_unmappables) = encoding_rs::GBK.encode(text);
            if had_unmappables {
                return Err(
                    "文档含有 GBK 无法表示的字符（emoji/生僻字），按 GBK 保存会写成 &#数字; 乱码"
                        .to_string(),
                );
            }
            Ok(bytes.into_owned())
        }
        _ => Ok(text.as_bytes().to_vec()),
    }
}

/// 原子写：先写同目录临时文件再 rename 覆盖。直接 fs::write 覆盖原文件，
/// 写一半崩溃/断电会把用户的文件截断损坏；rename 在 Windows 上等价于
/// MoveFileEx(MOVEFILE_REPLACE_EXISTING)，可覆盖已存在目标，且同目录内是原子的。
fn write_atomic(path: &Path, data: &[u8]) -> Result<(), String> {
    let file_name = path.file_name().unwrap_or_default().to_os_string();
    let tmp = PathBuf::from(path).with_file_name({
        let mut name = file_name;
        name.push(format!(".{}.tmp", std::process::id()));
        name
    });
    let result = fs::write(&tmp, data).and_then(|_| fs::rename(&tmp, path));
    match result {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = fs::remove_file(&tmp); // 失败不留垃圾临时文件
            Err(format!("保存失败 {}: {e}", path.display()))
        }
    }
}

/// 保存结果：saved=false + unmappable=true 表示"GBK 编不下，未写盘"，由前端引导改存 UTF-8。
#[derive(serde::Serialize)]
struct WriteStatus {
    saved: bool,
    unmappable: bool,
}

/// 读取文本文件（UTF-8 / UTF-8 BOM / UTF-16 / GBK 自动识别），离线、无需 fs 插件 scope。
#[tauri::command]
fn read_text_file(path: String) -> Result<LoadedText, String> {
    let bytes = fs::read(&path).map_err(|e| format!("读取失败 {path}: {e}"))?;
    Ok(decode_bytes(&bytes))
}

/// 写入（保存）文本文件：按 read 时记住的编码写回，原子写防损坏。
#[tauri::command]
fn write_text_file(path: String, contents: String, encoding: Option<String>) -> Result<WriteStatus, String> {
    let data = match encode_text(&contents, encoding.as_deref().unwrap_or("utf8")) {
        Ok(d) => d,
        Err(_) => {
            return Ok(WriteStatus {
                saved: false,
                unmappable: true,
            })
        }
    };
    write_atomic(Path::new(&path), &data)?;
    Ok(WriteStatus {
        saved: true,
        unmappable: false,
    })
}

/// 前端启动后取一次要打开的文件路径（取走后清空）。
#[tauri::command]
fn take_launch_file(state: tauri::State<LaunchFile>) -> Option<String> {
    state.0.lock().ok().and_then(|mut g| g.take())
}

/// 取走单实例竞态窗口内攒下的待打开路径（取走后清空）。
#[tauri::command]
fn take_pending_files(state: tauri::State<PendingOpen>) -> Vec<String> {
    match state.0.lock() {
        Ok(mut q) => q.drain(..).collect(),
        Err(_) => Vec::new(),
    }
}

/// 路径是否存在（启动恢复最近文件前预检，避免对已删除文件弹错误框）。
#[tauri::command]
fn path_exists(path: String) -> bool {
    Path::new(&path).exists()
}

/// 文件修改时间（毫秒时间戳），用于外部修改监听轮询比对。
#[tauri::command]
fn file_mtime_ms(path: String) -> Result<u64, String> {
    let meta = fs::metadata(&path).map_err(|e| format!("读取元数据失败 {path}: {e}"))?;
    let modified = meta.modified().map_err(|e| format!("读取修改时间失败 {path}: {e}"))?;
    Ok(modified
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0))
}

/// 读取任意文件为 base64（把外部图片复制进文档 assets 时用，走 JSON 不适合传原始字节）。
#[tauri::command]
fn read_file_base64(path: String) -> Result<String, String> {
    use base64::Engine as _;
    let bytes = fs::read(&path).map_err(|e| format!("读取失败 {path}: {e}"))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// 把图片（base64）写入文档同目录 assets/，返回 Markdown 里引用的相对路径。
/// 文件名做字符消毒，防路径穿越。
#[tauri::command]
fn write_asset_file(doc_path: String, file_name: String, data_base64: String) -> Result<String, String> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64)
        .map_err(|e| format!("图片数据解码失败: {e}"))?;
    let doc_dir = Path::new(&doc_path)
        .parent()
        .ok_or_else(|| "无法确定文档目录".to_string())?;
    let assets = doc_dir.join("assets");
    fs::create_dir_all(&assets).map_err(|e| format!("创建 assets 目录失败: {e}"))?;
    let safe: String = file_name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '.' || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let target = assets.join(&safe);
    fs::write(&target, bytes).map_err(|e| format!("写入图片失败 {}: {e}", target.display()))?;
    Ok(format!("assets/{}", safe))
}

/// 读取文档目录下的相对资源（图片预览用），返回 base64；防路径穿越。
#[tauri::command]
fn read_asset_base64(doc_path: String, rel: String) -> Result<String, String> {
    use base64::Engine as _;
    let doc_dir = Path::new(&doc_path)
        .parent()
        .ok_or_else(|| "无法确定文档目录".to_string())?;
    let target = doc_dir.join(&rel);
    let canonical = target
        .canonicalize()
        .map_err(|e| format!("资源不存在 {}: {e}", target.display()))?;
    let doc_canonical = doc_dir.canonicalize().map_err(|e| format!("{e}"))?;
    if !canonical.starts_with(&doc_canonical) {
        return Err("资源路径越界".into());
    }
    let bytes = fs::read(&canonical).map_err(|e| format!("读取失败: {e}"))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// 链接白名单：与前端 `/^(https?:\/\/|mailto:)/i` 对齐，必须大小写归一后比较，
/// 否则用户点 HTTP://A.COM 这类链接会前端放行、Rust 拒绝弹莫名错误框。
fn is_allowed_url(url: &str) -> bool {
    let lowered = url.to_ascii_lowercase();
    lowered.starts_with("http://")
        || lowered.starts_with("https://")
        || lowered.starts_with("mailto:")
}

/// 用系统默认程序打开外部链接（仅 http/https/mailto，防命令注入）。
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    if !is_allowed_url(&url) {
        return Err(format!("不允许打开的链接: {url}"));
    }
    #[cfg(windows)]
    {
        // 不能走 `cmd /C start`：cmd 会把 URL 里的 & | % 等当命令分隔符/变量展开
        // （Rust 对无空格参数不加引号），恶意文档可借此注入命令。
        // rundll32 不经过 shell 二次解析，对 http/https/mailto 均有效。
        std::process::Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", &url])
            .spawn()
            .map_err(|e| format!("打开链接失败: {e}"))?;
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| format!("打开链接失败: {e}"))?;
    }
    Ok(())
}

/// 首次运行在 HKCU\Software\Classes 补齐“右键 → 新建 → Markdown Document”
/// 与“打开方式”登记。刻意**不覆盖** .md 的默认关联（那交给安装器/用户），
/// 以免每次启动把用户改过的默认编辑器抢回来。全部幂等、免管理员。
#[cfg(windows)]
fn ensure_shell_new() {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let exe = match std::env::current_exe() {
        Ok(p) => p.to_string_lossy().to_string(),
        Err(_) => return,
    };
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let classes = match hkcu.create_subkey("Software\\Classes") {
        Ok((k, _)) => k,
        Err(_) => return,
    };

    // 自建 ProgId（含打开命令 + 图标 + ShellNew），供“打开方式”选用；不改默认关联。
    if let Ok((prog, _)) = classes.create_subkey("Typora-Lite.md") {
        let _ = prog.set_value("", &"Markdown Document");
        if let Ok((icon, _)) = prog.create_subkey("DefaultIcon") {
            let _ = icon.set_value("", &format!("{exe},0"));
        }
        if let Ok((sn, _)) = prog.create_subkey("ShellNew") {
            let _ = sn.set_value("NullFile", &"");
        }
        if let Ok((cmd, _)) = prog.create_subkey("shell\\open\\command") {
            let _ = cmd.set_value("", &format!("\"{exe}\" \"%1\""));
        }
    }

    // 给扩展名补 ShellNew（右键新建）+ 在 OpenWithProgids 登记；不动默认值。
    for ext in [".md", ".markdown"] {
        if let Ok((ek, _)) = classes.create_subkey(ext) {
            if let Ok((sn, _)) = ek.create_subkey("ShellNew") {
                let _ = sn.set_value("NullFile", &"");
                let _ = sn.set_value("IconPath", &format!("{exe},0"));
            }
            if let Ok((ow, _)) = ek.create_subkey("OpenWithProgids") {
                let _ = ow.set_value("Typora-Lite.md", &"");
            }
        }
    }
}

fn main() {
    let launch = LaunchFile(Mutex::new(find_file_in_args(std::env::args())));

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // 单实例：二次启动（含再次双击别的 .md）不再开新窗口，
        // 而是把要打开的文件通过事件转发给已存在窗口并聚焦，修掉
        // “双击打开看到的却是默认示例窗口”的多实例混淆。
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // 先还原再聚焦：窗口最小化时只 set_focus 是不弹出来的
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
            if let Some(path) = find_file_in_args(argv) {
                if let Some(pending) = app.try_state::<PendingOpen>() {
                    if let Ok(mut q) = pending.0.lock() {
                        q.push(path.clone());
                    }
                }
                let _ = app.emit("open-file", path);
            }
        }))
        .setup(|_app| {
            #[cfg(windows)]
            ensure_shell_new();
            Ok(())
        })
        .manage(launch)
        .manage(PendingOpen(Mutex::new(Vec::new())))
        .invoke_handler(tauri::generate_handler![
            read_text_file,
            write_text_file,
            take_launch_file,
            take_pending_files,
            path_exists,
            file_mtime_ms,
            read_file_base64,
            write_asset_file,
            read_asset_base64,
            open_external
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_identifies_encodings() {
        // UTF-8（无 BOM）
        let r = decode_bytes("中文 utf8".as_bytes());
        assert_eq!(r.encoding, "utf8");
        assert_eq!(r.text, "中文 utf8");

        // UTF-8 BOM
        let mut with_bom = UTF8_BOM.to_vec();
        with_bom.extend_from_slice("中文".as_bytes());
        let r = decode_bytes(&with_bom);
        assert_eq!(r.encoding, "utf8bom");
        assert_eq!(r.text, "中文");

        // 非 UTF-8 字节回退 GBK（"中文" 的 GBK 字节不是合法 UTF-8）
        let (gbk_bytes, _, had_err) = encoding_rs::GBK.encode("中文");
        assert!(!had_err);
        let r = decode_bytes(&gbk_bytes);
        assert_eq!(r.encoding, "gbk");
        assert_eq!(r.text, "中文");

        // UTF-16LE BOM（手动构造：FF FE + 小端码元，encoding_rs 的 encode()
        // 对 UTF-16 标签返回的是 UTF-8 字节，不能拿来构造测试向量）
        let mut u16le = vec![0xFF, 0xFE];
        for unit in "中文".encode_utf16() {
            u16le.extend_from_slice(&unit.to_le_bytes());
        }
        let r = decode_bytes(&u16le);
        assert_eq!(r.encoding, "utf16le");
        assert_eq!(r.text, "中文");
    }

    #[test]
    fn gbk_unmappable_is_rejected_not_silently_corrupted() {
        // P0-2 回归守卫：emoji 编不进 GBK 必须报错，而不是写成 &#128512;
        let err = encode_text("😀", "gbk").unwrap_err();
        assert!(err.contains("GBK 无法表示"));
        // 可映射内容正常写回
        let expect = encoding_rs::GBK.encode("中文").0.into_owned();
        assert_eq!(encode_text("中文", "gbk").unwrap(), expect);
        // 前端约定的信号：错误路径不落盘，由 WriteStatus.unmappable 表达
        assert!(encode_text("😀", "utf8").is_ok());
    }

    #[test]
    fn utf16_and_bom_roundtrip() {
        for enc in ["utf16le", "utf16be", "utf8bom"] {
            let data = encode_text("中文-emoji😀", enc).unwrap();
            eprintln!("{enc}: {:02x?}", &data[..data.len().min(12)]);
            let loaded = decode_bytes(&data);
            assert_eq!(loaded.encoding, enc, "encoding {enc} 应原样识别回来");
            assert_eq!(loaded.text, "中文-emoji😀");
        }
    }

    #[test]
    fn write_atomic_overwrites_and_leaves_no_tmp() {
        let dir = std::env::temp_dir().join(format!("tl-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("a.md");
        std::fs::write(&target, b"old").unwrap();

        write_atomic(&target, b"new-content-longer").unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"new-content-longer");

        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "失败/成功都不应残留 tmp 文件");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn url_whitelist_matches_frontend_case_insensitive() {
        // 与前端 /i 校验对齐：大小写变体必须放行
        assert!(is_allowed_url("https://a.com"));
        assert!(is_allowed_url("HTTP://A.COM/?x=1&y=2"));
        assert!(is_allowed_url("Https://A.COM"));
        assert!(is_allowed_url("MAILTO:a@b.com"));
        assert!(is_allowed_url("mailto:x&y")); // & 由"不经 shell"保证安全，白名单照常放行
        // 非 http(s)/mailto 一律拒绝
        assert!(!is_allowed_url("file:///C:/x"));
        assert!(!is_allowed_url("javascript:alert(1)"));
        assert!(!is_allowed_url("ftp://a"));
        // 命令入口对越界 scheme 拒绝（放行路径会拉起系统程序，不适合单测）
        let err = open_external("file:///C:/Windows/System32/calc.exe".into()).unwrap_err();
        assert!(err.contains("不允许打开"));
    }
}
