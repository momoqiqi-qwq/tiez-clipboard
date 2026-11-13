# 项目规则

## 版本号规则(强制)

每次对项目做出任何改变(代码修改、功能新增、Bug 修复、配置调整等),都必须升级版本号:

1. 版本号当前值:见 `package.json` 的 `version` 字段。
2. 升级时必须同步更新以下四处,保持一致:
   - `package.json`
   - `src-tauri/tauri.conf.json`
   - `src-tauri/Cargo.toml`
   - `src-tauri/Cargo.lock`(只改本项目自身的包条目;`cargo check` / `cargo build` 一般会自动刷新,构建后核对一遍即可)
3. **修复问题 → 升小版本号(补丁位)**:补丁位进一位,其余位不动。
   - 例(修 Bug、修死锁、修界面空白、调依赖兼容):`0.4.8` → `0.4.9`
4. **添加功能 → 升大版本号(次版本位)**:次版本位进一位,补丁位归零。
   - 例(新增标签列表、新增筛选项、新增同步能力):`0.4.8` → `0.5.0`
5. 不兼容的破坏性改动(数据结构需迁移、老配置失效)才升主版本号,次版本位与补丁位归零。
   - 例:`0.5.0` → `1.0.0`
6. 一次改动同时包含「修复 + 新功能」时,按更高的一档升,即按新功能处理(升大版本号)。
7. 纯性能优化、重构、内部清理(对外行为与接口不变、没有新功能)按「修复问题」处理,升小版本号。
8. 纯文档 / 规则文件(如本文件)改动不改变程序行为,默认不升版本号;若要升,则必须重新构建并安装,保证安装版与源码版本号一致。
9. 完成修改后,在最终答复中注明新的版本号,并说明本次属于「修复问题(小版本号)」还是「添加功能(大版本号)」。

## 构建后更新本机应用(强制)

**每次构建出 exe 后,必须把本机日常运行的 TieZ 换成这次构建的新版本。构建完不替换 = 没做完,不要交付。**

- 目标:`E:\E-Apps\Quicker TOOL\Tiez\TieZ.exe`(直接覆盖,**不备份**)
- 源:`src-tauri/target/release/tiez-app.exe`
- 安装版与便携版共用上面这条源路径,后构建者覆盖前者。因此**必须以便携版收尾**:
  1. `npm run tauri:build`(出安装包,NSIS / MSI)
  2. `npm run build:portable`(= `npx tauri build --features portable --no-bundle`)
  - 顺序不能反,否则 `target/release/tiez-app.exe` 停在安装版上。
  - 禁止用 `cargo build --release` 出包:会内嵌 `http://localhost:1420`,运行空白 / ERR_CONNECTION_REFUSED。
- 覆盖前校验源 exe:
  - 必须含 `assets/index-`(生产前端已内嵌)
  - 便携版必须**不含** `CREATE VIRTUAL TABLE IF NOT EXISTS clipboard_fts`(portable feature 生效的证据)
- TieZ 运行中会锁住 exe(覆盖报 os error 32):先结束进程,再复制。
- 现成脚本(内建上面的校验 + 结束进程 + 覆盖 + 复核):

  ```powershell
  pwsh -File 'C:\Users\yile\.agents\skills\tiez-release-build\scripts\install-portable.ps1'
  ```

  不想动进程就加 `-KeepRunning`,脚本会中止并提示先手动退出 TieZ。
- 手工等价写法:

  ```powershell
  Stop-Process -Name TieZ,tiez-app -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 900
  Copy-Item 'E:\E-Develop-Project\tiez-clipboard-master\src-tauri\target\release\tiez-app.exe' 'E:\E-Apps\Quicker TOOL\Tiez\TieZ.exe' -Force
  Get-Item 'E:\E-Apps\Quicker TOOL\Tiez\TieZ.exe' | Select-Object Length,LastWriteTime,@{n='Version';e={$_.VersionInfo.FileVersion}}
  ```

- 覆盖后复核:源与目标大小一致、目标时间已更新;不一致说明没覆盖成功,查文件占用。
- 最终答复必须写清:新版本号、产物路径、已替换的目标路径 + 复核到的大小/版本。
- 只改文档 / 规则、没有构建 → 不涉及本流程;构建失败或校验不通过 → **不许覆盖**,先把失败点报清楚。
