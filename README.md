# Typora-Lite — 原生 Windows 轻量 Markdown 编辑器（v0.2.3）

一个对标 Typora「所见即所得 / 打字即渲染」体验，但**体积更小、冷启动更快、纯 Windows 原生**的 Markdown 编辑器骨架。

## 下载安装（Windows 10/11 x64）

| 安装包 | 大小 | 下载 |
|---|---|---|
| **NSIS 安装器（推荐）** | ~2.6 MB | [Typora-Lite_0.2.3_x64-setup.exe](https://github.com/shenxinduwang/typora-lite/raw/installer/Typora-Lite_0.2.3_x64-setup.exe) |
| MSI 安装包 | ~3.8 MB | [Typora-Lite_0.2.3_x64_en-US.msi](https://github.com/shenxinduwang/typora-lite/raw/installer/Typora-Lite_0.2.3_x64_en-US.msi) |

安装包集中放在 [`installer` 分支](https://github.com/shenxinduwang/typora-lite/tree/installer)（该分支只放二进制产物，源码在 `main` 分支）。

- 系统要求：Windows 10/11 x64。Win10 若缺 WebView2 运行时，NSIS 安装器会联网自动装。
- 未做代码签名，首次运行会被 SmartScreen 拦一下：点「更多信息 → 仍要运行」。
- SHA-256 校验值与产物清单见 installer 分支的 README。

## 方案选型

核心诉求：原生、体积小、冷启动快、Typora 式实时渲染、仅 Windows。

| 方案 | 体积(打包后) | 冷启动 | Typora 式实时渲染 | 开发成本 | 结论 |
|---|---|---|---|---|---|
| **Tauri 2 + WebView2 + CodeMirror 6**（本仓库采用） | ~5–10 MB | 极快(<300ms) | ✅ CM6 装饰实现打字即渲染 | 中 | **推荐**：二进制小、用系统 WebView2 无需自带浏览器内核 |
| Electron | ~150 MB+ | 慢(自带 Chromium) | ✅ | 低 | ❌ 体积/冷启动不符合 |
| C# WPF + WebView2 | ~30 MB(自包含) | 快 | ✅ 同 CM6 | 中 | 备选，团队熟 .NET 时可用 |
| C++/C# + Scintilla(RichEdit) | 极小 | 极快 | ❌ 只能源码或双栏 | 高 | ❌ 做不到 Typora 式原地渲染 |
| Qt(Rust CXX) | ~40 MB | 快 | ❌ 需自研富文本 | 很高 | ❌ |
| Rust 纯原生(egui/iced) | 小 | 快 | ❌ Markdown 排版需自研 | 很高 | ❌ |

**为什么是 Tauri + WebView2**：Typora 本身就是 Electron(Chromium)，体积和冷启动是其被吐槽的点。Tauri 复用 Windows 自带的 **WebView2（Edge 内核）**，所以安装包只有几 MB、启动没有自带 Chromium 的加载开销；富文本渲染交给前端 **CodeMirror 6**，用「装饰(Decoration)」把 `#`/`**`/`` ` `` 等标记原地隐藏并即时套用样式，得到 Typora 手感。

## 目录结构

```
typora-lite/
├── package.json            # 前端依赖 + vite + tauri-cli
├── vite.config.js          # 前端构建
├── index.html              # 入口页
├── 开发日志.md              # 踩坑与解法记录
├── src/
│   ├── main.js             # 编辑器初始化、文件打开/保存(编码/行尾记忆)、拖放、脏标记
│   ├── liveMarkdown.js     # ⭐ Typora 式实时渲染核心(CM6 装饰扩展)
│   ├── listEditing.js      # 列表 Tab/Shift+Tab 缩进
│   ├── outline.js          # 大纲侧栏数据源(语法树提取标题)
│   └── style.css           # 编辑区/侧栏样式
└── src-tauri/              # Rust 原生后端
    ├── Cargo.toml
    ├── build.rs
    ├── tauri.conf.json     # 窗口/打包/权限配置
    ├── installer-hooks.nsh # NSIS 卸载钩子(清理自注册键)
    ├── capabilities/
    │   └── default.json    # 授权：核心+对话框+窗口标题/销毁
    └── src/
        └── main.rs         # 自定义命令：读写文本文件(编码识别/原子写)、启动文件、单实例
```

## 运行前准备

1. **Rust**：装 `rustup`（默认 MSVC 工具链）。
2. **Node 18+**。
3. **WebView2 运行时**：Win11 自带；Win10 若缺，装一次 [Evergreen WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)。
4. Windows 需 **Visual Studio Build Tools（C++ 桌面负载）** 供 Rust MSVC 链接。

## 开发与打包

```bash
npm install          # 装前端依赖

# 首次必须生成图标，否则 tauri 的 generate_context 会因缺少 src-tauri/icons/* 而报错：
#   放一张 1024x1024 的 app-icon.png 到项目根，然后：
npx tauri icon app-icon.png

npm run tauri dev    # 开发：热更新，秒级冷启动
npm run tauri build  # 打包：生成 .msi / .exe 安装包（几 MB）
```

产物在 `src-tauri/target/release/bundle/`。

## 已实现 / 待扩展

**已实现**
- **查找 / 替换（Ctrl+F）**：`@codemirror/search` 接入，搜索面板置顶（含替换/全部替换）、全部匹配高亮、`F3`/`Shift+F3` 上下导航、`Mod-D` 选中同词；选中的词自动高亮同处出现。
- 新建 / 打开 / 保存 `.md`，快捷键 `Ctrl+S/O/N`，撤销重做、括号自动配对。
- **大纲侧栏（长文目录）**：工具栏「大纲」按钮或 `Ctrl+Shift+O` 开关；提取全文档 H1–H6（含 Setext）生成目录树，点击跳转 + 滚动定位，跟随光标高亮当前章节（`Ctrl+S/O/N` 之外新增快捷键）。
- **未保存关窗拦截**：点 × / Alt+F4 且有改动时弹原生确认（保存并退出 / 放弃修改 / 取消），保存失败（只读盘等）会留在编辑器；浏览器兜底用 `beforeunload` 拦截。切换文档同样有 confirm 拦截。
- **编码兼容（Windows 刚需）**：UTF-8 / UTF-8 BOM / UTF-16LE/BE / **GBK** 自动识别（`encoding_rs`），**保存按原编码写回**（BOM 补回），GBK 中文 .md 不再"双击没反应"；BOM 剥离后首行标题正常渲染。
- **原子保存**：同目录临时文件 + rename 覆盖（Windows 即 `MoveFileEx(REPLACE_EXISTING)`），写一半崩溃不损坏原文件。
- **打开/保存失败弹原生错误框**：不再只进 console 表现为"点了没反应"。
- **撤销历史与文件切换隔离**：载入/新建走 `EditorState` 整体重建，Ctrl+Z 不会"撤销回上一个文件"。
- **纯浏览器亦可运行**：无 Tauri 时用文件选择器打开（TextDecoder 按 BOM/GBK 解码）、Blob 下载保存（UTF-8，BOM 按原文件补回）；在 Tauri 内走原生命令（`IS_TAURI` 自动切换）。
- **未保存脏标记**：LF 归一快照精确比较（CRLF 文件打开即脏的误报已修），标题栏 / 文件名后加 `•`；标题变化才走一次 IPC。
- **最近文件 + 启动恢复**：记录最近 10 个文件（工具栏「最近」下拉直达、可清空）；无启动参数时自动恢复上次文档（文件已删除则静默剔除）。
- **自动保存 + 崩溃恢复**：脏文档每 3s 写本地草稿，崩溃/误关后下次启动询问恢复；「自动保存」开关开启后每 30s 静默保存到原文件（IME 合成期跳过）。
- **外部文件修改监听**：3s 轮询 mtime，文档干净时自动重载，有本地改动时询问是否丢弃重载。
- **图片粘贴 / 拖入**：截图直接 Ctrl+V、图片文件拖进窗口，自动存到文档同目录 `assets/` 并插入相对路径引用（文档未保存时用 data URL）；浏览器模式插入 data URL。
- **CSP 收紧**：`default-src 'self'` 白名单策略（样式放行内联供 CM6 注入、`img-src data:` 供 data URL 图片、`connect-src ipc:` 供 Tauri IPC），不再依赖 `csp: null`。
- **图片预览（WYSIWYG）**：光标不在 `![alt](src)` 内时渲染为真 `<img>`（相对路径经 Rust 转 base64 data URL，带缓存与加载/失败态样式），光标进入显示源码。
- **链接折叠 + Ctrl+Click 打开**：光标不在链接内时只显示链接文字（URL/括号折叠），独立 URL 自动上色；Ctrl/Cmd+点击用系统默认程序打开（http/https/mailto 白名单）。
- **GBK 保存保护**：文档含 GBK 无法表示的字符（emoji/生僻字）时拒绝静默写乱码，弹窗引导一键改存 UTF-8。
- **外部重载保视图**：外部修改触发的同文件重载保留光标与滚动位置（普通 dispatch，不清撤销栈）；跨文件载入仍走整体重建。
- **暗色全套**：查找面板、tooltip、补全框跟随主题变量，暗色下不再白底。
- 版本 **0.2.3**（0.1.0 → 0.2.0：大纲/拖放/草稿/编码/图片/大纲侧栏/两轮审查修复；0.2.0 → 0.2.1：链接打开防命令注入、浏览器草稿恢复判脏、UTF-16 保存损坏修复、保存重入保护、图片缓存按文档隔离、Rust 单元测试；0.2.1 → 0.2.2：失败图缓存不再反复重试、启动 open-file 竞态缓冲、URL 白名单大小写对齐、图片 title 解析、拖放图 2MB 守卫、loadFile 串行化；0.2.2 → 0.2.3：**远程 http(s) 图片直接加载**（此前被误当本地路径解析必 broken）、CSP img-src 放行 http:/https:）。
- **代码块语法高亮**：`@codemirror/language-data` 按 fenced code 语言标签自动着色（js/py/rust/…，懒加载按需解析）。
- **拖放 .md 打开**：把 .md/.markdown/.txt 拖进窗口即打开（Tauri 走原生 `onDragDropEvent`，浏览器走 HTML5 drop），带脏确认与编码识别。
- **列表编辑手感**：回车自动续接列表（有序递增、任务项重置为 `[ ]`、空项回车退出、引用延续，`lang-markdown` 内建）+ `Tab`/`Shift+Tab` 列表缩进（自研 `listEditing.js`，支持多行选区）。
- Typora 式原地渲染：标题、粗体 / 斜体、行内代码、代码块（`FencedCode`）、引用块、链接、**分割线（widget 渲染成真横线）**、删除线。
- **任务列表可点击切换**：`[ ]` / `[x]` 原地渲染成复选框 widget，点一下即在源码里互转；光标进入该项时恢复显示原始 `[ ]` 便于手改。（`mousedown` 用 `posAtDOM` 从被点 DOM 反查精确位置——`posAtCoords` 对无文本宽度的 replace widget 会跨行错位。）
- **列表符 / 表格原地渲染**：列表标记 `ListMark` 高亮、表头行 `TableHeader` 加粗、表格分隔符 `|` 弱化。
- **亮 / 暗主题**：所有颜色走 CSS 变量；默认跟随系统（`matchMedia` 实时翻转），工具栏「主题」按钮可手动循环 自动/亮/暗，选择持久化（`data-theme` 属性驱动）。
- **已启用 GFM**（`@lezer/markdown` 的 `GFM` 传入 `markdown({extensions})`）：表格、任务列表、删除线、自动链接均能被解析成语法节点（Table/TableCell、Task/TaskMarker、Strikethrough）。
- **光标聚焦才显示标记**：光标离开某段时 `# ** \` > ~~` 自动隐藏，光标移入即重新显示——真正的 Typora 折叠体验（已在浏览器实测：`## 支持` 渲染为「支持」，光标所在的 `# 标题` 保留井号）。
- 同一行叠加多种行样式（如「引用块里的标题」`> # x`）已做**按行聚合**，不会因重复行装饰导致渲染层报错白屏。
- **中文 IME 合成期不重建装饰**（`u.view.composing` 守卫），避免候选词被打断掉字。
- **双击 .md 打开到当前窗口**：Rust `env::args` 捕获路径 + `take_launch_file` 首开；`tauri-plugin-single-instance` 让"再次双击别的 .md"不开新窗，而是 `emit("open-file")` 转发给已存在窗口并**先 unminimize 再聚焦**（最小化状态也能弹出）；Rust 端同时把路径入 `PendingOpen` 队列，前端订阅就绪后补捞，竞态窗口内也不丢文件。窗口标题实时反映当前文件名（需 `core:window:allow-set-title` 权限）。
- **右键"新建 → Markdown Document"**：App 首次启动 `setup()` 用 `winreg` 写 `HKCU\Software\Classes\<ext>\ShellNew` + 自建 ProgId（不覆盖默认关联），**免管理员、免手动导 reg**，路径始终按 `current_exe()` 自愈。

**待扩展 / 已知边界**
- 表格仅做样式渲染，**未做单元格级 WYSIWYG 编辑**（渲染成真 `<table>` 交互或弹出编辑面板是后续目标）。
- **双栏预览模式、KaTeX / Mermaid**：需要引入 markdown-it/KaTeX/Mermaid 渲染栈，与「lite」体积定位有张力，建议作为可选增强单独立项。
- **代码签名与 SmartScreen**：面向分发需要代码签名证书（硬成本）。
- 加固暂缓项：IPC 读写路径白名单校验（CSP 已收紧；当前 IPC 威胁模型为"无远程内容、无 XSS 面"）。

## 桌面集成（.md 关联 / 双击打开 / 右键新建）

**全自动、免管理员、换机即用**——不存在任何带绝对路径的手工注册表文件：

- **双击打开**：`tauri.conf.json` 的 `bundle.fileAssociations` 让安装器按实际安装路径注册 `.md`/`.markdown` 默认关联（ProgId `md`、`shell\open\command = "<exe>" "%1"`）。装完双击即在**同一窗口**打开（单实例 + `open-file` 事件转发），标题栏显示当前文件名。
- **右键"新建 → Markdown Document" + "打开方式"登记**：App 首次启动时 `setup()` 用 `winreg` 按 `current_exe()` 实际路径往 `HKCU\Software\Classes` 写 `<ext>\ShellNew`(NullFile) 与自建 ProgId `Typora-Lite.md`，**刻意不覆盖默认关联**（避免每次启动抢回用户改过的默认编辑器）。全部幂等、每次启动自愈（exe 挪位置后路径自动修正）。
- 若右键"新建"没立刻出现，是资源管理器缓存了子菜单，刷新即可：`ie4uinit.exe -show` 或重启 explorer。
- **卸载自动清理**：NSIS 卸载钩子（`installer-hooks.nsh` 的 `NSIS_HOOK_POSTUNINSTALL`）删除 App 自注册的 `Typora-Lite.md` ProgId、`.md`/`.markdown` 的 ShellNew 值与 `OpenWithProgids` 登记值；`OpenWithProgids` 里**其他应用**的 ProgId（形如 `xxxMD.*`）只删自己的值、键用 `/ifempty` 保留。
- **绝对不要手工写 .reg 导入关联**：.reg 不会展开环境变量，硬编码的 `C:\Users\<用户名>\...` 换台机器就是指向不存在的程序（实测踩坑）。手动改关联的正确姿势：右键 .md → 打开方式 → 选择其他应用 → Typora-Lite → 勾选"始终"。

## 运行状态

前端已通过 `npm run dev`（vite）在浏览器实测渲染无误。原生壳层已跑通：装好 **VS Build Tools 2022（C++ 工作负载，含 MSVC `link.exe` + Windows SDK）** 后，`npm run tauri build` 成功产出 `bundle/` 下的 `.msi`(~3.4MB) 与 nsis `-setup.exe`(~2.3MB)。最新交付的安装包见 [`installer` 分支](https://github.com/shenxinduwang/typora-lite/tree/installer)。

**2026-09-13 数据安全/编码/性能修复轮**（详见 `开发日志.md` 第 8 节，全部真机验证）：关窗未保存拦截（取消/放弃/保存并退出三路实测）、Ctrl+Z 跨文件回退修复、GBK/UTF-8 BOM/UTF-16 识别与按原编码回写（iconv 造文件 + 回读字节级验证）、原子保存、打开/保存失败弹错、单实例转发竞态兜底、每键 IPC/全文字符串比较性能优化、选区主题色、分割线渲染、`core:window:allow-destroy` 权限补授、vite watch EBUSY 修复。

**2026-09-13 功能轮**（详见 `开发日志.md` 第 9 节）：查找/替换（Ctrl+F，全部匹配高亮）、代码块按语言着色、列表手感（内建回车续写 + 自研 Tab/Shift+Tab 缩进）、拖放 .md 打开、大纲侧栏（目录树/点击跳转/跟随光标高亮）。均经浏览器断言 + 安装版真机截图验证。

**2026-09-13 跨机部署修复**（详见 `开发日志.md` 第 10 节）：删除硬编码个人路径的 `md-association.reg`（跨机导入会指向不存在的程序）；新增 NSIS 卸载钩子 `installer-hooks.nsh` 清理运行时自注册键与悬挂默认值（其他应用登记值保留），本机完成"装→卸→清理→重装"全闭环验证。桌面集成现在是真正的**全自动、免管理员、换机即用、卸载干净**。

**2026-09-13 待扩展功能轮**（详见 `开发日志.md` 第 11 节）：手动主题切换（自动/亮/暗，持久化）、最近文件 + 启动恢复上次文档、崩溃草稿恢复（3s 草稿 + 编码/行尾随存）、可开关的 30s 自动保存、外部文件修改监听（mtime 轮询，干净静默重载/脏时确认）、图片粘贴与拖入（存 `assets/` 插相对引用）、CSP 收紧。浏览器断言 + 安装版真机逐项验证（含外部追加行自动重载、剪贴板图片落盘 assets/、无参数重启恢复）。

**2026-09-13 双报告复核修复轮（v0.2.0）**（详见 `开发日志.md` 第 12 节）：修复外部审查确认的 P0×2（草稿恢复判"干净"致二次丢数据；GBK 存 emoji 写成 `&#128512;`，现弹窗引导改存 UTF-8）、P1×3（保存/mtime 竞态、mtime 失败永久关监听、恢复草稿吞启动文件）、渲染补齐×5（CodeInfo/Setext/链接折叠/表格分隔行/**图片预览**）+ Ctrl+Click 开链接 + 暗色面板 + P3 批量优化。渲染组经浏览器断言验证，P0-2 与图片预览经安装版真机验证。跑前记得 `export PATH="$USERPROFILE/.cargo/bin:$PATH"`。

**2026-09-13 v0.2.1 复审修复轮**（详见 `开发日志.md` 第 13 节）：单元测试抓出 **UTF-16 文件保存必损坏**（`encoding_rs::encode()` 对 UTF-16 标签返回 UTF-8 字节，已改手动编码码元，往返单测守卫）；`open_external` 改 `rundll32` 杜绝 URL 经 `cmd` 的命令注入；浏览器分支草稿恢复判脏（补上 P0-1 修漏的同类项）；`selfWriting` 释放时机后移 + 保存重入保护；图片缓存按文档路径隔离（跨文档同名 rel 不再串图，外部改图能刷新）；浏览器 Ctrl+Click 兜底 `window.open`。`cargo test` 5/5 通过，vite/cargo 构建全绿。

**2026-09-13 v0.2.2 二次评审修复轮**（详见 `开发日志.md` 第 14 节）：失败图片缓存改 `has()` 判存（不再每次重绘重发注定失败的 IPC）；启动期 open-file 事件缓冲（崩溃恢复确认期间到达的载入不再被恢复分支静默覆盖）；`is_allowed_url` 大小写归一（`HTTP://` 链接不再被 Rust 端误拒）；`![alt](src "title")` 的 src 正确剥离 title；浏览器拖放图片复用 2MB data URL 守卫；`loadFile` promise 链串行化（连开请求不再互相覆盖）。修复经 code-reviewer 子代理逐行核验无回归；`cargo test` 5/5、构建全绿，0.2.2 双安装包已入交付目录。

**2026-09-13 v0.2.2 真机验证轮**：0.2.2 静默安装升级成功；脚本驱动 GUI + 字节级断言全部通过——UTF-16LE 保存往返无损（`ff fe` + 合法码元，无旧 bug 特征）、GBK 粘 emoji 转存 UTF-8 全流程（确认框 Enter 后 `f0 9f 98 80` 完整落盘）、强杀崩溃 → 草稿恢复 → 恢复内容判脏（标题 `•`）、干净退出/两步放弃退出/无参数恢复最近文档均正常。本机已装 0.2.2。

**2026-09-14 v0.2.3 网络图片修复轮**（详见 `开发日志.md` 第 15 节）：外部评审发现知乎等外部文档的 `https://` 远程图片全部 broken——`toDOM` 把带协议 URL 误当本地路径丢给 `read_asset_base64` 必失败。修复：远程 src 直接交给 WebView 加载 + CSP `img-src` 放行 `http:/https:`。真机经 WebView2 CDP 远程调试断言：本地 HTTP 服务图命中服务端日志、知乎图加载成功、**用户真实知乎文档 19 个图片实例 19 ok / 0 broken**、相对路径本地图片回归通过。版本 0.2.3 已入交付目录，本机已装。

## 许可与第三方组件

- **本项目自身代码：MIT License**，见 [`LICENSE`](LICENSE)。
- **第三方组件**：267 个依赖（npm 生产依赖 53 个 + 进入 Windows 产物的 Rust crate 214 个）的完整清单、按许可证分组的出处、以及每份许可证全文，见 [`THIRD-PARTY-NOTICES.txt`](THIRD-PARTY-NOTICES.txt)。全部为宽松或弱 copyleft 许可（MIT / Apache-2.0 / BSD-3-Clause / Unicode-3.0 / Unlicense / 0BSD / CC0-1.0 / Zlib / MPL-2.0），**不含 GPL / AGPL 等强 copyleft 依赖**。
  - 其中 4 个 crate 为 MPL-2.0（`cssparser` / `selectors` / `dtoa-short` / `option-ext`）。MPL-2.0 是文件级 copyleft：仅当修改了这些文件本身才需要回馈其源码；本项目未做修改，按 NOTICES 保留其许可声明与出处即可。
  - 依赖变动后重新生成：`cargo tree --format "{p}|{l}"`（取真正进入产物的 normal 依赖及其许可证）配合 `npm ls --omit=dev --all --parseable`（生产依赖）汇总。
- **WebView2 运行时**：安装包不捆绑、不再分发微软的 WebView2 运行时——NSIS 安装器在目标机缺失该运行时会从微软服务器联网获取，因此该运行时适用微软自身的许可条款。
- **应用图标**：`app-icon.png` 由 AI 生成工具制作。替换图标请改这张源图后重跑 `npx tauri icon app-icon.png` 重新生成 `src-tauri/icons/`。
