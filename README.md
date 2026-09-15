# Typora-Lite 安装包

本分支**只放编译好的二进制产物**，源码与文档在 [`main` 分支](https://github.com/shenxinduwang/typora-lite)。

## 最新版本：v0.3.1

| 文件 | 大小 | SHA-256 |
|---|---|---|
| `Typora-Lite_0.3.1_x64-setup.exe`（NSIS，推荐，中文向导） | 2,726,166 B (2.60 MiB) | `e6bbf207773670da07010f689e416e0350d0904f082237bf57916846491c2566` |
| `Typora-Lite_0.3.1_x64_zh-CN.msi`（MSI，中文界面） | 3,809,280 B (3.63 MiB) | `aba985aaab3eac0fbe3caa7c46a83f1f58df027ce4c63bd316e1501e2258cbf5` |

直链下载：

- NSIS 安装器：<https://github.com/shenxinduwang/typora-lite/raw/installer/Typora-Lite_0.3.1_x64-setup.exe>
- MSI 安装包：<https://github.com/shenxinduwang/typora-lite/raw/installer/Typora-Lite_0.3.1_x64_zh-CN.msi>

或直接浏览本分支根目录取最新文件。

## 本版变更（0.2.3 → 0.3.1）

**阅读区观感大改**（渲染层级从 `mark` 换成 line / block 装饰，此前画不出的容器一次性补齐）：

- **代码块真容器**：圆角 + 描边 + 内边距，顶部头部条含语言标签与「复制」按钮（走系统剪贴板，不依赖额外插件）；光标进块即回到源码编辑态。
- **表格真渲染**：光标不在表内时整表渲染成真实表格——列对齐（`:---` / `:--:` / `---:`）、斑马纹、宽表横向滚动；点击单元格直接进格编辑，单元格内的行内代码与粗斜体同样渲染。
- **列表层级圆点**：无序列表符折叠为 `•` / `◦` / `▪`，按嵌套层级取符号。
- **大纲折叠树**：层级可折叠、文档名为根节点、跟随光标高亮当前章节。
- **阅读位置记忆**：重开文档自动跳回上次的光标与滚动位置。
- **标题间距改用 padding**：修掉旧版用 margin 造成的点击定位漂移与滚动条高度不准。
- 顶栏改 SVG 图标 + 「更多」下拉菜单（自动保存 / 主题），新增轻提示 toast。

**安装器界面中文化**：NSIS 向导用简体中文（不再弹语言选择器），MSI 的语言标识由 `en-US` 改为 `zh-CN`（文件名随之变化），右键关联项描述改中文。注意 MSI 的语言标识属打包元数据变更——**升级安装若报「已安装其他版本」，先卸载旧版再装本版**。

## 安装说明

- **系统要求**：Windows 10 / 11 x64。
- **WebView2**：NSIS 安装器在缺失 WebView2 运行时会联网自动安装（`downloadBootstrapper`）；MSI 需系统已具备 WebView2 运行时。
- **未做代码签名**：首次运行会被 SmartScreen 拦截，点「更多信息 → 仍要运行」即可。
- **安装后会自动登记 `.md` 关联**：双击 .md 在同一窗口打开（单实例转发）、右键「新建 → Markdown Document」。卸载由 NSIS 钩子清理自注册键，不留残留。
- **校验下载完整性**（PowerShell / cmd）：

  ```bat
  certutil -hashfile Typora-Lite_0.3.1_x64-setup.exe SHA256
  ```

  输出应与上表 SHA-256 一致。

## 版本策略

本分支只保留**最新一版**产物，避免仓库体积膨胀。v0.2.3 的产物在上一提交（`cd1d985`）中可查；v0.1.0 / v0.2.0 / v0.2.1 / v0.2.2 的产物在更早提交中可查，需要旧版也可按 `main` 分支的构建步骤自行编译。

安装包由 `cargo tauri build` 生成，构建步骤见 `main` 分支 README 的「开发」一节。
