# Typora-Lite — 原生 Windows 轻量 Markdown 编辑器（v0.4.1）

一个对标 Typora「所见即所得 / 打字即渲染」体验，但**安装包更小（~2.6 MB）、冷启动更快（无自带浏览器内核）、纯 Windows 原生**的 Markdown 编辑器。

## 特性

- **打字即渲染**：光标离开即隐藏 `#` / `**` / 反引号等标记——标题、粗斜体、行内代码、代码块、引用、链接、任务列表、分割线，全部原地渲染
- **表格真渲染**：列对齐、斑马纹、宽表横向滚动；点击单元格直接进格编辑；单元格内行内代码与粗斜体
- **代码块容器**：圆角容器 + 语言标签 + 一键复制，光标进块回到源码编辑
- **大纲折叠树**：层级折叠、点击跳转、跟随光标高亮当前章节
- **阅读位置记忆**：重开文档自动跳回上次阅读位置
- **一键排版整理**（`Ctrl+Shift+T`）：中英文交界补空格、半角标点转全角，代码/链接/URL 自动豁免
- **实验室**：`.txt` 纯文本即读、`^^着重号^^` 等实验开关，统一容器、选择持久化
- **Windows 刚需**：双击 .md 直接打开、右键新建 Markdown、GBK/UTF-16 编码兼容、原子保存、崩溃草稿恢复、外部修改监听、关窗拦截
- **亮 / 暗主题**、查找替换、图片粘贴/拖入（存文档同目录相对引用）

完整功能清单、已知边界与桌面集成详解见 **[docs/项目详解.md](docs/项目详解.md)**。

## 下载安装（Windows 10/11 x64）

| 安装包 | 大小 | 下载 |
|---|---|---|
| **NSIS 安装器（推荐，中文向导）** | ~2.6 MB | [Typora-Lite_0.4.1_x64-setup.exe](https://github.com/shenxinduwang/typora-lite/raw/installer/Typora-Lite_0.4.1_x64-setup.exe) |
| MSI 安装包（中文界面） | ~3.6 MB | [Typora-Lite_0.4.1_x64_zh-CN.msi](https://github.com/shenxinduwang/typora-lite/raw/installer/Typora-Lite_0.4.1_x64_zh-CN.msi) |

安装包集中放在 [`installer` 分支](https://github.com/shenxinduwang/typora-lite/tree/installer)（该分支只放二进制产物，源码在 `main` 分支），产物清单与 SHA-256 见该分支 README。版本变更见 [CHANGELOG.md](CHANGELOG.md)。

- 系统要求：Windows 10/11 x64。Win10 若缺 WebView2 运行时，NSIS 安装器会联网自动装。
- 未做代码签名，首次运行会被 SmartScreen 拦一下：点「更多信息 → 仍要运行」。
- SHA-256 校验值与产物清单见 installer 分支的 README。

## 开发

**前置**：[Rust](https://rustup.rs)（MSVC 工具链）、Node 18+、WebView2 运行时（Win11 自带）、Visual Studio Build Tools（C++ 桌面负载）。

```bash
npm install          # 装前端依赖

# 首次必须生成图标，否则 tauri 的 generate_context 会因缺少 src-tauri/icons/* 而报错：
#   放一张 1024x1024 的 app-icon.png 到项目根，然后：
npx tauri icon app-icon.png

npm run tauri dev    # 开发：热更新，秒级冷启动
npm run tauri build  # 打包：生成 .msi / .exe 安装包（几 MB）

npm run lint         # 语法检查（node --check，零依赖）
npm test             # 纯函数单测（node --test）
```

产物在 `src-tauri/target/release/bundle/`。

```
typora-lite/
├── index.html              # 入口页
├── src/
│   ├── main.js             # 编辑器组装、文件读写、脏标记、状态机
│   ├── liveMarkdown.js     # ⭐ 打字即渲染核心（CM6 装饰扩展 + 实验室开关）
│   ├── tidy.js             # 排版整理/着重号/链接分类纯函数（node --test 可测）
│   ├── listEditing.js      # 列表 Tab/Shift+Tab 缩进
│   ├── outline.js          # 大纲数据源
│   ├── workspace.js        # 设置/最近/草稿/阅读位置（localStorage）
│   └── style.css           # 编辑区/侧栏样式
├── scripts/lint.mjs        # npm run lint：全量 node --check
├── test/                   # node --test 纯函数单测
├── CHANGELOG.md            # 用户向更新日志
├── docs/                   # 项目详解、观感优化方案
└── src-tauri/              # Rust 后端（编码识别/原子写/单实例/文件关联）
```

技术选型（为何是 Tauri + WebView2 + CodeMirror 6 而非 Electron/WPF/Qt）见 [docs/项目详解.md](docs/项目详解.md)。

## 文档

| 文档 | 内容 |
|---|---|
| [CHANGELOG.md](CHANGELOG.md) | 用户向更新日志（一行一条） |
| [docs/项目详解.md](docs/项目详解.md) | 方案选型、完整功能清单与已知边界、桌面集成详解、观感优化路线决策、版本路线与轮次记录、借鉴 Telari 路线 |
| [docs/观感优化方案.md](docs/观感优化方案.md) | 阅读区观感优化的差距分析与方案（已落地） |
| [docs/开发日志.md](docs/开发日志.md) | 每轮开发/修复的踩坑与解法记录 |
| [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt) | 依赖清单与许可证全文 |

## 参与

- **报问题**：提 Issue 时请附最小复现的 `.md` 内容与 Windows 版本。
- **提 PR**：`npm run tauri dev` 自测通过后再提交；功能/修复尽量小步提交，便于二分回退。
- **改文档**：项目惯例是行为变更同步 `README.md` 与 `docs/开发日志.md`——PR 请遵循。

## 许可

- 本项目代码以 [MIT License](LICENSE) 发布。
- 第三方组件（npm + Rust crate）的完整清单与许可证全文见 [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt)：全部为宽松或弱 copyleft 许可（MIT / Apache-2.0 / BSD-3-Clause / Unicode-3.0 / Unlicense / 0BSD / CC0-1.0 / Zlib / MPL-2.0），**不含 GPL / AGPL**；其中 4 个 crate 为 MPL-2.0（文件级 copyleft，本项目未修改其文件，按 NOTICES 保留声明即可）。
- **WebView2 运行时**不随安装包分发：缺失时由 NSIS 安装器从微软服务器联网获取，适用微软自身的许可条款。
- 依赖变动后重新生成 NOTICES：`cargo tree --format "{p}|{l}"` 配合 `npm ls --omit=dev --all --parseable` 汇总。
- 应用图标 `app-icon.png` 由 AI 生成工具制作；替换请改源图后重跑 `npx tauri icon app-icon.png`。
