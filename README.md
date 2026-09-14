# Typora-Lite 安装包

本分支**只放编译好的二进制产物**，源码与文档在 [`main` 分支](https://github.com/shenxinduwang/typora-lite)。

## 最新版本：v0.2.3

| 文件 | 大小 | SHA-256 |
|---|---|---|
| `Typora-Lite_0.2.3_x64-setup.exe`（NSIS，推荐） | 2,719,120 B (2.59 MiB) | `63251fdc3a465f9678a7a7a69d865143cb91221260e85a90a429723c942e8fff` |
| `Typora-Lite_0.2.3_x64_en-US.msi` | 3,805,184 B (3.63 MiB) | `86c01d0bf4c5cda4c01a26eb8a26afc531ddcaeca46e9b48a1e5a0caff8ff7f0` |

直链下载：

- NSIS 安装器：<https://github.com/shenxinduwang/typora-lite/raw/installer/Typora-Lite_0.2.3_x64-setup.exe>
- MSI 安装包：<https://github.com/shenxinduwang/typora-lite/raw/installer/Typora-Lite_0.2.3_x64_en-US.msi>

或直接浏览本分支根目录取最新文件。

## 本版变更（0.2.2 → 0.2.3）

**修复远程图片一直显示 broken**：文档里 `![x](https://…)` 形式的 http(s) 远程图片此前被误当成同目录的本地文件去解析（`doc_dir` 拼接带协议的 URL 必然失败，且失败结果被缓存），现已改为直接交给 WebView 加载，同时放行 CSP 的 `img-src`。本地图片与相对路径图片不受影响。

## 安装说明

- **系统要求**：Windows 10 / 11 x64。
- **WebView2**：NSIS 安装器在缺失 WebView2 运行时会联网自动安装（`downloadBootstrapper`）；MSI 需系统已具备 WebView2 运行时。
- **未做代码签名**：首次运行会被 SmartScreen 拦截，点「更多信息 → 仍要运行」即可。
- **安装后会自动登记 `.md` 关联**：双击 .md 在同一窗口打开（单实例转发）、右键「新建 → Markdown Document」。卸载由 NSIS 钩子清理自注册键，不留残留。
- **校验下载完整性**（PowerShell / cmd）：

  ```bat
  certutil -hashfile Typora-Lite_0.2.3_x64-setup.exe SHA256
  ```

  输出应与上表 SHA-256 一致。

## 版本策略

本分支只保留**最新一版**产物，避免仓库体积膨胀。v0.2.2 的产物在上一提交（`38b1052`）中可查；v0.1.0 / v0.2.0 / v0.2.1 未上传，需要旧版请按 `main` 分支的构建步骤自行编译。

安装包由 `cargo tauri build` 生成，构建步骤见 `main` 分支 README 的「开发与打包」一节。
