// 桌面版「把资产拖到别的软件里」。
//
// 为什么只有桌面版能做：网页没法把磁盘上的真实文件塞进系统拖放（浏览器出于安全会把
// 文件路径抹掉），所以浏览器版最多只能靠光标命中猜目标窗口。桌面版直接调 Windows 的
// OLE 拖放：前端一 dragstart 就把网页自己的拖拽取消掉，转手交给这里，由 DoDragDrop
// 举着 CF_HDROP（真实文件）跟你走完全程。目标软件收到的是货真价实的文件，跟从资源
// 管理器里拖过去一模一样。
//
// 拖完还要回答一个问题：你把它丢进了哪个软件？DoDragDrop 返回后光标就停在落点上，
// 于是用 WindowFromPoint + GetWindowThreadProcessId 反查出 exe 名（maya.exe /
// blender.exe / Unity.exe…）交回前端。前端据此决定要不要再走一遍「导入到已连接软件」
// 的管线 —— 文件拖放本身只能把文件放进去，真正建到当前场景里得靠我们自己那套桥接。
//
// 没有本地文件的资产（还没导出过）也让它拖：这时只挂一段文字格式，拖拽过程照样成立、
// 目标窗口照样能认出来，前端拿到目标后再去下载并导入，等于「拖一下就自动下载并导入」。
use std::mem::ManuallyDrop;
use std::path::PathBuf;

use windows::core::{implement, Interface, BOOL, HRESULT, PWSTR};
use windows::Win32::Foundation::{
    DATA_S_SAMEFORMATETC, DRAGDROP_S_CANCEL, DRAGDROP_S_DROP, DRAGDROP_S_USEDEFAULTCURSORS,
    DV_E_FORMATETC, E_INVALIDARG, E_NOTIMPL, E_OUTOFMEMORY, HGLOBAL, POINT, S_OK,
};
use windows::Win32::System::Com::{
    IAdviseSink, IDataObject, IDataObject_Impl, IEnumFORMATETC, IEnumSTATDATA, STGMEDIUM,
    STGMEDIUM_0, TYMED_HGLOBAL, FORMATETC, DATADIR_GET, DVASPECT_CONTENT,
};
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
use windows::Win32::System::Ole::{
    DoDragDrop, IDropSource, IDropSource_Impl, OleInitialize, OleUninitialize, CF_HDROP,
    CF_UNICODETEXT, DROPEFFECT, DROPEFFECT_COPY,
};
use windows::Win32::System::SystemServices::MODIFIERKEYS_FLAGS;
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Shell::{DROPFILES, SHCreateStdEnumFmtEtc};
use windows::Win32::UI::WindowsAndMessaging::{
    GetAncestor, GetCursorPos, GetWindowTextW, GetWindowThreadProcessId, WindowFromPoint, GA_ROOT,
};

/// 拖放结果：落到哪个窗口、哪个进程。
#[derive(serde::Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DragOutcome {
    /// 系统是否认为这次拖放被某个窗口接收了（被拒绝也照样返回目标进程，前端要的是后者）。
    dropped: bool,
    /// 目标窗口所属进程的 exe 文件名，小写，例如 "maya.exe"；查不到就是空串。
    exe: String,
    /// exe 的完整路径，能查到就给（前端用它做兜底判断）。
    path: String,
    /// 目标窗口标题，用来给提示语提供上下文。
    title: String,
}

/// 一次拖放携带的数据：要么是一组真实文件，要么只是一段文字（资产还没下载时）。
struct DragPayload {
    files: Vec<String>,
    text: String,
}

fn wide_bytes(value: &str) -> Vec<u8> {
    value
        .encode_utf16()
        .chain(std::iter::once(0))
        .flat_map(|unit| unit.to_le_bytes())
        .collect()
}

/// 把路径列表拼成 CF_HDROP 需要的 DROPFILES 块：头部 + 若干个「宽字符 + \0」+ 结尾 \0。
fn hdrop_handle(files: &[String]) -> Option<HGLOBAL> {
    let mut body: Vec<u8> = Vec::new();
    for file in files {
        body.extend(wide_bytes(file));
    }
    body.extend_from_slice(&[0, 0]); // 列表结尾的额外一个 0，和上一个路径的 0 一起构成双 0
    let header = std::mem::size_of::<DROPFILES>();
    unsafe {
        let handle = GlobalAlloc(GMEM_MOVEABLE, header + body.len()).ok()?;
        let base = GlobalLock(handle) as *mut u8;
        if base.is_null() {
            return None;
        }
        let header_bytes = DROPFILES {
            pFiles: header as u32,
            pt: POINT { x: 0, y: 0 },
            fNC: BOOL(0),
            fWide: BOOL(1),
        };
        std::ptr::copy_nonoverlapping(
            &header_bytes as *const DROPFILES as *const u8,
            base,
            header,
        );
        std::ptr::copy_nonoverlapping(body.as_ptr(), base.add(header), body.len());
        let _ = GlobalUnlock(handle);
        Some(handle)
    }
}

