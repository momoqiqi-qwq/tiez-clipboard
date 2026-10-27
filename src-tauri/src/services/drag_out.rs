//! 出站拖拽：把剪贴板条目落成真实文件，再交给 OLE `DoDragDrop`。
//!
//! 前端在条目的 `mousedown` 里调用 `start_drag_out(id)`（此时鼠标还按着），
//! 这里把条目内容写到临时目录，构造一个只提供 `CF_HDROP` 的 `IDataObject`，
//! 然后在独立线程里跑 OLE 拖拽循环。于是资源管理器、桌面、任何接受文件拖放的
//! 窗口都能收到它——拖出去的是「文件」，不是文本。

use std::cell::Cell;
use std::mem::ManuallyDrop;
use std::path::{Path, PathBuf};
use std::ptr;
use std::time::{Duration, SystemTime};

use base64::{engine::general_purpose, Engine as _};
use tauri::{AppHandle, Manager, State};
use windows::core::{implement, BOOL, HRESULT};
use windows::Win32::{
    Foundation::{
        DV_E_FORMATETC, E_INVALIDARG, E_NOTIMPL, E_OUTOFMEMORY, HGLOBAL, OLE_E_ADVISENOTSUPPORTED,
        POINT, S_FALSE, S_OK, DRAGDROP_S_CANCEL, DRAGDROP_S_DROP, DRAGDROP_S_USEDEFAULTCURSORS,
    },
    System::{
        Com::{
            IAdviseSink, IDataObject, IDataObject_Impl, IEnumFORMATETC, IEnumFORMATETC_Impl,
            IEnumSTATDATA, DVASPECT_CONTENT, FORMATETC, STGMEDIUM, STGMEDIUM_0, DATADIR_GET,
            TYMED_HGLOBAL,
        },
        Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE, GMEM_ZEROINIT},
        Ole::{
            DoDragDrop, IDropSource, IDropSource_Impl, OleInitialize, OleUninitialize, CF_HDROP,
            CF_UNICODETEXT, DROPEFFECT, DROPEFFECT_COPY,
        },
        SystemServices::{MODIFIERKEYS_FLAGS, MK_LBUTTON, MK_RBUTTON},
    },
    UI::Input::KeyboardAndMouse::ReleaseCapture,
    UI::Shell::DROPFILES,
};

use crate::database::DbState;
use crate::error::AppError;
use crate::infrastructure::repository::clipboard_repo::ClipboardRepository;

/// 拖出文件落地目录（与入站拖拽的临时目录区分开）。
const DRAG_OUT_DIR: &str = "TieZ_DragOut";
/// 落地文件保留时长，超过就在下一次拖出时清理。
const KEEP_FOR: Duration = Duration::from_secs(30 * 60);
const MAX_STEM: usize = 24;

struct ResolvedEntry {
    content_type: String,
    content: String,
    html_content: Option<String>,
}

/// 从数据库（id > 0）或会话历史（id < 0）里取出完整条目内容。
fn resolve_entry(app: &AppHandle, state: &State<'_, DbState>, id: i64) -> Result<ResolvedEntry, AppError> {
    if id < 0 {
        let session = app.state::<crate::app_state::SessionHistory>();
        let items = session.0.lock().map_err(|e| AppError::Internal(e.to_string()))?;
        let item = items
            .iter()
            .find(|item| item.id == id)
            .ok_or_else(|| AppError::Internal("会话条目已不存在".into()))?;
        return Ok(ResolvedEntry {
            content_type: item.content_type.clone(),
            content: item.content.clone(),
            html_content: item.html_content.clone(),
        });
    }

    let entry = state
        .repo
        .get_entry_by_id(id)
        .map_err(AppError::from)?
        .ok_or_else(|| AppError::Internal("条目已不存在".into()))?;

    Ok(ResolvedEntry {
        content_type: entry.content_type,
        content: entry.content,
        html_content: entry.html_content,
    })
}

