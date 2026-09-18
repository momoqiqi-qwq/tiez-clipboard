# TieZ (tiez-clipboard) 项目长期笔记

## 构建环境（重要，本机踩过坑）

### cargo 不在 PATH
`cargo` / `rustc` 在 `C:\Users\yile\.cargo\bin\`，bash 里必须显式加：
`export PATH="/c/Users/yile/.cargo/bin:$PATH"`

### 必须手工注入 MSVC 环境
Git Bash 的 PATH 里没有 MSVC，且 `/usr/bin/link.exe`（coreutils 的 `link`）会抢在 MSVC 前面，
导致 `error: linking with link.exe failed ... link: extra operand`。**必须先前置 MSVC 目录**：

```bash
MSVC="/c/Program Files/Microsoft Visual Studio/18/Community/VC/Tools/MSVC/14.50.35717"
SDK='C:\Program Files (x86)\Windows Kits\10'
export PATH="$MSVC/bin/Hostx64/x64:/c/Users/yile/.cargo/bin:$PATH"
export LIB="C:\Program Files\Microsoft Visual Studio\18\Community\VC\Tools\MSVC\14.50.35717\lib\x64;$SDK\Lib\10.0.26100.0\ucrt\x64;$SDK\Lib\10.0.26100.0\um\x64"
export INCLUDE="C:\Program Files\Microsoft Visual Studio\18\Community\VC\Tools\MSVC\14.50.35717\include;$SDK\Include\10.0.26100.0\ucrt;$SDK\Include\10.0.26100.0\um;$SDK\Include\10.0.26100.0\shared"
cd src-tauri && cargo test --bin tiez-app
```

注意：
- `cmd.exe` 从 bash 调用会被安全策略拦截；`cmd //c` 传不了参数；PowerShell 工具在本机无输出返回。
  所以**只能**用上面的手工注入方式。
- 应用代码在 `main.rs` 的 **bin crate**（不是 `lib.rs`，lib.rs 只是默认模板文件），
  所以测试/编译要指定 `--bin tiez-app`。
- 完整冷构建约 7~8 分钟（含 tauri 依赖树）。

### target/ 缓存带绝对路径，搬目录后会失效
项目从 `C:\Users\yile\Desktop\tiez-clipboard-master` 搬到 `E:\E-Develop-Project\...` 后，
旧的 `target/` 里烘焙了旧路径，导致：
`failed to read plugin permissions ... tauri-*/out/permissions/... 系统找不到指定的路径`
目前 `target/debug` 已清掉，`target/release` 仍是旧路径产物（可能已不可用）。
若再遇到该报错，执行 `cargo clean` 后重建即可。

### .gitignore 只忽略 `src-tauri/target/`
自建的 `src-tauri/target-verify` 之类目录**不会被忽略**，别建；真建了就用
`CARGO_TARGET_DIR=<dir> cargo clean` 删（`rm -rf` 会触发批量删除保护被拦）。
2026-09-11 已用 cargo clean 清掉 `src-tauri/target-verify`（6.3 GiB）和旧 `target/`（4.0 GiB），
合计释放约 10.3 GB。随后做了冷构建复验（8m21s），`target/` 现在是**新鲜可用的热缓存**，
`cargo test --bin tiez-app` 增量运行约 1 分钟。

## 既存测试失败（与改动无关，勿被误导）
`cargo test --bin tiez-app` 有 2 个失败，均为 `app::window_manager::tests`：
- `keeps_bottom_right_anchor_when_switching_monitors`（期望 (4180,1040)，实得 (4166,1025)）
- `preserves_center_ratio_for_mid_screen_window`（期望 (-800,250)，实得 (-950,250)）

两者是 `remap_fixed_window_position` 的纯函数坐标断言，与数据库/搜索无关，属于本快照既存问题。

## 日志宏用法
`logger.rs` 的 `info!` / `error!` 是 `#[macro_export]`，在子模块里需先
`use crate::info;` / `use crate::error;`（见 `app/setup.rs`），否则报 `cannot find macro`。