fn text_handle(text: &str) -> Option<HGLOBAL> {
    let body = wide_bytes(text);
    unsafe {
        let handle = GlobalAlloc(GMEM_MOVEABLE, body.len()).ok()?;
        let base = GlobalLock(handle) as *mut u8;
        if base.is_null() {
            return None;
        }
        std::ptr::copy_nonoverlapping(body.as_ptr(), base, body.len());
        let _ = GlobalUnlock(handle);
        Some(handle)
    }
}

fn medium(handle: HGLOBAL) -> STGMEDIUM {
    STGMEDIUM {
        tymed: TYMED_HGLOBAL.0 as u32,
        u: STGMEDIUM_0 { hGlobal: handle },
        pUnkForRelease: ManuallyDrop::new(None),
    }
}

#[implement(IDataObject, IDropSource)]
struct AssetDrag {
    payload: DragPayload,
}

impl IDataObject_Impl for AssetDrag_Impl {
    fn GetData(&self, format: *const FORMATETC) -> windows::core::Result<STGMEDIUM> {
        if format.is_null() {
            return Err(E_INVALIDARG.into());
        }
        let format = unsafe { *format };
        let clip = format.cfFormat;
        if clip == CF_HDROP.0 && !self.payload.files.is_empty() {
            return hdrop_handle(&self.payload.files)
                .map(medium)
                .ok_or_else(|| E_OUTOFMEMORY.into());
        }
        if clip == CF_UNICODETEXT.0 && !self.payload.text.is_empty() {
            return text_handle(&self.payload.text)
                .map(medium)
                .ok_or_else(|| E_OUTOFMEMORY.into());
        }
        Err(DV_E_FORMATETC.into())
    }

    fn GetDataHere(
        &self,
        _format: *const FORMATETC,
        _medium: *mut STGMEDIUM,
    ) -> windows::core::Result<()> {
        Err(E_NOTIMPL.into())
    }

    fn QueryGetData(&self, format: *const FORMATETC) -> HRESULT {
        if format.is_null() {
            return E_INVALIDARG;
        }
        let clip = unsafe { (*format).cfFormat };
        if (clip == CF_HDROP.0 && !self.payload.files.is_empty())
            || (clip == CF_UNICODETEXT.0 && !self.payload.text.is_empty())
        {
            S_OK
        } else {
            DV_E_FORMATETC
        }
    }

    fn GetCanonicalFormatEtc(
        &self,
        _format: *const FORMATETC,
        out: *mut FORMATETC,
    ) -> HRESULT {
        if !out.is_null() {
            unsafe {
                (*out).ptd = std::ptr::null_mut();
            }
        }
        DATA_S_SAMEFORMATETC
    }

    fn SetData(
        &self,
        _format: *const FORMATETC,
        _medium: *const STGMEDIUM,
        _release: BOOL,
    ) -> windows::core::Result<()> {
        Err(E_NOTIMPL.into())
    }

    fn EnumFormatEtc(&self, direction: u32) -> windows::core::Result<IEnumFORMATETC> {
        if direction != DATADIR_GET.0 as u32 {
            return Err(E_NOTIMPL.into());
        }
        // 接收方可能先枚举格式，再请求 CF_HDROP；不能在这里返回未实现。
        let mut formats = Vec::new();
        for (format, available) in [
            (CF_HDROP, !self.payload.files.is_empty()),
            (CF_UNICODETEXT, !self.payload.text.is_empty()),
        ] {
            if available {
                formats.push(FORMATETC {
                    cfFormat: format.0,
                    ptd: std::ptr::null_mut(),
                    dwAspect: DVASPECT_CONTENT.0,
                    lindex: -1,
                    tymed: TYMED_HGLOBAL.0 as u32,
                });
            }
        }
        unsafe { SHCreateStdEnumFmtEtc(&formats) }
    }

    fn DAdvise(
        &self,
        _format: *const FORMATETC,
        _flags: u32,
        _sink: windows::core::Ref<IAdviseSink>,
    ) -> windows::core::Result<u32> {
        Err(E_NOTIMPL.into())
    }

    fn DUnadvise(&self, _connection: u32) -> windows::core::Result<()> {
        Err(E_NOTIMPL.into())
    }

    fn EnumDAdvise(&self) -> windows::core::Result<IEnumSTATDATA> {
        Err(E_NOTIMPL.into())
    }
}

impl IDropSource_Impl for AssetDrag_Impl {
    fn QueryContinueDrag(&self, escape: BOOL, keys: MODIFIERKEYS_FLAGS) -> HRESULT {
        use windows::Win32::System::SystemServices::MK_LBUTTON;
        if escape.as_bool() {
            return DRAGDROP_S_CANCEL;
        }
        if !keys.contains(MK_LBUTTON) {
            return DRAGDROP_S_DROP;
        }
        S_OK
    }

    fn GiveFeedback(&self, _effect: DROPEFFECT) -> HRESULT {
        DRAGDROP_S_USEDEFAULTCURSORS
    }
}