/// 把条目内容落成可以让资源管理器接收的文件；返回绝对路径列表。
fn materialize(entry: &ResolvedEntry, id: i64) -> Result<Vec<PathBuf>, AppError> {
    let dir = std::env::temp_dir().join(DRAG_OUT_DIR);
    std::fs::create_dir_all(&dir)?;
    prune_old_files(&dir);

    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
    let stem = format!("{}_{}", slug_of(&entry.content, id), stamp);

    match entry.content_type.as_str() {
        "file" | "video" => {
            // 这两类存的就是原文件路径（可能是多行）。
            let mut paths = Vec::new();
            for line in entry.content.lines() {
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                let path = Path::new(line);
                if path.exists() {
                    paths.push(path.to_path_buf());
                }
            }
            if paths.is_empty() {
                return Err(AppError::Validation("原文件已不存在，无法拖出".into()));
            }
            Ok(paths)
        }
        "image" => {
            // 图片内容常常是 data:image base64，直接取内容做文件名会得到一长串乱码。
            let img_stem = format!("TieZ_img_{}_{}", id.abs(), stamp);
            Ok(vec![write_image(&dir, &img_stem, &entry.content)?])
        }
        "link" | "url" => {
            let url = entry
                .content
                .lines()
                .map(str::trim)
                .find(|line| !line.is_empty())
                .unwrap_or_default();
            if url.is_empty() {
                return Err(AppError::Validation("链接内容为空".into()));
            }
            // .url 是资源管理器的 Internet 快捷方式，图标比裸 .txt 好看得多。
            let path = dir.join(format!("{}.url", stem));
            std::fs::write(&path, format!("[InternetShortcut]\r\nURL={}\r\n", url))?;
            Ok(vec![path])
        }
        "rich_text" => match entry.html_content.as_deref().filter(|html| !html.trim().is_empty()) {
            Some(html) => {
                let path = dir.join(format!("{}.html", stem));
                std::fs::write(&path, html.as_bytes())?;
                Ok(vec![path])
            }
            None => {
                let path = dir.join(format!("{}.txt", stem));
                std::fs::write(&path, entry.content.as_bytes())?;
                Ok(vec![path])
            }
        },
        _ => {
            let path = dir.join(format!("{}.txt", stem));
            std::fs::write(&path, entry.content.as_bytes())?;
            Ok(vec![path])
        }
    }
}

fn write_image(dir: &Path, stem: &str, content: &str) -> Result<PathBuf, AppError> {
    // 图片有时存的是原文件路径。
    if !content.starts_with("data:image") {
        let path = Path::new(content.lines().next().unwrap_or(content).trim());
        if path.exists() {
            return Ok(path.to_path_buf());
        }
    }

    let extension = image_extension(content);
    let path = dir.join(format!("{}.{}", stem, extension));
    let payload = content
        .split_once(',')
        .map(|(_, data)| data)
        .unwrap_or(content)
        .trim();
    let bytes = general_purpose::STANDARD
        .decode(payload)
        .map_err(|e| AppError::Internal(format!("图片数据解码失败: {}", e)))?;
    // 原样写回，GIF 的动画帧才不会丢。
    std::fs::write(&path, &bytes)?;
    Ok(path)
}

fn image_extension(content: &str) -> &'static str {
    let header = content.get(..24).unwrap_or(content).to_ascii_lowercase();
    if header.contains("image/gif") {
        "gif"
    } else if header.contains("image/jpeg") || header.contains("image/jpg") {
        "jpg"
    } else if header.contains("image/webp") {
        "webp"
    } else if header.contains("image/bmp") {
        "bmp"
    } else {
        "png"
    }
}

/// 用首行内容做文件名前缀，过滤掉文件系统不接受的字符。
fn slug_of(content: &str, id: i64) -> String {
    let first = content
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or_default();

    let mut slug = String::new();
    for ch in first.chars() {
        if slug.chars().count() >= MAX_STEM {
            break;
        }
        if ch.is_alphanumeric() || ch == '-' || ch == '_' {
            slug.push(ch);
        } else if !slug.is_empty() && !slug.ends_with('_') {
            slug.push('_');
        }
    }
    let slug = slug.trim_matches('_');
    if slug.is_empty() {
        format!("TieZ_{}", id.abs())
    } else {
        slug.to_string()
    }
}

