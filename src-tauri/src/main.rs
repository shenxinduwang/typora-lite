// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

/// 启动时从命令行参数里捕获要打开的文件路径（用于 .md 双击关联）。
struct LaunchFile(Mutex<Option<String>>);

/// 单实例转发的路径先入队再 emit：前端「订阅完成之前」发来的事件会丢，
/// 队列兜住这个竞态窗口，前端初始化完主动 take 一次。
struct PendingOpen(Mutex<Vec<String>>);

/// 从一组 argv 里找第一个真实存在的文件路径（跳过程序名，容错引号）。
fn find_file_in_args<I: IntoIterator<Item = String>>(args: I) -> Option<String> {
    args.into_iter().skip(1).find_map(|a| {
        let trimmed = a.trim_matches('"');
        let p = Path::new(trimmed);
        if !p.is_file() {
            return None;
        }
        // 转绝对路径：命令行可能传相对路径，而授权校验只接受绝对路径
        let abs = p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
        Some(strip_verbatim(abs).display().to_string())
    })
}

const UTF8_BOM: &[u8] = &[0xEF, 0xBB, 0xBF];

// ---- 会话授权路径集（F-1 纵深防御）----
// 背景：七个文件 command（read_text_file / write_text_file / read_file_base64 /
// path_exists / file_mtime_ms / write_asset_file / read_asset_base64）此前对
// path 无任何约束，WebView 侧一旦出现
// 脚本执行即可把它们组合成「任意文件读写原语」。这里维护一个「本次会话授权
// 路径集」：授权单位是「文件 + 其父目录」（与 read_asset_base64 的
// 「文档所在目录为根」语义一致），来源限定为用户主动动作——
//   1. 启动 argv / 单实例转发的双击路径；
//   2. 打开 / 另存为对话框返回的路径（Rust 侧原生对话框 command，见
//      dialog_pick_file / dialog_save_file）；
//   3. 拖放进窗口的路径（on_window_event DragDrop）；
//   4. 跨会话记忆：上次会话授权过的路径集持久化到 app_config_dir，供
//      崩溃草稿恢复 / 最近文件恢复在「用户还没来得及任何授权动作」的冷启动
//      阶段读取磁盘（read_text_file 先于任何事件发生）。只放行「用户自己
//      打开过的文件」，不含探测性遍历。
// 判定用 canonicalize 后的 final path 组件级比对（防 ../、symlink 逃逸与
// C:\doc vs C:\doc-evil 同前缀误过）。越界一律返回统一错误「路径未授权」。
struct AuthPaths(Mutex<HashSet<PathBuf>>);

fn strip_verbatim(canonical: PathBuf) -> PathBuf {
    let s = canonical.display().to_string();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        canonical
    }
}

/// 路径归一化：能 canonicalize 则解 symlink 得 final path，并剥掉 Windows
/// `\\?\` verbatim 前缀。目标尚不存在时，只允许「已存在的最近祖先」+
/// 纯普通文件名后缀；`..` 一律拒绝。
///
/// 不能像旧实现那样 canonicalize 失败就信任字面路径：`Path::starts_with`
/// 不消解 `..`，`C:\授权目录\..\其它目录\new.md` 会通过前缀检查，随后真正
/// 写盘/建目录时却被 OS 解析到授权目录之外。
fn normalize_path(p: &Path) -> Result<PathBuf, String> {
    if !p.is_absolute() {
        return Err("路径必须是绝对路径".into());
    }
    if let Ok(canonical) = p.canonicalize() {
        return Ok(strip_verbatim(canonical));
    }

    let mut cur = p.to_path_buf();
    let mut suffix: Vec<std::ffi::OsString> = Vec::new();
    loop {
        let Some(name) = cur.file_name() else {
            return Err(format!("无法解析路径: {}", p.display()));
        };
        if name == std::ffi::OsStr::new("..") {
            return Err("路径不允许包含 ..".into());
        }
        suffix.push(name.to_os_string());
        let Some(parent) = cur.parent() else {
            return Err(format!("无法解析路径: {}", p.display()));
        };
        if let Ok(base) = parent.canonicalize() {
            let mut resolved = strip_verbatim(base);
            for part in suffix.iter().rev() {
                resolved.push(part);
            }
            return Ok(resolved);
        }
        cur = parent.to_path_buf();
    }
}

/// 把一个文件路径与其父目录加入授权集。
/// 不存在的新目标也走 normalize_path：父目录必须已存在，后缀不得含 `..`。
fn authorize_path_str(store: &AuthPaths, path: &str) {
    let Ok(canonical) = normalize_path(Path::new(path)) else {
        return;
    };
    let mut g = match store.0.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    g.insert(canonical.clone());
    if let Some(parent) = canonical.parent() {
        g.insert(parent.to_path_buf());
    }
}