fn window_title(hwnd: windows::Win32::Foundation::HWND) -> String {
    let mut buffer = [0u16; 512];
    let len = unsafe { GetWindowTextW(hwnd, &mut buffer) };
    if len <= 0 {
        return String::new();
    }
    String::from_utf16_lossy(&buffer[..len as usize])
}

fn process_of_window(hwnd: windows::Win32::Foundation::HWND) -> (String, String) {
    let mut pid = 0u32;
    unsafe {
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
    }
    if pid == 0 {
        return (String::new(), String::new());
    }
    unsafe {
        // 提权进程从普通进程里查不了，这种情况下就只留空 —— 前端会退化成「不认得的软件」。
        let handle = match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
            Ok(handle) => handle,
            Err(_) => return (String::new(), String::new()),
        };
        let mut buffer = [0u16; 1024];
        let mut size = buffer.len() as u32;
        let ok = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            PWSTR(buffer.as_mut_ptr()),
            &mut size,
        )
        .is_ok();
        let _ = windows::Win32::Foundation::CloseHandle(handle);
        if !ok {
            return (String::new(), String::new());
        }
        let full = String::from_utf16_lossy(&buffer[..size as usize]);
        let name = PathBuf::from(&full)
            .file_name()
            .map(|value| value.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        (name, full)
    }
}

fn drag_blocking(files: Vec<String>, text: String) -> Result<DragOutcome, String> {
    unsafe {
        // 必须在窗口线程启动：它拥有本次鼠标按下对应的输入队列。
        OleInitialize(None).map_err(|error| format!("初始化系统拖放失败：{error}"))?;
        struct OleScope;
        impl Drop for OleScope {
            fn drop(&mut self) { unsafe { OleUninitialize(); } }
        }
        let _ole = OleScope;
        let data = AssetDrag {
            payload: DragPayload { files, text },
        };
        let object: IDataObject = match data.into() {
            value => value,
        };
        let source: IDropSource = object.cast().map_err(|error| error.to_string())?;
        // 只允许「复制」：放开 MOVE 的话，往资源管理器里一丢就等于把资产从下载目录搬走，
        // 库里的任务会指向一个空路径。链接同理，谁都别想让文件凭空消失。
        let mut effect = DROPEFFECT_COPY;
        let hr = DoDragDrop(&object, &source, DROPEFFECT_COPY, &mut effect);
        hr.ok().map_err(|error| format!("系统拖放失败：{error}"))?;

        // 拖放结束后光标停在落点上：立刻反查那个窗口属于谁。
        let mut point = POINT::default();
        let found = GetCursorPos(&mut point).is_ok();
        if !found {
            return Ok(DragOutcome::default());
        }
        let hwnd = GetAncestor(WindowFromPoint(point), GA_ROOT);
        if hwnd.0.is_null() {
            return Ok(DragOutcome::default());
        }
        let (exe, path) = process_of_window(hwnd);
        Ok(DragOutcome {
            dropped: hr == DRAGDROP_S_DROP,
            exe,
            path,
            title: window_title(hwnd),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn receiver_can_enumerate_and_read_file_drop() {
        use windows::Win32::System::Ole::ReleaseStgMedium;
        use windows::Win32::UI::Shell::DragQueryFileW;
        let file = "H:\\素材库\\测试图片.png";
        let object: IDataObject = AssetDrag {
            payload: DragPayload { files: vec![file.into()], text: String::new() },
        }.into();
        unsafe {
            // 模拟接收软件的标准流程：枚举格式，再读取真实 CF_HDROP。
            let formats = object.EnumFormatEtc(DATADIR_GET.0 as u32).unwrap();
            let mut offered = [FORMATETC::default()];
            formats.Next(&mut offered, None).ok().unwrap();
            assert_eq!(offered[0].cfFormat, CF_HDROP.0);
            let mut data = object.GetData(&offered[0]).unwrap();
            let drop = windows::Win32::UI::Shell::HDROP(data.u.hGlobal.0);
            let mut path = [0u16; 260];
            assert_eq!(DragQueryFileW(drop, u32::MAX, None), 1);
            let len = DragQueryFileW(drop, 0, Some(&mut path));
            assert_eq!(String::from_utf16_lossy(&path[..len as usize]), file);
            ReleaseStgMedium(&mut data);
        }
    }
}

/// 前端 dragstart 时调用：把卡片对应的本地文件交给系统拖放，返回落点软件的进程名。
#[tauri::command]
pub async fn start_file_drag(app: tauri::AppHandle, files: Vec<String>, text: String) -> Result<DragOutcome, String> {
    let (sender, receiver) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = sender.send(drag_blocking(files, text));
    }).map_err(|error| error.to_string())?;
    // 等待结果可以放在线程池，OLE 操作本身不能放在线程池。
    tauri::async_runtime::spawn_blocking(move || receiver.recv().map_err(|error| error.to_string()))
        .await
        .map_err(|error| error.to_string())??
}