fn prune_old_files(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let Ok(metadata) = entry.metadata() else { continue };
        if !metadata.is_file() {
            continue;
        }
        let stale = metadata
            .modified()
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .map(|age| age > KEEP_FOR)
            .unwrap_or(false);
        if stale {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// 前端 mousedown 时调用：把条目落成文件并开始 OLE 拖拽。
///
/// OLE 的拖拽循环必须跑在**创建窗口的那个 UI 线程**上：`DoDragDrop` 内部要
/// `SetCapture` 才能收鼠标消息，换个线程就抢不到捕获，循环会立刻以
/// `DRAGDROP_S_CANCEL` 返回（表现就是「按下去拖不动」）。所以这里把拖拽
/// 交给主线程执行，命令本身立刻返回。
#[tauri::command]
pub fn start_drag_out(app: AppHandle, state: State<'_, DbState>, id: i64) -> Result<(), AppError> {
    crate::info!("[DRAGOUT] invoke id={}", id);
    let entry = resolve_entry(&app, &state, id).map_err(|e| {
        crate::error!("[DRAGOUT] resolve_entry failed id={} err={}", id, e);
        e
    })?;
    let paths = materialize(&entry, id).map_err(|e| {
        crate::error!("[DRAGOUT] materialize failed id={} err={}", id, e);
        e
    })?;

    // 文本类条目额外挂一个 CF_UNICODETEXT：拖到编辑器里直接就是“粘贴”，
    // 拖到文件夹里仍然是文件。
    let text = match entry.content_type.as_str() {
        "file" | "video" | "image" => None,
        _ if entry.content.trim().is_empty() => None,
        _ => Some(entry.content.clone()),
    };

    crate::info!(
        "[DRAGOUT] start id={} type={} files={} text={}",
        id,
        entry.content_type,
        paths.len(),
        text.as_ref().map(|t| t.chars().count()).unwrap_or(0)
    );

    let app_handle = app.clone();
    app.run_on_main_thread(move || {
        run_drag_loop(paths, text);
        let _ = &app_handle;
    })
    .map_err(|e| AppError::Internal(format!("无法在主线程启动拖拽: {}", e)))?;
    Ok(())
}

fn run_drag_loop(paths: Vec<PathBuf>, text: Option<String>) {
    let ole_ready = unsafe {
        // S_FALSE 也算成功（本线程已经初始化过 OLE），只有 RPC_E_CHANGED_MODE 才会失败。
        match OleInitialize(None) {
            Ok(()) => true,
            Err(e) => {
                crate::error!("[DRAGOUT] OleInitialize failed: {:?}", e.code());
                false
            }
        }
    };

    let data_object: IDataObject = FileDataObject { paths, text }.into();
    let drop_source: IDropSource = DragSource.into();
    let mut effect = DROPEFFECT_COPY;

    // webview（Chromium 子窗口）在 mousedown 时抓了鼠标捕获；OLE 的拖拽循环要自己
    // 抢捕获，不先放开就会立刻取消。这是「按下去毫无反应」最常见的原因。
    unsafe { let _ = ReleaseCapture(); };

    // 拖拽期间窗口会失焦，而 TieZ 的「失焦即隐藏」会直接把窗口收起来、顺带取消拖拽。
    // 先挂上闸门，等拖完（含 200ms 的失焦延时检查）再放开。
    crate::global_state::DRAG_OUT_ACTIVE.store(true, std::sync::atomic::Ordering::SeqCst);

    let started = std::time::Instant::now();
    unsafe {
        // DRAGDROP_S_DROP / DRAGDROP_S_CANCEL 都是成功码，放手就行。
        let hr = DoDragDrop(&data_object, &drop_source, DROPEFFECT_COPY, &mut effect);
        crate::info!(
            "[DRAGOUT] DoDragDrop hr={:?} effect={:?} elapsed={}ms",
            hr.0,
            effect.0,
            started.elapsed().as_millis()
        );
    }

    std::thread::spawn(|| {
        std::thread::sleep(std::time::Duration::from_millis(400));
        crate::global_state::DRAG_OUT_ACTIVE
            .store(false, std::sync::atomic::Ordering::SeqCst);
    });

    if ole_ready {
        unsafe { OleUninitialize() };
    }
}

/* ------------------------------------------------------------------ */
/* OLE 对象                                                            */
/* ------------------------------------------------------------------ */

fn hdrop_format() -> FORMATETC {
    FORMATETC {
        cfFormat: CF_HDROP.0,
        ptd: ptr::null_mut(),
        dwAspect: DVASPECT_CONTENT.0 as u32,
        lindex: -1,
        tymed: TYMED_HGLOBAL.0 as u32,
    }
}

fn text_format() -> FORMATETC {
    FORMATETC {
        cfFormat: CF_UNICODETEXT.0,
        ptd: ptr::null_mut(),
        dwAspect: DVASPECT_CONTENT.0 as u32,
        lindex: -1,
        tymed: TYMED_HGLOBAL.0 as u32,
    }
}

fn is_hdrop(format: &FORMATETC) -> bool {
    format.cfFormat == CF_HDROP.0 && (format.tymed & TYMED_HGLOBAL.0 as u32) != 0
}

fn is_text(format: &FORMATETC) -> bool {
    format.cfFormat == CF_UNICODETEXT.0 && (format.tymed & TYMED_HGLOBAL.0 as u32) != 0
}

/// 纯文本的 HGLOBAL（UTF-16 + 结尾 0）。
unsafe fn build_text_handle(text: &str) -> windows::core::Result<HGLOBAL> {
    let mut wide: Vec<u16> = text.encode_utf16().collect();
    wide.push(0);
    let bytes = wide.len() * 2;

    let handle = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, bytes)?;
    let base = GlobalLock(handle) as *mut u8;
    if base.is_null() {
        return Err(windows::core::Error::from_hresult(E_OUTOFMEMORY));
    }
    ptr::copy_nonoverlapping(wide.as_ptr() as *const u8, base, bytes);
    let _ = GlobalUnlock(handle);
    Ok(handle)
}

/// 每次 `GetData` 都新建一份 HGLOBAL：所有权转交给接收方，它会自己释放。
unsafe fn build_hdrop_handle(paths: &[PathBuf]) -> windows::core::Result<HGLOBAL> {
    let mut wide: Vec<u16> = Vec::new();
    for path in paths {
        wide.extend(path.to_string_lossy().encode_utf16());
        wide.push(0);
    }
    wide.push(0); // 文件名列表以双零结尾

    let header = std::mem::size_of::<DROPFILES>();
    let total = header + wide.len() * 2;

    let handle = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, total)?;
    let base = GlobalLock(handle) as *mut u8;
    if base.is_null() {
        return Err(windows::core::Error::from_hresult(E_OUTOFMEMORY));
    }

    let drop_files = DROPFILES {
        pFiles: header as u32,
        pt: POINT { x: 0, y: 0 },
        fNC: BOOL(0),
        fWide: BOOL(1),
    };

    ptr::copy_nonoverlapping(&drop_files as *const _ as *const u8, base, header);
    ptr::copy_nonoverlapping(wide.as_ptr() as *const u8, base.add(header), wide.len() * 2);

    let _ = GlobalUnlock(handle);
    Ok(handle)
}