/// 组件级包含判定：target 是否位于 base 目录下（或就是 base 本身）。
/// Path::strip_prefix / starts_with 按路径组件比对，不是字节前缀——
/// C:\doc 不会放行 C:\doc-evil\x。
fn path_within(target: &Path, base: &Path) -> bool {
    target.starts_with(base)
}

/// 校验请求路径是否落在授权集内，并返回归一化后的实际路径。
/// 所有文件 command 后续 I/O 都应使用返回值，避免再次解析原始路径。
fn authorized_path(store: &AuthPaths, path: &str) -> Result<PathBuf, String> {
    let canonical =
        normalize_path(Path::new(path)).map_err(|e| format!("路径未授权: {path}（{e}）"))?;
    let g = store
        .0
        .lock()
        .map_err(|_| "路径未授权（内部状态异常）".to_string())?;
    if g.iter().any(|allowed| path_within(&canonical, allowed)) {
        Ok(canonical)
    } else {
        Err(format!("路径未授权: {path}"))
    }
}

#[cfg(test)]
fn check_authorized(store: &AuthPaths, path: &str) -> Result<(), String> {
    authorized_path(store, path).map(|_| ())
}

/// 授权集落盘文件（app_config_dir/authorized-paths.txt，一行一个路径）。
/// 上限 200 条，防无限增长；只在新增授权时重写。
/// 恢复侧（restore_authorized）会过滤已不存在项，这里不做存在性过滤——
/// 「另存为新文件」的路径落盘时可能尚不存在，写盘后跨会话仍需可恢复。
/// N3：截断策略不再按纯字典序——目录条目优先保留（目录在前、文件在后，
/// 各自按路径稳定次序）。理由：授权单位是「文件+父目录」两条/次，目录条目
/// 覆盖面广（父目录放行即整目录可读），截掉一条目录的损失远大于截掉一条
/// 文件；纯字典序截尾可能恰好保留一批同前缀文件而丢掉常用目录，被截路径
/// 下次会话回到 N2 同款误拒表现。文件条目粒度细，截尾影响最小。
fn persist_authorized(app: &tauri::AppHandle, store: &AuthPaths) {
    let Some(dir) = app.path().app_config_dir().ok() else {
        return;
    };
    let Ok(g) = store.0.lock() else {
        return;
    };
    let mut keep: Vec<PathBuf> = g.iter().cloned().collect();
    keep.sort();
    keep.dedup();
    if keep.len() > 200 {
        // N3：目录在前、文件在后，各自保持字典序；截尾只动文件区
        let mut dirs: Vec<PathBuf> = keep.iter().filter(|p| p.is_dir()).cloned().collect();
        let files: Vec<PathBuf> = keep.iter().filter(|p| !p.is_dir()).cloned().collect();
        dirs.extend(files);
        keep = dirs;
        keep.truncate(200);
    }
    let lines: Vec<String> = keep.iter().map(|p| p.display().to_string()).collect();
    let _ = fs::create_dir_all(&dir);
    let _ = fs::write(dir.join("authorized-paths.txt"), lines.join("\n"));
}

/// 清空授权集，只保留当前打开文档。
/// 用户点「清空最近文件」时仍在编辑当前文档：若连内存授权一起清掉，手动保存
/// 会报「路径未授权」、自动保存会因 path_exists=false 静默停用；若只保留内存，
/// 崩溃后草稿恢复又无法读回原文件。因此把「当前文档」作为 keep_path 传入，
/// 先确认它本来就在授权集内（不新增授权面），再清空并单独保留。
#[tauri::command]
fn clear_authorized_paths(
    app: tauri::AppHandle,
    state: tauri::State<AuthPaths>,
    keep_path: Option<String>,
) -> Result<(), String> {
    // 只接受已在授权集内的路径，不能借这个入口授权任意路径
    let keep = keep_path
        .as_deref()
        .and_then(|p| authorized_path(&state, p).ok());
    if let Ok(mut g) = state.0.lock() {
        g.clear();
    }
    let Some(dir) = app.path().app_config_dir().ok() else {
        return Ok(());
    };
    let file = dir.join("authorized-paths.txt");
    let _ = fs::remove_file(&file);
    if let Some(p) = keep {
        authorize_path_str(&state, &p.display().to_string());
        persist_authorized(&app, &state);
    }
    Ok(())
}

