//! Keep database preparation off the window thread, without admitting the editor before it is safe.
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

type Outcome = Result<Option<String>, String>;

#[derive(Clone, Default)]
pub struct Startup(Arc<(Mutex<Option<Outcome>>, Condvar)>);

impl Startup {
    pub fn finish(&self, result: Outcome) {
        let (result_lock, ready) = &*self.0;
        *result_lock.lock().unwrap_or_else(|e| e.into_inner()) = Some(result);
        ready.notify_all();
    }

    pub fn wait(&self) -> Outcome {
        let (result_lock, ready) = &*self.0;
        let result = result_lock.lock().unwrap_or_else(|e| e.into_inner());
        let (result, _) = ready
            .wait_timeout_while(result, Duration::from_secs(60), |r| r.is_none())
            .unwrap_or_else(|e| e.into_inner());
        result.clone().unwrap_or_else(|| {
            Err("Workspace preparation is taking too long. Restart Suivelle and try again.".into())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn readiness_is_shared_across_reload_and_retains_safety_failures() {
        let startup = Startup::default();
        let waiting = startup.clone();
        let thread = std::thread::spawn(move || waiting.wait());
        startup.finish(Ok(Some("integrity check failed".into())));
        assert_eq!(thread.join().unwrap(), startup.wait());
        assert_eq!(startup.wait(), Ok(Some("integrity check failed".into())));
    }

    #[test]
    fn preparation_errors_do_not_admit_the_editor() {
        let startup = Startup::default();
        startup.finish(Err("Could not open the workspace".into()));
        assert!(startup.wait().is_err());
    }
}
