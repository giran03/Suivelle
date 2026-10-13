//! Saving an exported HTML page as a PDF. The page is opened in a hidden window and printed to a
//! file by the system webview (WebView2's `PrintToPdf` on Windows), so the PDF matches what the
//! HTML export shows, with backgrounds and without the browser's headers and footers.

use crate::errors::{AppError, AppResult};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::Arc;
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(120);

/// Prints the HTML file at `html` to the PDF file at `out`.
pub fn print(app: &tauri::AppHandle, html: &Path, out: &Path) -> AppResult<()> {
    let url = tauri::Url::from_file_path(html)
        .map_err(|_| AppError::Internal("the page could not be opened for printing".into()))?;
    let (tx, rx) = channel::<Result<(), String>>();
    let started = Arc::new(AtomicBool::new(false));
    let label = format!("pdf-{}", crate::domain::new_id().replace('-', ""));
    let target = out.to_path_buf();
    let sender = tx.clone();
    let window = tauri::WebviewWindowBuilder::new(app, &label, tauri::WebviewUrl::External(url))
        .title("Saving PDF")
        .visible(false)
        .focused(false)
        .skip_taskbar(true)
        .on_page_load(move |w, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Finished
                && !started.swap(true, Ordering::SeqCst)
            {
                to_pdf(&w, &target, sender.clone());
            }
        })
        .build()
        .map_err(|e| {
            AppError::Internal(format!("the page could not be opened for printing: {e}"))
        })?;
    let res = rx.recv_timeout(TIMEOUT);
    let _ = window.destroy();
    drop(tx);
    match res {
        Ok(Ok(())) if out.is_file() => Ok(()),
        Ok(Ok(())) => Err(AppError::Internal("the PDF was not written".into())),
        Ok(Err(e)) => Err(AppError::Internal(format!(
            "the PDF could not be written: {e}"
        ))),
        Err(_) => Err(AppError::Internal("saving the PDF took too long".into())),
    }
}

#[cfg(windows)]
fn to_pdf(w: &tauri::WebviewWindow, out: &Path, tx: Sender<Result<(), String>>) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Environment6, ICoreWebView2_7,
    };
    use webview2_com::PrintToPdfCompletedHandler;
    use windows_core::{Interface, HSTRING};
    let out = HSTRING::from(out.as_os_str());
    let fail = tx.clone();
    let res = w.with_webview(move |wv| {
        let run = || -> windows_core::Result<()> {
            // SAFETY: the WebView2 objects are used on the thread that owns them, as `with_webview`
            // guarantees, and the completion handler owns everything it captures.
            unsafe {
                let core: ICoreWebView2_7 = wv.controller().CoreWebView2()?.cast()?;
                let env: ICoreWebView2Environment6 = wv.environment().cast()?;
                let settings = env.CreatePrintSettings()?;
                settings.SetShouldPrintBackgrounds(true)?;
                settings.SetShouldPrintHeaderAndFooter(false)?;
                let done = tx.clone();
                let handler = PrintToPdfCompletedHandler::create(Box::new(move |result, ok| {
                    let _ = done.send(match result {
                        Ok(()) if ok => Ok(()),
                        Ok(()) => Err("the webview could not print the page".into()),
                        Err(e) => Err(e.message()),
                    });
                    Ok(())
                }));
                core.PrintToPdf(&out, &settings, &handler)
            }
        };
        if let Err(e) = run() {
            let _ = tx.send(Err(e.message()));
        }
    });
    if let Err(e) = res {
        let _ = fail.send(Err(e.to_string()));
    }
}

#[cfg(not(windows))]
fn to_pdf(_: &tauri::WebviewWindow, _: &Path, tx: Sender<Result<(), String>>) {
    let _ = tx.send(Err(
        "saving as PDF is available on Windows; export as HTML and print it from a browser".into(),
    ));
}
