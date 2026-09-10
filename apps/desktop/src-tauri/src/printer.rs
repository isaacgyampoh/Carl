//! Sending raw bytes to a receipt printer.
//!
//! ## Why the Windows print spooler, and not a USB library
//!
//! A shop buys whatever thermal printer the local supplier had that week, and installs it
//! the way they install any printer: with the vendor's Windows driver. Once that is done
//! the spooler can hand raw bytes straight to the device, which is exactly what ESC/POS
//! needs — no vendor SDK, no USB permissions, no per-model code.
//!
//! Talking to the USB endpoint directly would mean claiming the interface away from the
//! driver the shop already installed, and reimplementing per-model quirks Carl has no way
//! to test.
//!
//! ## Least privilege
//!
//! These are ordinary Tauri commands, so they need no capability grant: no filesystem, no
//! shell, no arbitrary execution. The only thing the frontend can ask for is "send these
//! bytes to this named printer" and "list the printers Windows knows about".
//!
//! ## Honesty about what success means
//!
//! `print_raw` returning `Ok` means the spooler accepted the job. It does not mean paper
//! came out, and it cannot: the spooler does not report that, and a drawer kick reports
//! even less. The application says "sent to the printer", never "printed".

/// A printer Windows knows about.
#[derive(serde::Serialize)]
pub struct PrinterInfo {
    pub name: String,
    pub is_default: bool,
}

#[cfg(target_os = "windows")]
mod platform {
    use super::PrinterInfo;
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Graphics::Printing::{
        ClosePrinter, EndDocPrinter, EndPagePrinter, EnumPrintersW, GetDefaultPrinterW,
        OpenPrinterW, StartDocPrinterW, StartPagePrinter, WritePrinter, DOC_INFO_1W,
        PRINTER_ENUM_CONNECTIONS, PRINTER_ENUM_LOCAL, PRINTER_INFO_2W,
    };

    fn wide(value: &str) -> Vec<u16> {
        OsStr::new(value).encode_wide().chain(std::iter::once(0)).collect()
    }

    fn from_wide(ptr: *const u16) -> String {
        if ptr.is_null() {
            return String::new();
        }
        unsafe {
            let mut len = 0;
            while *ptr.add(len) != 0 {
                len += 1;
            }
            String::from_utf16_lossy(std::slice::from_raw_parts(ptr, len))
        }
    }

    fn default_printer() -> String {
        let mut len: u32 = 0;
        unsafe {
            // Sizing call: it fails by design and reports the buffer it needs in `len`.
            // `GetDefaultPrinterW` takes a bare PWSTR and returns BOOL, not Result.
            let _ = GetDefaultPrinterW(windows::core::PWSTR::null(), &mut len);
            if len == 0 {
                return String::new();
            }
            let mut buffer = vec![0u16; len as usize];
            if GetDefaultPrinterW(windows::core::PWSTR(buffer.as_mut_ptr()), &mut len).as_bool() {
                from_wide(buffer.as_ptr())
            } else {
                // No default printer is an ordinary state in a shop, not an error.
                String::new()
            }
        }
    }

    pub fn list() -> Result<Vec<PrinterInfo>, String> {
        let flags = PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS;
        let mut needed: u32 = 0;
        let mut returned: u32 = 0;

        unsafe {
            // Sizing call. It is expected to fail; what matters is `needed`.
            let _ = EnumPrintersW(flags, PCWSTR::null(), 2, None, &mut needed, &mut returned);
            if needed == 0 {
                return Ok(Vec::new());
            }

            let mut buffer = vec![0u8; needed as usize];
            EnumPrintersW(
                flags,
                PCWSTR::null(),
                2,
                Some(&mut buffer),
                &mut needed,
                &mut returned,
            )
            .map_err(|e| format!("Could not list printers: {e}"))?;

            let default = default_printer();
            let infos = std::slice::from_raw_parts(
                buffer.as_ptr() as *const PRINTER_INFO_2W,
                returned as usize,
            );
            Ok(infos
                .iter()
                .map(|info| {
                    let name = from_wide(info.pPrinterName.0);
                    PrinterInfo { is_default: !name.is_empty() && name == default, name }
                })
                .collect())
        }
    }

    /// Hands raw bytes to the spooler as a RAW job.
    ///
    /// RAW is the whole point: it tells Windows to pass the bytes through untouched rather
    /// than rendering them as a document. ESC/POS is not a document.
    pub fn print_raw(printer: &str, bytes: &[u8]) -> Result<(), String> {
        if printer.trim().is_empty() {
            return Err("No printer selected.".into());
        }
        if bytes.is_empty() {
            return Err("Nothing to print.".into());
        }

        let mut name = wide(printer);
        let mut handle = HANDLE::default();

        unsafe {
            OpenPrinterW(PCWSTR(name.as_mut_ptr()), &mut handle, None)
                .map_err(|e| format!("Could not open printer: {e}"))?;

            // Every path from here must close the handle, including the error paths — a
            // leaked printer handle keeps the spooler busy until the application exits.
            let result = (|| -> Result<(), String> {
                let mut doc_name = wide("Carl receipt");
                let mut datatype = wide("RAW");
                let doc = DOC_INFO_1W {
                    pDocName: windows::core::PWSTR(doc_name.as_mut_ptr()),
                    pOutputFile: windows::core::PWSTR::null(),
                    pDatatype: windows::core::PWSTR(datatype.as_mut_ptr()),
                };

                let job = StartDocPrinterW(handle, 1, &doc);
                if job == 0 {
                    return Err("The printer refused the job.".into());
                }
                StartPagePrinter(handle)
                    .ok()
                    .map_err(|e| format!("Could not start the page: {e}"))?;

                let mut written: u32 = 0;
                let ok = WritePrinter(
                    handle,
                    bytes.as_ptr() as *const core::ffi::c_void,
                    bytes.len() as u32,
                    &mut written,
                );
                let _ = EndPagePrinter(handle);
                let _ = EndDocPrinter(handle);

                if !ok.as_bool() {
                    return Err("The printer did not accept the data.".into());
                }
                if written as usize != bytes.len() {
                    return Err(format!(
                        "Only {written} of {} bytes reached the printer.",
                        bytes.len()
                    ));
                }
                Ok(())
            })();

            let _ = ClosePrinter(handle);
            result
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod platform {
    use super::PrinterInfo;

    // Carl ships to Windows POS machines. The desktop application still builds and runs on
    // other platforms for development, and reports plainly that it cannot print there
    // rather than pretending to have done so.
    pub fn list() -> Result<Vec<PrinterInfo>, String> {
        Ok(Vec::new())
    }

    pub fn print_raw(_printer: &str, _bytes: &[u8]) -> Result<(), String> {
        Err("Printing is only supported on Windows.".into())
    }
}

pub use platform::{list, print_raw};
