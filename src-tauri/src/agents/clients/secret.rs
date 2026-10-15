//! Agent tokens for connected apps, kept in the Windows Credential Manager so no secret sits in
//! another app's config file. The config then names the agent (`--credential <agent id>`) and the
//! `suivelle-mcp` connector reads the token from the same place. Other systems keep the token in
//! the config's environment instead.

use crate::errors::{AppError, AppResult};

/// The credential's name, shared with `suivelle-mcp`.
pub fn target(agent_id: &str) -> String {
    format!("Suivelle agent {agent_id}")
}

pub fn available() -> bool {
    cfg!(windows)
}

#[cfg(windows)]
mod sys {
    use std::ffi::c_void;

    #[repr(C)]
    pub struct Credential {
        pub flags: u32,
        pub kind: u32,
        pub target_name: *mut u16,
        pub comment: *mut u16,
        pub last_written: [u32; 2],
        pub blob_size: u32,
        pub blob: *mut u8,
        pub persist: u32,
        pub attribute_count: u32,
        pub attributes: *mut c_void,
        pub target_alias: *mut u16,
        pub user_name: *mut u16,
    }

    pub const CRED_TYPE_GENERIC: u32 = 1;
    pub const CRED_PERSIST_LOCAL_MACHINE: u32 = 2;

    #[link(name = "advapi32")]
    extern "system" {
        pub fn CredWriteW(credential: *const Credential, flags: u32) -> i32;
        pub fn CredReadW(target: *const u16, kind: u32, flags: u32, credential: *mut *mut Credential) -> i32;
        pub fn CredDeleteW(target: *const u16, kind: u32, flags: u32) -> i32;
        pub fn CredFree(buffer: *mut c_void);
    }

    pub fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }
}

#[cfg(windows)]
pub fn store(agent_id: &str, token: &str) -> AppResult<()> {
    let mut name = sys::wide(&target(agent_id));
    let mut user = sys::wide("suivelle");
    let mut blob = token.as_bytes().to_vec();
    let cred = sys::Credential {
        flags: 0,
        kind: sys::CRED_TYPE_GENERIC,
        target_name: name.as_mut_ptr(),
        comment: std::ptr::null_mut(),
        last_written: [0, 0],
        blob_size: blob.len() as u32,
        blob: blob.as_mut_ptr(),
        persist: sys::CRED_PERSIST_LOCAL_MACHINE,
        attribute_count: 0,
        attributes: std::ptr::null_mut(),
        target_alias: std::ptr::null_mut(),
        user_name: user.as_mut_ptr(),
    };
    // SAFETY: every pointer refers to a live, NUL-terminated buffer owned by this frame.
    let ok = unsafe { sys::CredWriteW(&cred, 0) };
    if ok == 0 {
        return Err(AppError::Internal(format!(
            "Could not save the token in Windows Credential Manager ({}).",
            std::io::Error::last_os_error()
        )));
    }
    Ok(())
}

#[cfg(windows)]
pub fn read(agent_id: &str) -> Option<String> {
    let name = sys::wide(&target(agent_id));
    let mut out: *mut sys::Credential = std::ptr::null_mut();
    // SAFETY: `name` is NUL-terminated; on success `out` is freed with CredFree below.
    unsafe {
        if sys::CredReadW(name.as_ptr(), sys::CRED_TYPE_GENERIC, 0, &mut out) == 0 || out.is_null() {
            return None;
        }
        let c = &*out;
        let bytes = std::slice::from_raw_parts(c.blob, c.blob_size as usize).to_vec();
        sys::CredFree(out.cast());
        String::from_utf8(bytes).ok()
    }
}

#[cfg(windows)]
pub fn delete(agent_id: &str) {
    let name = sys::wide(&target(agent_id));
    // SAFETY: `name` is NUL-terminated. A missing credential is not an error worth reporting.
    unsafe {
        sys::CredDeleteW(name.as_ptr(), sys::CRED_TYPE_GENERIC, 0);
    }
}

#[cfg(not(windows))]
pub fn store(_agent_id: &str, _token: &str) -> AppResult<()> {
    Err(AppError::Validation("The system credential store is not supported here.".into()))
}

#[cfg(not(windows))]
pub fn read(_agent_id: &str) -> Option<String> {
    None
}

#[cfg(not(windows))]
pub fn delete(_agent_id: &str) {}
