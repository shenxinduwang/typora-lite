# Typora-Lite 安装包

本分支**只放编译好的二进制产物**，源码与文档在 [`main` 分支](https://github.com/shenxinduwang/typora-lite)。

## 最新版本：v0.4.1

| 文件 | 大小 | SHA-256 |
|---|---|---|
| `Typora-Lite_0.4.1_x64-setup.exe`（NSIS，推荐，中文向导） | 2,727,701 B (2.60 MiB) | `2ff92605fef249b64caf7a06feca7f826a157b2928f77f6e2cb3e19dd2fcb49b` |
| `Typora-Lite_0.4.1_x64_zh-CN.msi`（MSI，中文界面） | 3,809,280 B (3.63 MiB) | `5a3ba164ba9293f2ebe27e27c5fee396343b20f9fd5156c3c16242d3499dfbe6` |

直链下载：

- NSIS 安装器：<https://github.com/shenxinduwang/typora-lite/raw/installer/Typora-Lite_0.4.1_x64-setup.exe>
- MSI 安装包：<https://github.com/shenxinduwang/typora-lite/raw/installer/Typora-Lite_0.4.1_x64_zh-CN.msi>

或直接浏览本分支根目录取最新文件。

## 本版变更（0.3.1 → 0.4.1）

- **一键排版整理**（`Ctrl+Shift+T` / 「更多 → 排版整理」）：中英文与数字交界自动补空格、半角标点转全角。代码块、行内代码、链接、URL、HTML 全程豁免，`1.2.3` 这类版本号与 `index.md` 这类文件名不会被误改；改动处数即时反馈，`Ctrl+Z` 一步撤销。
- **设置 → 实验室**：实验性功能的统一开关容器，选择持久化。
  - **`.txt` 纯文本阅读**（默认开）：`.txt` 文件按纯文本显示，不套 Markdown 渲染，打开几十 MB 文本也不做解析装饰。
  - **着重号渲染**（默认关）：`^^文字^^` 在光标离开后渲染为字下圆点着重号。
- **链接视觉分类**：文件链接（相对 / 绝对路径）虚线下划线，网页链接实线下划线。
- **编码猜测提示**：按 GBK 猜测打开的文件给出轻提示「已按 GBK 打开（保存时保持原编码）」，不再静默猜编码。
- **修复：表格补行不再来回切换阅读 / 编辑态**。在已渲染表格的最后一行按 `Enter` 新增行时，整表原本会立刻跳回渲染态、敲出 `|` 又跳回源码态，每加一行弹一次；现在补行全程保持源码编辑，点击 / 方向键停到该行仍正常渲染。
- 工程配套：`npm run lint`（全量语法检查）、`npm test`（纯函数单测），均为零新增依赖。

## 安装说明

- **系统要求**：Windows 10 / 11 x64。
- **WebView2**：NSIS 安装器在缺失 WebView2 运行时会联网自动安装（`downloadBootstrapper`）；MSI 需系统已具备 WebView2 运行时。
- **未做代码签名**：首次运行会被 SmartScreen 拦截，点「更多信息 → 仍要运行」即可。
- **安装后会自动登记 `.md` 关联**：双击 .md 在同一窗口打开（单实例转发）、右键「新建 → Markdown Document」。卸载由 NSIS 钩子清理自注册键，不留残留。
- **校验下载完整性**（PowerShell / cmd）：

  ```bat
  certutil -hashfile Typora-Lite_0.4.1_x64-setup.exe SHA256
  ```

  输出应与上表 SHA-256 一致。

## 版本策略

本分支只保留**最新一版**产物，避免仓库体积膨胀。v0.3.1 的产物在上一提交（`1acd718`）中可查；更早版本（v0.1.0 / v0.2.0 / v0.2.1 / v0.2.2 / v0.2.3）在更早提交中可查，需要旧版也可按 `main` 分支的构建步骤自行编译。

安装包由 `cargo tauri build` 生成，构建步骤见 `main` 分支 README 的「开发」一节。
