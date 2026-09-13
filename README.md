# Typora-Lite 安装包

本分支**只放编译好的二进制产物**，源码与文档在 [`main` 分支](https://github.com/shenxinduwang/typora-lite)。

## 最新版本：v0.2.2

| 文件 | 大小 | SHA-256 |
|---|---|---|
| `Typora-Lite_0.2.2_x64-setup.exe`（NSIS，推荐） | 2,716,097 B (2.59 MiB) | `c0b3fe24aeacd3987f2dcecbbb9447d197e59baf526342c6d019412f43478725` |
| `Typora-Lite_0.2.2_x64_en-US.msi` | 3,801,088 B (3.63 MiB) | `bdc0542e739016f45a06c51d192eb5c96ea2caa54946c6d36ae7d5c1ff788060` |

直链下载：

- NSIS 安装器：<https://github.com/shenxinduwang/typora-lite/raw/installer/Typora-Lite_0.2.2_x64-setup.exe>
- MSI 安装包：<https://github.com/shenxinduwang/typora-lite/raw/installer/Typora-Lite_0.2.2_x64_en-US.msi>

或直接浏览本分支根目录取最新文件。

## 安装说明

- **系统要求**：Windows 10 / 11 x64。
- **WebView2**：NSIS 安装器在缺失 WebView2 运行时会联网自动安装（`downloadBootstrapper`）；MSI 需系统已具备 WebView2 运行时。
- **未做代码签名**：首次运行会被 SmartScreen 拦截，点「更多信息 → 仍要运行」即可。
- **安装后会自动登记 `.md` 关联**：双击 .md 在同一窗口打开（单实例转发）、右键「新建 → Markdown Document」。卸载由 NSIS 钩子清理自注册键，不留残留。
- **校验下载完整性**（PowerShell / cmd）：

  ```bat
  certutil -hashfile Typora-Lite_0.2.2_x64-setup.exe SHA256
  ```

  输出应与上表 SHA-256 一致。

## 版本策略

本分支只保留**最新一版**产物，避免仓库体积膨胀。历史版本（v0.1.0 / v0.2.0 / v0.2.1）未上传，需要旧版请按 `main` 分支的构建步骤自行编译。

安装包由 `cargo tauri build` 生成，构建步骤见 `main` 分支 README 的「开发与打包」一节。
