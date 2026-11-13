# 文件分类侧栏

目标：为剪贴板历史增加顶端齐平的可折叠左侧栏，支持自定义扩展名分类与持久化。

1. [x] 增加分类配置、扩展名解析和后端分页筛选。验收：Node 格式解析测试与 Rust 文件筛选测试通过。
2. [x] 接入全高侧栏、分类管理和现有查询状态。验收：TypeScript、现有搜索回归测试通过。
3. [x] 检查窄窗口、展开/收起、分类编辑与重启持久化。验收：实际浏览器交互和截图检查通过。
4. [x] 独立评审后同步功能版本 0.11.0，构建并更新本机便携版。验收：安装包与便携版产出、二进制校验通过、源与目标散列相同。

计划复核：当前没有全盘索引，目标是现有剪贴板记录；后端必须先筛选再分页；已有大量用户未提交修改，全部保留。分类沿用主题变量，不增加顶部装饰带；窄窗口默认图标轨道。格式分类与已有类型筛选互斥，但与关键词/标签条件叠加。

基线：`npx tsc --noEmit` 通过。

验证记录：Node 扩展名解析、前端筛选、IPC 分页（261 条、关键词/标签组合）、键盘隔离测试通过；Rust file_search 2/2 通过；TypeScript 通过。CUA 在真实组件预览中检查 352×380 和 720×680、新增/修改/隐藏/非法输入/刷新持久化通过。完整 App 浏览器预览需要 Tauri IPC，桌面集成在安装后验证。

独立评审：`ds-review-loop`，fresh `group/gpt` reviewer，1 轮，VERDICT APPROVE；无 blocker/should。评审者独立重跑 4 项相关 Node 测试通过。其他两个模型路由失败，没有将失败当作批准。

扩大验证的已有失败（不改动无关文件）：
- `node scripts/test-tag-experience.mjs`：原有 tagOptions 已改为 tagFilterOptions，脚本仍依赖旧 filterTagOptions 且未加载 smartTags。
- `cargo test --manifest-path src-tauri/Cargo.toml --bin tiez-app`：100 passed / 3 failed / 2 ignored。迁移 13/14 测试断言 schema=15，当前已有迁移 16；迁移15测试断言标签=3，当前已有5。新增格式筛选测试全部通过。
- `cargo test --manifest-path src-tauri/Cargo.toml --bin tiez-app --features portable file_search -- --nocapture`：2/2 通过。
- 其他 Node 的搜索、标签、键盘和 UI recovery 测试通过。

交付：
- 安装包：`src-tauri/target/release/bundle/nsis/TieZ_0.11.0_x64-setup.exe`，4,834,154 字节。
- 便携包：`artifacts/portable/tiez-portable.zip`。
- `npm run tauri:build -- --bundles nsis --config '{"bundle":{"createUpdaterArtifacts":false}}'` 成功（只在命令覆盖 macOS bundle 目标，不修改用户配置）。
- `npm run build:portable` 成功；生产 assets marker 存在、FTS marker 不存在。
- install-portable.ps1 成功更新 `E:/E-Apps/Quicker TOOL/Tiez/TieZ.exe`，12,320,256 字节，FileVersion 0.11.0。
- 源与目标 SHA256：551777A25D4086ED040BDD8665F51C130A0322ED7F496614651A6A71EC45FDD6。
- 桌面启动成功，实际观察到全高侧栏、展开/收起状态、常用格式入口、管理分类按钮和80条历史正常加载。桌面进一步点击时检测到用户操作，停止输入。分类编辑与保存的交互已在真实组件浏览器预览验证；未将该预览冒充完整桌面验证。