#[implement(IDataObject)]
struct FileDataObject {
    paths: Vec<PathBuf>,
    /// 文本类条目额外提供 CF_UNICODETEXT，拖进编辑器就是粘贴。
    text: Option<String>,
}

impl FileDataObject {
    fn formats(&self) -> Vec<FORMATETC> {
        let mut formats = vec![hdrop_format()];
        if self.text.is_some() {
            formats.push(text_format());
        }
        formats
    }

    fn accepts(&self, format: &FORMATETC) -> bool {
        is_hdrop(format) || (self.text.is_some() && is_text(format))
    }
}

impl IDataObject_Impl for FileDataObject_Impl {
    fn GetData(&self, pformatetcin: *const FORMATETC) -> windows::core::Result<STGMEDIUM> {
        if pformatetcin.is_null() {
            return Err(windows::core::Error::from_hresult(E_INVALIDARG));
        }
        let format = unsafe { &*pformatetcin };

        let handle = if is_hdrop(format) {
            unsafe { build_hdrop_handle(&self.paths)? }
        } else if is_text(format) {
            match self.text.as_deref() {
                Some(text) => unsafe { build_text_handle(text)? },
                None => return Err(windows::core::Error::from_hresult(DV_E_FORMATETC)),
            }
        } else {
            return Err(windows::core::Error::from_hresult(DV_E_FORMATETC));
        };

        Ok(STGMEDIUM {
            tymed: TYMED_HGLOBAL.0 as u32,
            u: STGMEDIUM_0 { hGlobal: handle },
            pUnkForRelease: ManuallyDrop::new(None),
        })
    }

    fn GetDataHere(
        &self,
        _pformatetc: *const FORMATETC,
        _pmedium: *mut STGMEDIUM,
    ) -> windows::core::Result<()> {
        Err(windows::core::Error::from_hresult(DV_E_FORMATETC))
    }