/// 启动时恢复上次会话的授权集（供崩溃草稿 / 最近文件冷启动读取）。
fn restore_authorized(app: &tauri::AppHandle, store: &AuthPaths) {
    let Some(dir) = app.path().app_config_dir().ok() else {
        return;
    };
    let Ok(text) = fs::read_to_string(dir.join("authorized-paths.txt")) else {
        return;
    };
    if let Ok(mut g) = store.0.lock() {
        for line in text.lines() {
            // 文件/目录仍存在才恢复；失效或含 .. 的旧条目直接丢弃
            if let Ok(p) = normalize_path(Path::new(line)) {
                if p.exists() {
                    g.insert(p);
                }
            }
        }
    }
}

/// 读出来的文本 + 记住的编码标签，保存时按原编码写回。
#[derive(serde::Serialize, Debug)]
struct LoadedText {
    text: String,
    encoding: String,
}

/// 按 BOM 识别 UTF-8/UTF-16；无 BOM 时先按严格 UTF-8 试，失败回退 GBK。
/// （Windows 上 GBK/ANSI 编码的 .md 很常见，纯 fs::read_to_string 会直接报错。）
/// UTF-8 BOM 路径同样严格校验：含非法字节时返回 Err（前端弹「打开失败」），
/// 不再 lossy 静默替换 U+FFFD——一旦保存，替换字符固化到磁盘，原始字节丢失。
fn decode_bytes(bytes: &[u8]) -> Result<LoadedText, String> {
    if bytes.starts_with(UTF8_BOM) {
        let body = &bytes[3..];
        let text = std::str::from_utf8(body)
            .map_err(|_| "文件带有 UTF-8 BOM 但内容含损坏字节，无法安全解码".to_string())?
            .to_owned();
        Ok(LoadedText {
            text,
            encoding: "utf8bom".into(),
        })
    } else if bytes.starts_with(&[0xFF, 0xFE]) {
        decode_legacy_checked(encoding_rs::UTF_16LE, bytes, "utf16le", "UTF-16LE")
    } else if bytes.starts_with(&[0xFE, 0xFF]) {
        decode_legacy_checked(encoding_rs::UTF_16BE, bytes, "utf16be", "UTF-16BE")
    } else if let Ok(s) = std::str::from_utf8(bytes) {
        Ok(LoadedText {
            text: s.to_owned(),
            encoding: "utf8".into(),
        })
    } else {
        decode_legacy_checked(encoding_rs::GBK, bytes, "gbk", "GBK")
    }
}

/// 旧编码严格解码：encoding_rs 的非 `*_without_replacement` 接口会把坏字节
/// 替换成 U+FFFD，并把 `had_errors` 放进第三个返回值。若忽略它，打开后一保存
/// 就把原文件的坏字节固化成替换字符，属静默数据损坏。
fn decode_legacy_checked(
    encoding: &'static encoding_rs::Encoding,
    bytes: &[u8],
    label: &str,
    display: &str,
) -> Result<LoadedText, String> {
    let (text, _, had_errors) = encoding.decode(bytes);
    if had_errors {
        return Err(format!(
            "按 {display} 解码时遇到损坏字节，无法安全打开（保存会固化替换字符）"
        ));
    }
    Ok(LoadedText {
        text: text.into_owned(),
        encoding: label.into(),
    })
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
///
/// F-3 加固：tmp 名带不可预测随机段（进程内计数器 × pid × 纳秒时钟混合），
/// 且用 create_new(true) 创建——已存在即失败，拒绝跟随攻击者预置的
/// symlink/junction（fs::write 的 File::create 语义会截断链接目标）。
fn write_atomic(path: &Path, data: &[u8]) -> Result<(), String> {
    /// 无依赖伪随机：进程内单调计数器，混合 pid 与纳秒时钟打散。
    /// 不需要密码学强度，只需要「同目录攻击者猜不到下一个 tmp 名」。
    fn tmp_nonce() -> u64 {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let pid = std::process::id() as u64;
        let t = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0);
        // xor 折叠三路熵，wrapping 乘法做雪崩（splitmix64 末步）
        let mut z = n ^ pid.rotate_left(32) ^ t;
        z = z.wrapping_add(0x9E3779B97F4A7C15);
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
        z ^ (z >> 31)
    }
    let file_name = path.file_name().unwrap_or_default().to_os_string();
    let tmp = PathBuf::from(path).with_file_name({
        let mut name = file_name;
        name.push(format!(".{}.{}.tmp", std::process::id(), tmp_nonce()));
        name
    });
    let write_result = (|| {
        use std::io::Write;
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)?;
        f.write_all(data)?;
        f.sync_all()?;
        Ok::<(), std::io::Error>(())
    })();
    let result = write_result.and_then(|_| fs::rename(&tmp, path));
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
/// F-1：路径必须落在会话授权集内，越界统一返回「路径未授权」。
#[tauri::command]
fn read_text_file(state: tauri::State<AuthPaths>, path: String) -> Result<LoadedText, String> {
    let target = authorized_path(&state, &path)?;
    let bytes = fs::read(&target).map_err(|e| format!("读取失败 {path}: {e}"))?;
    decode_bytes(&bytes)
}

