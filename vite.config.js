import { defineConfig } from "vite";

// Tauri 期望 vite 输出固定端口与相对路径资源
export default defineConfig({
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    // 不监听 Rust 构建产物：cargo 编译时会锁住 target 下的 dll，
    // Windows 上 chokidar watch 被锁文件会抛 EBUSY 直接把 dev server 搞崩
    watch: {
      ignored: ["**/src-tauri/target/**"],
    },
  },
  build: {
    target: ["es2021", "chrome105"], // WebView2 基于 Chromium
    outDir: "dist",
    emptyOutDir: true,
  },
});
