//! Windows closes the whole backend process tree even if the desktop crashes.
use std::{io, os::windows::io::AsRawHandle, process::Child};
use windows_sys::Win32::{Foundation::{CloseHandle, HANDLE}, System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject,
    JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
}};

pub struct ProcessGroup(HANDLE);
// A job HANDLE may be transferred across threads; access is protected by NodeGuard's mutex.
unsafe impl Send for ProcessGroup {}

impl ProcessGroup {
    pub fn new() -> io::Result<Self> {
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() { return Err(io::Error::last_os_error()); }
            let group = Self(handle);
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(handle, JobObjectExtendedLimitInformation,
                &info as *const _ as *const _, std::mem::size_of_val(&info) as u32) == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(group)
        }
    }

    pub fn attach(&self, child: &Child) -> io::Result<()> {
        if unsafe { AssignProcessToJobObject(self.0, child.as_raw_handle() as HANDLE) } == 0 {
            Err(io::Error::last_os_error())
        } else { Ok(()) }
    }
}

impl Drop for ProcessGroup {
    fn drop(&mut self) { unsafe { CloseHandle(self.0); } }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::windows::process::CommandExt;

    #[test]
    fn dropping_group_reaps_backend() {
        let group = ProcessGroup::new().unwrap();
        let mut child = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 30"])
            .creation_flags(0x08000000).spawn().unwrap();
        group.attach(&child).unwrap();
        assert!(child.try_wait().unwrap().is_none());
        drop(group);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while child.try_wait().unwrap().is_none() {
            if std::time::Instant::now() > deadline {
                let _ = child.kill();let _ = child.wait();panic!("backend survived job close");
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }
}