/// 写入（保存）文本文件：按 read 时记住的编码写回，原子写防损坏。
/// F-1：路径必须落在会话授权集内（另存为新文件时由 dialog_save_file 预授权）。
#[tauri::command]
fn write_text_file(
    state: tauri::State<AuthPaths>,
    path: String,
    contents: String,
    encoding: Option<String>,
) -> Result<WriteStatus, String> {
    let target = authorized_path(&state, &path)?;
    let data = match encode_text(&contents, encoding.as_deref().unwrap_or("utf8")) {
        Ok(d) => d,
        Err(_) => {
            return Ok(WriteStatus {
                saved: false,
                unmappable: true,
            })
        }
    };
    write_atomic(&target, &data)?;
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

/// F-1 授权入口：Rust 侧原生「打开文件」对话框（替代 plugin-dialog 的 open，
/// 因为插件把路径直接返回给 WebView，Rust 侧无回调可积累授权）。
/// 返回的路径 + 其父目录当场进入会话授权集并持久化。返回形态与前端
/// 原 plugin-dialog open({multiple:false}) 一致（string | null）。
/// 注意：async command 携带引用参数（State<'_, T>）必须返回 Result，这里
/// 用 Result<Option<String>, String> 包一层满足约束。
#[tauri::command]
async fn dialog_pick_file(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let mut builder = app.dialog().file();
    if let Some(win) = app.get_webview_window("main") {
        builder = builder.set_parent(&win);
    }
    let picked = builder
        .add_filter("Markdown", &["md", "markdown", "txt"])
        .blocking_pick_file();
    let path = picked
        .and_then(|p| p.into_path().ok())
        .map(|p| p.display().to_string());
    if let Some(p) = &path {
        let state = app.state::<AuthPaths>();
        authorize_path_str(&state, p);
        persist_authorized(&app, &state);
    }
    Ok(path)
}

/// F-1 授权入口：Rust 侧原生「另存为」对话框。目标路径可以尚不存在，
/// 授权按字面路径入集（canonicalize 失败时 authorize_path_str 已兜底）。
#[tauri::command]
async fn dialog_save_file(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let mut builder = app.dialog().file().set_file_name("未命名.md");
    if let Some(win) = app.get_webview_window("main") {
        builder = builder.set_parent(&win);
    }
    let picked = builder
        .add_filter("Markdown", &["md", "markdown", "txt"])
        .blocking_save_file();
    let path = picked
        .and_then(|p| p.into_path().ok())
        .map(|p| p.display().to_string());
    if let Some(p) = &path {
        let state = app.state::<AuthPaths>();
        authorize_path_str(&state, p);
        persist_authorized(&app, &state);
    }
    Ok(path)
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
/// F-1：同样受授权集校验（授权文件本身）；轮询探测不该成为存在性 oracle。
#[tauri::command]
fn path_exists(state: tauri::State<AuthPaths>, path: String) -> bool {
    authorized_path(&state, &path)
        .map(|p| p.exists())
        .unwrap_or(false)
}

/// 文件修改时间（毫秒时间戳），用于外部修改监听轮询比对。
/// F-1：同样受授权集校验（授权文件本身）。
#[tauri::command]
fn file_mtime_ms(state: tauri::State<AuthPaths>, path: String) -> Result<u64, String> {
    let target = authorized_path(&state, &path)?;
    let meta = fs::metadata(&target).map_err(|e| format!("读取元数据失败 {path}: {e}"))?;
    let modified = meta
        .modified()
        .map_err(|e| format!("读取修改时间失败 {path}: {e}"))?;
    Ok(modified
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0))
}

/// 读取任意文件为 base64（把外部图片复制进文档 assets 时用，走 JSON 不适合传原始字节）。
/// F-1：路径必须落在会话授权集内（拖入图片 / 打开的文档所在目录均已授权）。
#[tauri::command]
fn read_file_base64(state: tauri::State<AuthPaths>, path: String) -> Result<String, String> {
    use base64::Engine as _;
    let target = authorized_path(&state, &path)?;
    let bytes = fs::read(&target).map_err(|e| format!("读取失败 {path}: {e}"))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// 把图片（base64）写入文档同目录 assets/，返回 Markdown 里引用的相对路径。
/// 文件名做字符消毒，防路径穿越。
/// N1：doc_path 必须落在会话授权集内（正常流程 currentPath 必经授权入口而来，
/// 零回归；防 XSS 借该 command 向任意目录 assets/ 写文件）。校验放 impl 层，
/// 便于单测构造 &AuthPaths 直接调用。
#[tauri::command]
fn write_asset_file(
    state: tauri::State<AuthPaths>,
    doc_path: String,
    file_name: String,
    data_base64: String,
) -> Result<String, String> {
    write_asset_file_impl(&state, &doc_path, &file_name, &data_base64)
}

fn write_asset_file_impl(
    store: &AuthPaths,
    doc_path: &str,
    file_name: &str,
    data_base64: &str,
) -> Result<String, String> {
    use base64::Engine as _;
    let doc = authorized_path(store, doc_path)?;
    if !fs::metadata(&doc).map(|m| m.is_file()).unwrap_or(false) {
        return Err("文档不存在或不是文件".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64)
        .map_err(|e| format!("图片数据解码失败: {e}"))?;
    let doc_dir = doc.parent().ok_or_else(|| "无法确定文档目录".to_string())?;
    let doc_dir = doc_dir.canonicalize().map_err(|e| format!("{e}"))?;
    let assets = doc_dir.join("assets");
    fs::create_dir_all(&assets).map_err(|e| format!("创建 assets 目录失败: {e}"))?;
    // canonicalize 后再比对：assets 若是指向授权目录外的 junction/symlink，
    // create_dir_all 不会报错，后续写入却会落到目录外。
    let assets = assets
        .canonicalize()
        .map_err(|e| format!("无法解析 assets 目录: {e}"))?;
    if assets.strip_prefix(&doc_dir).is_err() {
        return Err("assets 路径越界".into());
    }
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
    if safe.is_empty() || safe == "." || safe == ".." {
        return Err("图片文件名无效".into());
    }
    let target = assets.join(&safe);
    // 用原子写而不是 fs::write：不跟随已存在的目标链接截断链接目标；
    // 写一半失败也不会破坏已有图片。
    write_atomic(&target, &bytes)?;
    Ok(format!("assets/{}", safe))
}

/// 读取文档目录下的相对资源（图片预览用），返回 base64；防路径穿越。
/// F5：越界判定改组件级 strip_prefix——`C:\doc` 不再误放行 `C:\doc-evil\x`
/// （旧 starts_with 字节前缀比较理论上可被同前缀目录绕过；strip_prefix 按路径
/// 组件比对，余量为空或为相对子路径即合法）。
/// N1：doc_path 同样必须落在会话授权集内（doc_path 目录由调用方任意指定，
/// 若不校验则该 command 可读任意用户可读文件为 base64，绕开 read_file_base64
/// 的授权集）。校验放 impl 层，便于单测构造 &AuthPaths 直接调用。
#[tauri::command]
fn read_asset_base64(
    state: tauri::State<AuthPaths>,
    doc_path: String,
    rel: String,
) -> Result<String, String> {
    read_asset_base64_impl(&state, &doc_path, &rel)
}

fn read_asset_base64_impl(store: &AuthPaths, doc_path: &str, rel: &str) -> Result<String, String> {
    use base64::Engine as _;
    let doc = authorized_path(store, doc_path)?;
    if !fs::metadata(&doc).map(|m| m.is_file()).unwrap_or(false) {
        return Err("文档不存在或不是文件".into());
    }
    let doc_dir = doc.parent().ok_or_else(|| "无法确定文档目录".to_string())?;
    let doc_canonical = doc_dir.canonicalize().map_err(|e| format!("{e}"))?;
    let target = doc_canonical.join(&rel);
    let canonical = target
        .canonicalize()
        .map_err(|e| format!("资源不存在 {}: {e}", target.display()))?;
    // F5 组件级越界判定（doc_dir 已通过授权集校验，此处防 rel 的 ../ 逃逸）
    if canonical.strip_prefix(&doc_canonical).is_err() {
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
    let auth = AuthPaths(Mutex::new(HashSet::new()));

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
                // F-1：用户双击打开的文件即时进入会话授权集
                if let Some(store) = app.try_state::<AuthPaths>() {
                    authorize_path_str(&store, &path);
                    persist_authorized(app, &store);
                }
                if let Some(pending) = app.try_state::<PendingOpen>() {
                    if let Ok(mut q) = pending.0.lock() {
                        q.push(path.clone());
                    }
                }
                let _ = app.emit("open-file", path);
            }
        }))
        // F-1：拖放进窗口的路径即时授权（tauri 自身也在此处为 asset scope 做同款处理）
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                if let Some(store) = window.app_handle().try_state::<AuthPaths>() {
                    let mut changed = false;
                    for p in paths {
                        authorize_path_str(&store, &p.display().to_string());
                        changed = true;
                    }
                    if changed {
                        persist_authorized(window.app_handle(), &store);
                    }
                }
            }
        })
        .setup(move |app| {
            #[cfg(windows)]
            ensure_shell_new();
            // F-1：恢复上次会话授权集（崩溃草稿/最近文件冷启动读取依赖）
            restore_authorized(app.app_handle(), &app.state::<AuthPaths>());
            // 启动 argv 双击路径授权
            if let Some(l) = app
                .state::<LaunchFile>()
                .0
                .lock()
                .ok()
                .and_then(|g| g.clone())
            {
                let store = app.state::<AuthPaths>();
                authorize_path_str(&store, &l);
                // N2：argv 授权与另四入口对齐，落盘持久化——否则纯双击会话的
                // 文件下一会话被授权集误拒（最近列表剔除 / 保存失败 / 自动
                // 保存停摆）。此时集内含 restore 恢复项 + argv 项，全量落盘
                // 不丢数据；argv 路径真实存在，restore 侧存在性过滤下次启动也过。
                persist_authorized(app.app_handle(), &store);
            }
            Ok(())
        })
        .manage(launch)
        .manage(auth)
        .manage(PendingOpen(Mutex::new(Vec::new())))
        .invoke_handler(tauri::generate_handler![
            read_text_file,
            write_text_file,
            dialog_pick_file,
            dialog_save_file,
            take_launch_file,
            take_pending_files,
            path_exists,
            file_mtime_ms,
            read_file_base64,
            write_asset_file,
            read_asset_base64,
            clear_authorized_paths,
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
        let r = decode_bytes("中文 utf8".as_bytes()).unwrap();
        assert_eq!(r.encoding, "utf8");
        assert_eq!(r.text, "中文 utf8");

        // UTF-8 BOM
        let mut with_bom = UTF8_BOM.to_vec();
        with_bom.extend_from_slice("中文".as_bytes());
        let r = decode_bytes(&with_bom).unwrap();
        assert_eq!(r.encoding, "utf8bom");
        assert_eq!(r.text, "中文");

        // 非 UTF-8 字节回退 GBK（"中文" 的 GBK 字节不是合法 UTF-8）
        let (gbk_bytes, _, had_err) = encoding_rs::GBK.encode("中文");
        assert!(!had_err);
        let r = decode_bytes(&gbk_bytes).unwrap();
        assert_eq!(r.encoding, "gbk");
        assert_eq!(r.text, "中文");

        // UTF-16LE BOM（手动构造：FF FE + 小端码元，encoding_rs 的 encode()
        // 对 UTF-16 标签返回的是 UTF-8 字节，不能拿来构造测试向量）
        let mut u16le = vec![0xFF, 0xFE];
        for unit in "中文".encode_utf16() {
            u16le.extend_from_slice(&unit.to_le_bytes());
        }
        let r = decode_bytes(&u16le).unwrap();
        assert_eq!(r.encoding, "utf16le");
        assert_eq!(r.text, "中文");
    }

    #[test]
    fn utf8_bom_with_corrupted_bytes_is_rejected_not_lossy() {
        // F6/code-reviewer F6：BOM + 非法 UTF-8 字节必须报错，
        // 不允许 lossy 替换成 U+FFFD 后被保存固化（静默数据改变）。
        let mut bytes = UTF8_BOM.to_vec();
        bytes.extend_from_slice(b"\xE4\xB8"); // 「中」截断，缺第三字节
        let err = decode_bytes(&bytes).unwrap_err();
        assert!(err.contains("损坏"), "错误信息应说明损坏: {err}");
        // 合法 BOM 文件不受影响
        let mut ok = UTF8_BOM.to_vec();
        ok.extend_from_slice("中文".as_bytes());
        assert_eq!(decode_bytes(&ok).unwrap().text, "中文");
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
            let loaded = decode_bytes(&data).unwrap();
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
    fn write_atomic_refuses_preset_tmp_and_cleans_up() {
        // F-3：create_new 语义——tmp 已存在（攻击者预置 symlink 占位）必须失败，
        // 且失败后不残留垃圾。同目录预置一个「预测不到名」很难，这里直接
        // 验证语义本身：连续两次写同一目标，第一次成功后目录中无 tmp，
        // 第二次（重新生成新随机名）依然成功——随机名不冲突。
        let dir = std::env::temp_dir().join(format!("tl-test-createnew-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("b.md");
        write_atomic(&target, b"first").unwrap();
        write_atomic(&target, b"second").unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"second");

        // create_new 语义直接验证：tmp 路径被外部预置后写入失败且清理
        // （构造：把 write_atomic 内部逻辑以同一随机段复现不可行，改为
        // 验证同等 OpenOptions 行为）
        let preset = dir.join("preset.tmp");
        std::fs::write(&preset, b"x").unwrap();
        let r = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&preset);
        assert!(r.is_err(), "create_new 对已存在文件必须失败");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn authorized_paths_scope_and_component_prefix() {
        // F-1：授权集判定——真实文件系统上的 canonicalize 后组件级比对
        let base = std::env::temp_dir().join(format!("tl-auth-{}", std::process::id()));
        let doc_dir = base.join("doc");
        let evil_dir = base.join("doc-evil"); // 同前缀目录（F5 场景）
        std::fs::create_dir_all(&doc_dir).unwrap();
        std::fs::create_dir_all(&evil_dir).unwrap();
        let doc = doc_dir.join("note.md");
        std::fs::write(&doc, b"# hi").unwrap();
        let evil = evil_dir.join("secret.txt");
        std::fs::write(&evil, b"secret").unwrap();

        let store = AuthPaths(Mutex::new(HashSet::new()));
        authorize_path_str(&store, &doc.display().to_string());

        // 授权文件本身 + 同目录（父目录授权）+ 子路径：放行
        assert!(check_authorized(&store, &doc.display().to_string()).is_ok());
        assert!(check_authorized(&store, &doc_dir.join("other.md").display().to_string()).is_ok());
        // 未授权的越界路径：拒绝（统一错误「路径未授权」）
        let err = check_authorized(&store, &evil.display().to_string()).unwrap_err();
        assert!(err.starts_with("路径未授权"), "统一错误前缀: {err}");
        // 同前缀目录（C:\doc vs C:\doc-evil 场景）必须拒绝——F5 组件级判定
        assert!(check_authorized(&store, &evil.display().to_string()).is_err());
        // 系统敏感路径：拒绝
        assert!(check_authorized(&store, "C:/Windows/System32/config/SAM").is_err());
        // 授权目录内新建子目录文件（另存为新文件后写）：字面路径在父目录授权内
        std::fs::create_dir_all(doc_dir.join("sub")).unwrap();
        assert!(check_authorized(
            &store,
            &doc_dir.join("sub").join("new.md").display().to_string()
        )
        .is_ok());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn nonexistent_target_with_parent_dir_cannot_escape_authorization() {
        // 回归：canonicalize 对不存在的叶子文件失败时，含 .. 的路径曾被
        // starts_with 误判为授权目录内，进而越界新建/读取。
        let base = std::env::temp_dir().join(format!("tl-dotdot-{}", std::process::id()));
        let doc_dir = base.join("doc");
        let outside = base.join("outside");
        std::fs::create_dir_all(&doc_dir).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let doc = doc_dir.join("note.md");
        std::fs::write(&doc, b"# hi").unwrap();
        std::fs::write(outside.join("secret.txt"), b"secret").unwrap();

        let store = AuthPaths(Mutex::new(HashSet::new()));
        authorize_path_str(&store, &doc.display().to_string());

        let escape = doc_dir.join("..").join("outside").join("new.md");
        let err = check_authorized(&store, &escape.display().to_string()).unwrap_err();
        assert!(err.starts_with("路径未授权"), "越界新建必须拒绝: {err}");
        assert!(!outside.join("new.md").exists());

        // 伪造不存在的 doc_path + 同名相对资源，不能绕成越界读取
        let fake_doc = doc_dir.join("..").join("outside").join("fake.md");
        let err = read_asset_base64_impl(&store, &fake_doc.display().to_string(), "secret.txt")
            .unwrap_err();
        assert!(err.starts_with("路径未授权"), "越界读必须拒绝: {err}");
        let err =
            write_asset_file_impl(&store, &fake_doc.display().to_string(), "evil.png", "cG5n")
                .unwrap_err();
        assert!(err.starts_with("路径未授权"), "越界写必须拒绝: {err}");

        // 正常的新文件仍可用：授权目录内尚不存在的子路径
        let fresh = doc_dir.join("not-created-yet.md");
        assert!(check_authorized(&store, &fresh.display().to_string()).is_ok());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn corrupted_legacy_encodings_are_rejected() {
        // UTF-16LE/BE 奇数字节 + 非法 GBK 字节：不得 lossy 成 U+FFFD
        assert!(decode_bytes(&[0xFF, 0xFE, 0x41]).is_err());
        assert!(decode_bytes(&[0xFE, 0xFF, 0x41]).is_err());
        assert!(decode_bytes(&[0x81]).is_err());
        // 合法输入不受影响
        assert_eq!(decode_bytes(b"plain utf8").unwrap().text, "plain utf8");
    }

    #[test]
    fn asset_prefix_is_component_level() {
        // F5：C:\doc 不得放行 C:\doc-evil\secret.txt（真实文件系统验证）
        let base = std::env::temp_dir().join(format!("tl-f5-{}", std::process::id()));
        let doc_dir = base.join("doc");
        let evil_dir = base.join("doc-evil");
        std::fs::create_dir_all(&doc_dir).unwrap();
        std::fs::create_dir_all(&evil_dir).unwrap();
        let doc = doc_dir.join("a.md");
        std::fs::write(&doc, b"a").unwrap();
        std::fs::write(evil_dir.join("secret.txt"), b"s").unwrap();
        std::fs::write(doc_dir.join("ok.png"), b"p").unwrap();

        let store = AuthPaths(Mutex::new(HashSet::new()));
        authorize_path_str(&store, &doc.display().to_string());

        // 合法：文档同目录资源（doc_path 在授权集内）
        assert!(read_asset_base64_impl(&store, &doc.display().to_string(), "ok.png").is_ok());
        // 越界：同前缀目录
        let err =
            read_asset_base64_impl(&store, &doc.display().to_string(), "../doc-evil/secret.txt")
                .unwrap_err();
        assert!(err.contains("越界"), "错误信息: {err}");
        // 越界：纯 ../ 逃逸
        assert!(read_asset_base64_impl(&store, &doc.display().to_string(), "../x").is_err());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn asset_commands_reject_unauthorized_doc_path() {
        // N1：read_asset_base64 / write_asset_file 的 doc_path 未授权时必须拒绝
        // （统一错误「路径未授权」），杜绝「doc_path 任意指定目录」的读写旁路。
        let base = std::env::temp_dir().join(format!("tl-n1-{}", std::process::id()));
        let victim_dir = base.join("victim"); // 攻击者自选目录（未授权）
        let doc_dir = base.join("doc"); // 正常文档目录（授权）
        std::fs::create_dir_all(&victim_dir).unwrap();
        std::fs::create_dir_all(&doc_dir).unwrap();
        let victim = victim_dir.join("target.md");
        std::fs::write(&victim, b"payload").unwrap();
        std::fs::write(doc_dir.join("note.md"), b"# doc").unwrap();
        std::fs::write(doc_dir.join("img.png"), b"p").unwrap();

        let store = AuthPaths(Mutex::new(HashSet::new()));
        authorize_path_str(&store, &doc_dir.join("note.md").display().to_string());

        // 读旁路：doc_path 指向未授权目录 → 拒绝（原实现可读 victim 为 base64）
        let err =
            read_asset_base64_impl(&store, &victim.display().to_string(), "target.md").unwrap_err();
        assert!(err.starts_with("路径未授权"), "统一错误前缀: {err}");
        // 写旁路：doc_path 指向未授权目录 → 拒绝（原实现可向 victim/assets/ 写文件）
        let err = write_asset_file_impl(
            &store,
            &victim.display().to_string(),
            "evil.png",
            "cG5n", // "png"
        )
        .unwrap_err();
        assert!(err.starts_with("路径未授权"), "统一错误前缀: {err}");
        // 旁路被拒后不得留下副作用：victim 目录不应出现 assets/
        assert!(
            !victim_dir.join("assets").exists(),
            "被拒请求不得创建 assets 目录"
        );
        // 授权目录内正常路径不受影响（回归锚：正常流程零回归）
        assert!(write_asset_file_impl(
            &store,
            &doc_dir.join("note.md").display().to_string(),
            "ok.png",
            "cG5n"
        )
        .is_ok());
        assert!(doc_dir.join("assets").join("ok.png").exists());
        // 授权文件本身作为 doc_path（read 侧正常形态）：可读同目录资源
        assert!(read_asset_base64_impl(
            &store,
            &doc_dir.join("note.md").display().to_string(),
            "img.png"
        )
        .is_ok());

        let _ = std::fs::remove_dir_all(&base);
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
