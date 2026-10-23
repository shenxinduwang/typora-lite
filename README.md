# Typora-Lite 安装包

本分支**只放编译好的二进制产物**，源码与文档在 [`main` 分支](https://github.com/shenxinduwang/typora-lite)。

## 最新版本：v0.4.2

| 文件 | 大小 | SHA-256 |
|---|---|---|
| `Typora-Lite_0.4.2_x64-setup.exe`（NSIS，推荐，中文向导） | 2,727,858 B (2.60 MiB) | `dd9317bcb49d3fb9044efd5cac82cfcc39b806fe0ca4366397aa8585dfe2cea1` |
| `Typora-Lite_0.4.2_x64_zh-CN.msi`（MSI，中文界面） | 3,809,280 B (3.63 MiB) | `a7062ecca7e4e4e435377abba0dd841624c14dbcedf44d668593a1a1dbfad7a2` |

直链下载：

- NSIS 安装器：<https://github.com/shenxinduwang/typora-lite/raw/installer/Typora-Lite_0.4.2_x64-setup.exe>
- MSI 安装包：<https://github.com/shenxinduwang/typora-lite/raw/installer/Typora-Lite_0.4.2_x64_zh-CN.msi>

或直接浏览本分支根目录取最新文件。

## 本版变更（0.4.1 → 0.4.2）

- **大纲跟随滚动阅读位置**：正文滚动阅读时，大纲高亮原本冻结在**光标**所在章节（滚到 2.4 却高亮 4.2）。现在按**视口顶部**实时同步高亮，大纲列表自动跟到当前条目；点开大纲时也按当前阅读位置定位。
- **取舍**：光标 / 点击仍优先——打字引起的编辑器自动滚动不会抢走高亮，用户真正滚动后才切换为「阅读位置优先」。

## 安装说明

- **系统要求**：Windows 10 / 11 x64。
- **WebView2**：NSIS 安装器在缺失 WebView2 运行时会联网自动安装（`downloadBootstrapper`）；MSI 需系统已具备 WebView2 运行时。
- **未做代码签名**：首次运行会被 SmartScreen 拦截，点「更多信息 → 仍要运行」即可。
- **安装后会自动登记 `.md` 关联**：双击 .md 在同一窗口打开（单实例转发）、右键「新建 → Markdown Document」。卸载由 NSIS 钩子清理自注册键，不留残留。
- **校验下载完整性**（PowerShell / cmd）：

  ```bat
  certutil -hashfile Typora-Lite_0.4.2_x64-setup.exe SHA256
  ```

  输出应与上表 SHA-256 一致。

## 版本策略

本分支只保留**最新一版**产物，避免仓库体积膨胀。v0.4.1 的产物在上一提交（`dc4ae19`）中可查；更早版本（v0.1.0 / v0.2.0 / v0.2.1 / v0.2.2 / v0.2.3 / v0.3.1 / v0.4.0）在更早提交中可查，需要旧版也可按 `main` 分支的构建步骤自行编译。

安装包由 `cargo tauri build` 生成，构建步骤见 `main` 分支 README 的「开发」一节。
