use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use subtle::ConstantTimeEq;

const ROUNDS: u32 = 600_000;

#[derive(Clone, Serialize, Deserialize)]
struct LockRecord {
    version: u8,
    kind: String,
    salt: [u8; 16],
    hash: [u8; 32],
    attempts: u8,
    logged_out: bool,
}

#[derive(Clone, Serialize)]
pub struct LockStatus {
    pub revision: u64,
    pub configured: bool,
    pub kind: Option<String>,
    pub locked: bool,
    pub remaining_attempts: u8,
    pub logout_pending: bool,
    pub logged_out: bool,
    pub session_suspended: bool,
}

#[derive(Serialize)]
pub struct LockResult {
    pub accepted: bool,
    pub status: LockStatus,
}

pub struct AppLock {
    revision: u64,
    path: PathBuf,
    record: Option<LockRecord>,
    unlocked: bool,
    error: bool,
    pub logout_started: bool,
    suspended: bool,
    resume_requested: bool,
    committing: bool,
    session_logged_out: bool,
}

impl AppLock {
    pub fn load(path: PathBuf) -> Self {
        let mut lock = Self { revision: 0, path, record: None, unlocked: true, error: false, logout_started: false, suspended: false, resume_requested: false, committing: false, session_logged_out: false };
        match std::fs::read(&lock.path) {
            Ok(bytes) => match serde_json::from_slice::<LockRecord>(&bytes) {
                Ok(record) if record.version == 1 && ["pin", "password"].contains(&record.kind.as_str()) && record.attempts <= 5 && (!record.logged_out || record.attempts == 5) => {
                    lock.unlocked = record.logged_out;
                    lock.record = Some(record);
                }
                _ => { lock.error = true; lock.unlocked = false; }
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
            Err(_) => { lock.error = true; lock.unlocked = false; }
        }
        match std::fs::read(lock.exit_path()) {
            Ok(bytes) => {
                if serde_json::from_slice::<bool>(&bytes).ok() == Some(true) { lock.session_logged_out = true; }
                else { lock.committing = true; }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
            Err(_) => lock.committing = true,
        }
        lock
    }

    pub fn is_unlocked(&self) -> bool { self.unlocked && !self.error && !self.logout_pending() && !self.suspended }

    pub fn logout_pending(&self) -> bool {
        self.committing || self.record.as_ref().is_some_and(|record| record.attempts == 5 && !record.logged_out)
    }

    pub fn status(&self) -> Result<LockStatus, String> {
        if self.error { return Err("Не удалось прочитать настройки блокировки".into()); }
        let configured = self.record.as_ref().is_some_and(|record| !record.logged_out);
        Ok(LockStatus {
            revision: self.revision,
            configured, kind: self.record.as_ref().filter(|_| configured).map(|record| record.kind.clone()),
            locked: if self.suspended && !self.resume_requested && !self.logout_pending() { false } else { !self.is_unlocked() },
            remaining_attempts: self.record.as_ref().map_or(5, |record| 5_u8.saturating_sub(record.attempts)),
            logout_pending: self.logout_pending(), logged_out: self.session_logged_out || self.record.as_ref().is_some_and(|record| record.logged_out),
            session_suspended: self.suspended,
        })
    }

    fn persist(&self) -> Result<(), String> {
        use std::io::Write;
        let Some(record) = &self.record else {
            return match std::fs::remove_file(&self.path) {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(_) => Err("Не удалось сохранить настройки блокировки".into()),
            };
        };
        let bytes = serde_json::to_vec(record).map_err(|_| "Не удалось сохранить настройки блокировки")?;
        let temporary = self.path.with_extension("tmp");
        let mut file = std::fs::File::create(&temporary).map_err(|_| "Не удалось сохранить настройки блокировки")?;
        file.write_all(&bytes).and_then(|_| file.sync_all()).map_err(|_| "Не удалось сохранить настройки блокировки")?;
        drop(file);
        std::fs::rename(temporary, &self.path).map_err(|error| {
            eprintln!("[app-lock] save: {error}");
            "Не удалось сохранить настройки блокировки".into()
        })
    }

    fn matches(&mut self, secret: &str) -> Result<bool, String> {
        self.status()?;
        if self.logout_pending() { return Ok(false); }
        let Some(record) = &mut self.record else { return Ok(true); };
        if record.logged_out { return Ok(true); }
        let mut hash = [0_u8; 32];
        if secret.len() <= 512 {
            pbkdf2::pbkdf2_hmac::<sha2::Sha256>(secret.as_bytes(), &record.salt, ROUNDS, &mut hash);
        }
        let accepted = secret.len() <= 512 && bool::from(hash.ct_eq(&record.hash));
        if accepted { record.attempts = 0; }
        else {
            record.attempts = record.attempts.saturating_add(1).min(5);
            if record.attempts == 5 { self.unlocked = false; }
        }
        self.revision += 1;
        self.persist()?;
        Ok(accepted)
    }

    pub fn unlock(&mut self, secret: &str) -> Result<bool, String> {
        if self.suspended && !self.resume_requested { return Err("Сначала введите номер телефона".into()); }
        if self.is_unlocked() { return Ok(true); }
        let accepted = self.matches(secret)?;
        if accepted {
            if self.suspended { self.finish_resume()?; }
            self.unlocked = true;
        }
        Ok(accepted)
    }

    pub fn set_secret(&mut self, current: &str, kind: Option<&str>, secret: &str) -> Result<bool, String> {
        self.status()?;
        if !self.is_unlocked() { return Err("Сначала разблокируйте приложение".into()); }
        if let Some(kind) = kind { validate_secret(kind, secret)?; }
        if !self.matches(current)? { return Ok(false); }
        let previous = self.record.clone();
        self.record = match kind {
            Some(kind) => {
                let mut salt = [0_u8; 16];
                getrandom::fill(&mut salt).map_err(|_| "Не удалось установить пароль")?;
                let mut hash = [0_u8; 32];
                pbkdf2::pbkdf2_hmac::<sha2::Sha256>(secret.as_bytes(), &salt, ROUNDS, &mut hash);
                Some(LockRecord { version: 1, kind: kind.into(), salt, hash, attempts: 0, logged_out: false })
            }
            None => None,
        };
        if let Err(error) = self.persist() { self.record = previous; return Err(error); }
        self.revision += 1;
        self.unlocked = true;
        Ok(true)
    }

    pub fn complete_logout(&mut self) -> Result<(), String> {
        if !self.logout_pending() { return Ok(()); }
        if let Some(record) = &mut self.record {
            if record.attempts == 5 { record.logged_out = true; }
        }
        self.persist()?;
        if self.committing || self.suspended {
            self.write_exit(true)?;
            self.session_logged_out = true;
        }
        self.committing = false;
        self.suspended = false;
        self.resume_requested = false;
        self.revision += 1;
        self.unlocked = true;
        Ok(())
    }

    pub fn acknowledge_logout(&mut self) -> Result<(), String> {
        if self.record.as_ref().is_some_and(|record| record.logged_out) {
            let previous = self.record.take();
            if let Err(error) = self.persist() { self.record = previous; return Err(error); }
            self.revision += 1;
        }
        if self.session_logged_out {
            self.remove_exit()?;
            self.session_logged_out = false;
            self.revision += 1;
        }
        Ok(())
    }

    pub fn session_suspended(&self) -> bool { self.suspended && !self.committing }

    pub fn suspend_session(&mut self) -> Result<(), String> {
        if !self.is_unlocked() { return Err("Приложение заблокировано".into()); }
        self.write_exit(false)?;
        self.suspended = true;
        self.resume_requested = false;
        self.revision += 1;
        Ok(())
    }

    pub fn request_session_resume(&mut self) -> Result<(), String> {
        if !self.session_suspended() || self.logout_pending() { return Err("Сессия недоступна".into()); }
        if self.record.as_ref().is_some_and(|record| !record.logged_out) {
            self.resume_requested = true;
            self.unlocked = false;
        } else { self.finish_resume()?; }
        self.revision += 1;
        Ok(())
    }

    pub fn commit_session_exit(&mut self) -> Result<(), String> {
        if !self.session_suspended() { return Ok(()); }
        self.write_exit(false)?;
        self.committing = true;
        self.suspended = false;
        self.resume_requested = false;
        self.unlocked = false;
        self.revision += 1;
        Ok(())
    }

    fn finish_resume(&mut self) -> Result<(), String> {
        self.remove_exit()?;
        self.suspended = false;
        self.resume_requested = false;
        self.unlocked = true;
        self.revision += 1;
        Ok(())
    }

    fn exit_path(&self) -> PathBuf { self.path.with_file_name("pending-logout.json") }

    fn write_exit(&self, completed: bool) -> Result<(), String> {
        use std::io::Write;
        let path = self.exit_path();
        let temporary = path.with_extension("tmp");
        let mut file = std::fs::File::create(&temporary).map_err(|_| "Не удалось сохранить состояние выхода")?;
        file.write_all(if completed { b"true" } else { b"false" }).and_then(|_| file.sync_all()).map_err(|_| "Не удалось сохранить состояние выхода")?;
        drop(file);
        std::fs::rename(temporary, path).map_err(|_| "Не удалось сохранить состояние выхода".into())
    }

    fn remove_exit(&self) -> Result<(), String> {
        match std::fs::remove_file(self.exit_path()) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err("Не удалось восстановить сессию".into()),
        }
    }
}

fn validate_secret(kind: &str, secret: &str) -> Result<(), String> {
    match kind {
        "pin" if secret.len() == 4 && secret.bytes().all(|byte| byte.is_ascii_digit()) => Ok(()),
        "pin" => Err("Введите код из 4 цифр".into()),
        "password" if (4..=128).contains(&secret.chars().count()) && secret.len() <= 512 => Ok(()),
        "password" => Err("Пароль должен содержать от 4 до 128 символов".into()),
        _ => Err("Неизвестный тип пароля".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn path() -> PathBuf {
        let mut id = [0_u8; 8];
        getrandom::fill(&mut id).unwrap();
        let folder = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target").join(format!("lock-test-{}-{}", std::process::id(), u64::from_le_bytes(id)));
        std::fs::create_dir(&folder).unwrap();
        folder.join("app-lock.json")
    }

    fn cleanup(path: &PathBuf) {
        if path.exists() { std::fs::remove_file(path).unwrap(); }
        std::fs::remove_dir(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn suspended_session_resumes_without_a_password_and_removes_exit_intent() {
        let path = path();
        let mut lock = AppLock::load(path.clone());
        lock.suspend_session().unwrap();
        assert!(!lock.is_unlocked());
        assert!(lock.session_suspended());
        assert!(!lock.status().unwrap().locked);
        assert!(!lock.logout_pending());
        assert!(lock.unlock("").is_err());
        lock.request_session_resume().unwrap();
        assert!(lock.is_unlocked());
        assert!(!lock.session_suspended());
        assert!(!lock.exit_path().exists());
        assert!(!AppLock::load(path.clone()).logout_pending());
        cleanup(&path);
    }

    #[test]
    fn suspended_session_requires_local_pin_and_can_still_force_logout() {
        let path = path();
        let mut lock = AppLock::load(path.clone());
        lock.set_secret("", Some("pin"), "7315").unwrap();
        lock.suspend_session().unwrap();
        lock.request_session_resume().unwrap();
        assert!(lock.status().unwrap().locked);
        assert!(!lock.unlock("0000").unwrap());
        assert!(lock.session_suspended());
        assert!(lock.unlock("7315").unwrap());
        assert!(lock.is_unlocked());
        lock.suspend_session().unwrap();
        lock.request_session_resume().unwrap();
        for _ in 0..5 { assert!(!lock.unlock("0000").unwrap()); }
        assert!(lock.logout_pending());
        lock.complete_logout().unwrap();
        assert!(lock.status().unwrap().logged_out);
        lock.acknowledge_logout().unwrap();
        cleanup(&path);
    }

    #[test]
    fn close_or_crash_commits_deferred_logout_without_clearing_the_pin() {
        let path = path();
        let mut lock = AppLock::load(path.clone());
        lock.set_secret("", Some("pin"), "7315").unwrap();
        lock.suspend_session().unwrap();
        let mut after_crash = AppLock::load(path.clone());
        assert!(after_crash.logout_pending());
        assert!(!after_crash.is_unlocked());
        assert!(!after_crash.unlock("7315").unwrap());
        after_crash.complete_logout().unwrap();
        let mut restarted = AppLock::load(path.clone());
        assert!(restarted.status().unwrap().logged_out);
        restarted.acknowledge_logout().unwrap();
        assert!(restarted.status().unwrap().configured);
        assert!(!restarted.is_unlocked());
        assert!(restarted.unlock("7315").unwrap());
        restarted.suspend_session().unwrap();
        restarted.commit_session_exit().unwrap();
        assert!(restarted.logout_pending());
        assert!(!restarted.session_suspended());
        restarted.complete_logout().unwrap();
        restarted.acknowledge_logout().unwrap();
        cleanup(&path);
    }

    #[test]
    fn preserves_failed_attempts_and_forced_logout_across_restarts() {
        let path = path();
        let mut lock = AppLock::load(path.clone());
        assert!(lock.set_secret("", Some("pin"), "3851").unwrap());
        let bytes = std::fs::read_to_string(&path).unwrap();
        assert!(!bytes.contains("3851"));
        for remaining in (0..5).rev() {
            lock = AppLock::load(path.clone());
            assert!(!lock.is_unlocked());
            assert!(!lock.unlock("0000").unwrap());
            assert_eq!(lock.status().unwrap().remaining_attempts, remaining);
        }
        lock = AppLock::load(path.clone());
        assert!(lock.logout_pending());
        assert!(!lock.unlock("3851").unwrap());
        lock.complete_logout().unwrap();
        lock = AppLock::load(path.clone());
        assert!(lock.status().unwrap().logged_out);
        assert!(lock.is_unlocked());
        lock.acknowledge_logout().unwrap();
        assert!(!path.exists());
        assert!(!lock.status().unwrap().configured);
        cleanup(&path);
    }

    #[test]
    fn resets_attempts_after_unlock_and_requires_the_current_password_to_disable() {
        let path = path();
        let mut lock = AppLock::load(path.clone());
        assert!(lock.set_secret("", Some("password"), "тест-пароль").unwrap());
        lock = AppLock::load(path.clone());
        assert!(!lock.unlock("wrong").unwrap());
        assert!(lock.unlock("тест-пароль").unwrap());
        assert_eq!(lock.status().unwrap().remaining_attempts, 5);
        assert!(!lock.set_secret("wrong", None, "").unwrap());
        assert!(lock.status().unwrap().configured);
        assert!(lock.set_secret("тест-пароль", None, "").unwrap());
        assert!(!AppLock::load(path.clone()).status().unwrap().configured);
        cleanup(&path);
    }

    #[test]
    fn rejects_invalid_configuration_and_secret_formats() {
        let path = path();
        std::fs::write(&path, b"broken configuration").unwrap();
        let mut lock = AppLock::load(path.clone());
        assert!(!lock.is_unlocked());
        assert!(lock.status().is_err());
        assert!(lock.unlock("anything").is_err());
        assert!(lock.set_secret("", Some("pin"), "1234").is_err());
        assert!(validate_secret("pin", "123").is_err());
        assert!(validate_secret("pin", "abcd").is_err());
        assert!(validate_secret("password", "abc").is_err());
        assert!(validate_secret("password", "🦋🦋🦋🦋").is_ok());
        cleanup(&path);
    }
}
