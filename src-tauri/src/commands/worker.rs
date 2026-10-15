//! Serial admission to blocking IPC work: one worker instead of a thread per waiting DB caller.
use crate::errors::{AppError, AppResult};
use std::any::Any;
use std::sync::{Arc, OnceLock};
use tauri::async_runtime::Mutex;

static DIALOG_ACTIVITY: std::sync::Mutex<usize> = std::sync::Mutex::new(0);
pub fn dialog_active() -> bool {
    *DIALOG_ACTIVITY.lock().unwrap_or_else(|e| e.into_inner()) > 0
}
pub fn begin_update() -> AppResult<()> {
    let active = DIALOG_ACTIVITY.lock().unwrap_or_else(|e| e.into_inner());
    if *active > 0 {
        return Err(AppError::Validation(
            "Finish the open file operation before installing the update.".into(),
        ));
    }
    crate::updates::INSTALLING.store(true, std::sync::atomic::Ordering::SeqCst);
    Ok(())
}
struct DialogActivity;
impl Drop for DialogActivity {
    fn drop(&mut self) {
        *DIALOG_ACTIVITY.lock().unwrap_or_else(|e| e.into_inner()) -= 1;
    }
}

pub async fn blocking<T, F>(name: &'static str, work: F) -> AppResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> AppResult<T> + Send + 'static,
{
    static GATE: OnceLock<Arc<Mutex<()>>> = OnceLock::new();
    dispatch(&GATE, name, work).await
}

/// File pickers have their own lane so an open dialog never holds up autosave or navigation.
pub async fn dialog<T, F>(name: &'static str, work: F) -> AppResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> AppResult<T> + Send + 'static,
{
    {
        let mut active = DIALOG_ACTIVITY.lock().unwrap_or_else(|e| e.into_inner());
        if crate::updates::preparing() {
            return Err(AppError::Validation(
                "Suivelle is preparing an update. Try again after it restarts.".into(),
            ));
        }
        *active += 1;
    }
    let activity = DialogActivity;
    static GATE: OnceLock<Arc<Mutex<()>>> = OnceLock::new();
    dispatch(&GATE, name, move || {
        let _activity = activity;
        work()
    })
    .await
}

async fn dispatch<T, F>(
    gate: &'static OnceLock<Arc<Mutex<()>>>,
    name: &'static str,
    work: F,
) -> AppResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> AppResult<T> + Send + 'static,
{
    // Boxed so the runtime's task machinery is compiled once rather than once per command;
    // the two small allocations are negligible next to a thread-pool handoff.
    let result = run(gate, name, Box::new(move || Box::new(work()))).await?;
    *result
        .downcast::<AppResult<T>>()
        .expect("a worker job returns its own result type")
}

type Job = Box<dyn FnOnce() -> Box<dyn Any + Send> + Send>;

async fn run(
    gate: &'static OnceLock<Arc<Mutex<()>>>,
    name: &'static str,
    work: Job,
) -> AppResult<Box<dyn Any + Send>> {
    let queued = std::time::Instant::now();
    let permit = gate
        .get_or_init(|| Arc::new(Mutex::new(())))
        .clone()
        .lock_owned()
        .await;
    let queue_ms = queued.elapsed().as_millis() as u64;
    tauri::async_runtime::spawn_blocking(move || {
        // The job keeps admission even if its requesting future is cancelled.
        let _permit = permit;
        if crate::updates::preparing() && name != "update_install" {
            return Err(AppError::Validation(
                "Suivelle is preparing an update. Try again after it restarts.".into(),
            ));
        }
        let started = std::time::Instant::now();
        let result = work();
        tracing::debug!(
            command = name,
            queue_ms,
            execution_ms = started.elapsed().as_millis() as u64,
            "blocking IPC completed"
        );
        Ok(result)
    })
    .await
    .map_err(|e| AppError::Internal(format!("{name} worker failed: {e}")))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn an_open_dialog_does_not_block_database_jobs() {
        tauri::async_runtime::block_on(async {
            let (started, ready) = std::sync::mpsc::channel();
            let (release, wait) = std::sync::mpsc::channel();
            let task = tauri::async_runtime::spawn(dialog("picker", move || {
                started.send(()).unwrap();
                wait.recv_timeout(std::time::Duration::from_secs(5))
                    .unwrap();
                Ok(())
            }));
            ready
                .recv_timeout(std::time::Duration::from_secs(5))
                .unwrap();
            assert_eq!(blocking("autosave", || Ok(42)).await.unwrap(), 42);
            release.send(()).unwrap();
            task.await.unwrap().unwrap();
        });
    }

    #[test]
    fn serializes_blocking_jobs_and_recovers_after_failure() {
        tauri::async_runtime::block_on(async {
            let active = Arc::new(AtomicUsize::new(0));
            let mut tasks = Vec::new();
            for _ in 0..8 {
                let active = active.clone();
                tasks.push(tauri::async_runtime::spawn(async move {
                    blocking("probe", move || {
                        assert_eq!(active.fetch_add(1, Ordering::SeqCst), 0);
                        std::thread::sleep(std::time::Duration::from_millis(2));
                        assert_eq!(active.fetch_sub(1, Ordering::SeqCst), 1);
                        Ok(())
                    })
                    .await
                }));
            }
            for task in tasks {
                task.await.unwrap().unwrap();
            }
            assert!(
                blocking::<(), _>("failure", || Err(AppError::Validation("probe".into())))
                    .await
                    .is_err()
            );
            assert_eq!(blocking("next", || Ok(42)).await.unwrap(), 42);
        });
    }
}
