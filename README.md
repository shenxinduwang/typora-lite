# Typora-Lite 安装包

本分支**只放编译好的二进制产物**，源码与文档在 [`main` 分支](https://github.com/shenxinduwang/typora-lite)。

## 最新版本：v0.4.6

| 文件 | 大小 | SHA-256 |
|---|---|---|
| `Typora-Lite_0.4.6_x64-setup.exe`（NSIS，推荐，中文向导） | 2,814,188 B (2.68 MiB) | `0a58c496eaf52ab1c4ba809aa3e8aafc9c7844483bd537c2ca34e90daa19b5b9` |
| `Typora-Lite_0.4.6_x64_zh-CN.msi`（MSI，中文界面） | 3,944,448 B (3.76 MiB) | `3b5b02544505d7f6f969c577378c06093af43d6e91f1637b0409d8887b672f51` |

直链下载：

- NSIS 安装器：<https://github.com/shenxinduwang/typora-lite/raw/installer/Typora-Lite_0.4.6_x64-setup.exe>
- MSI 安装包：<https://github.com/shenxinduwang/typora-lite/raw/installer/Typora-Lite_0.4.6_x64_zh-CN.msi>

或直接浏览本分支根目录取最新文件。

## 本版变更（0.4.2 → 0.4.6）

- **0.4.6 安全审查收口**：修复不存在路径中的 `..` 可绕过会话授权的问题；损坏 UTF-16/GBK 不再静默替换；图片写入增加目录校验与原子写。修复远程图片开关导致图片消失、外部重载与切文档并发覆盖、清空最近文件后当前文档无法保存、无语言代码块缺复制按钮等问题。
- **0.4.5**：网页 / mailto 链接阅读态悬停显示手型光标。
- **0.4.4**：单击链接直接用系统浏览器打开；外部修改监听、大纲位置锚、自动链接、草稿恢复等多项修复。
- **0.4.3**：远程图片默认不加载（实验室开关）；文件 IPC 收敛到会话授权路径集；原子写加固；损坏 BOM 文件明确报错。
- **0.4.0 / 0.4.1**：一键排版整理、实验室开关（.txt 纯读 / 着重号）、链接虚实线分类、表格补行修复。

完整清单见 `main` 分支 [CHANGELOG.md](https://github.com/shenxinduwang/typora-lite/blob/main/CHANGELOG.md)。

## 安装说明

- **系统要求**：Windows 10 / 11 x64。
- **WebView2**：NSIS 安装器在缺失 WebView2 运行时会联网自动安装（`downloadBootstrapper`）；MSI 需系统已具备 WebView2 运行时。
- **未做代码签名**：首次运行会被 SmartScreen 拦截，点「更多信息 → 仍要运行」即可。
- **安装后会自动登记 `.md` 关联**：双击 .md 在同一窗口打开（单实例转发）、右键「新建 → Markdown Document」。卸载由 NSIS 钩子清理自注册键，不留残留。
- **校验下载完整性**（PowerShell / cmd）：

  ```bat
  certutil -hashfile Typora-Lite_0.4.6_x64-setup.exe SHA256
  ```

  输出应与上表 SHA-256 一致。

## 版本策略

本分支只保留**最新一版**产物，避免仓库体积膨胀。v0.4.2 的产物在上一提交（`697f6a8`）中可查；v0.4.1 在 `dc4ae19`，更早版本也可按 `main` 分支的构建步骤自行编译。

安装包由 `cargo tauri build` 生成，构建步骤见 `main` 分支 README 的「开发」一节。