    fn QueryGetData(&self, pformatetc: *const FORMATETC) -> HRESULT {
        if pformatetc.is_null() {
            return E_INVALIDARG;
        }
        if self.accepts(unsafe { &*pformatetc }) {
            S_OK
        } else {
            DV_E_FORMATETC
        }
    }

    fn GetCanonicalFormatEtc(
        &self,
        _pformatectin: *const FORMATETC,
        _pformatetcout: *mut FORMATETC,
    ) -> HRESULT {
        E_NOTIMPL
    }

    fn SetData(
        &self,
        _pformatetc: *const FORMATETC,
        _pmedium: *const STGMEDIUM,
        _frelease: BOOL,
    ) -> windows::core::Result<()> {
        Err(windows::core::Error::from_hresult(E_NOTIMPL))
    }

    fn EnumFormatEtc(&self, dwdirection: u32) -> windows::core::Result<IEnumFORMATETC> {
        if dwdirection != DATADIR_GET.0 as u32 {
            return Err(windows::core::Error::from_hresult(E_NOTIMPL));
        }
        Ok(FormatEtcEnumerator {
            formats: self.formats(),
            index: Cell::new(0),
        }
        .into())
    }

    fn DAdvise(
        &self,
        _pformatetc: *const FORMATETC,
        _advf: u32,
        _padvsink: windows::core::Ref<'_, IAdviseSink>,
    ) -> windows::core::Result<u32> {
        Err(windows::core::Error::from_hresult(OLE_E_ADVISENOTSUPPORTED))
    }

    fn DUnadvise(&self, _dwconnection: u32) -> windows::core::Result<()> {
        Err(windows::core::Error::from_hresult(OLE_E_ADVISENOTSUPPORTED))
    }

    fn EnumDAdvise(&self) -> windows::core::Result<IEnumSTATDATA> {
        Err(windows::core::Error::from_hresult(OLE_E_ADVISENOTSUPPORTED))
    }
}

#[implement(IEnumFORMATETC)]
struct FormatEtcEnumerator {
    formats: Vec<FORMATETC>,
    index: Cell<usize>,
}

impl IEnumFORMATETC_Impl for FormatEtcEnumerator_Impl {
    fn Next(&self, celt: u32, rgelt: *mut FORMATETC, pceltfetched: *mut u32) -> HRESULT {
        if rgelt.is_null() || celt == 0 {
            return E_INVALIDARG;
        }

        let mut cursor = self.index.get();
        let mut copied = 0u32;
        while copied < celt && cursor < self.formats.len() {
            unsafe { *rgelt.add(copied as usize) = self.formats[cursor] };
            cursor += 1;
            copied += 1;
        }
        self.index.set(cursor);

        if !pceltfetched.is_null() {
            unsafe { *pceltfetched = copied };
        }

        if copied == celt {
            S_OK
        } else {
            S_FALSE
        }
    }

    fn Skip(&self, celt: u32) -> windows::core::Result<()> {
        let next = self.index.get().saturating_add(celt as usize);
        self.index.set(next.min(self.formats.len()));
        Ok(())
    }

    fn Reset(&self) -> windows::core::Result<()> {
        self.index.set(0);
        Ok(())
    }

    fn Clone(&self) -> windows::core::Result<IEnumFORMATETC> {
        Ok(FormatEtcEnumerator {
            formats: self.formats.clone(),
            index: Cell::new(self.index.get()),
        }
        .into())
    }
}

#[implement(IDropSource)]
struct DragSource;

impl IDropSource_Impl for DragSource_Impl {
    fn QueryContinueDrag(&self, fescapepressed: BOOL, grfkeystate: MODIFIERKEYS_FLAGS) -> HRESULT {
        if fescapepressed.as_bool() {
            return DRAGDROP_S_CANCEL;
        }
        // 左右键都松开了才算放手；否则继续拖。
        if !grfkeystate.contains(MK_LBUTTON) && !grfkeystate.contains(MK_RBUTTON) {
            return DRAGDROP_S_DROP;
        }
        S_OK
    }

    fn GiveFeedback(&self, _dweffect: DROPEFFECT) -> HRESULT {
        DRAGDROP_S_USEDEFAULTCURSORS
    }
}
