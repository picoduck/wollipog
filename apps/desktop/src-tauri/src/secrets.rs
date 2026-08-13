use keyring::Entry;
use secrecy::{ExposeSecret, SecretString};
use tokio::sync::Mutex;

pub(crate) const REMOTE_INSTANCE_SECRET_SERVICE: &str = "ai.wollipog.remote-instance";
static NATIVE_VAULT_LOCK: Mutex<()> = Mutex::const_new(());

pub(crate) trait SecretStore: Send + Sync {
    fn get(&self, profile_id: &str) -> Result<SecretString, String>;
    fn set(&self, profile_id: &str, secret: &SecretString) -> Result<(), String>;
    fn delete(&self, profile_id: &str) -> Result<(), String>;
}

#[derive(Default)]
pub(crate) struct NativeSecretStore;

impl NativeSecretStore {
    fn entry(profile_id: &str) -> Result<Entry, String> {
        Entry::new(REMOTE_INSTANCE_SECRET_SERVICE, profile_id)
            .map_err(|_| "the operating-system credential vault is unavailable".to_string())
    }

    fn get_optional(&self, profile_id: &str) -> Result<Option<SecretString>, String> {
        match Self::entry(profile_id)?.get_password() {
            Ok(secret) => Ok(Some(SecretString::from(secret))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err("the remote instance credential is unavailable".to_string()),
        }
    }
}

impl SecretStore for NativeSecretStore {
    fn get(&self, profile_id: &str) -> Result<SecretString, String> {
        self.get_optional(profile_id)?
            .ok_or_else(|| "the remote instance credential is missing".to_string())
    }

    fn set(&self, profile_id: &str, secret: &SecretString) -> Result<(), String> {
        Self::entry(profile_id)?
            .set_password(secret.expose_secret())
            .map_err(|_| "the remote instance credential could not be stored securely".to_string())
    }

    fn delete(&self, profile_id: &str) -> Result<(), String> {
        let entry = Self::entry(profile_id)?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err("the remote instance credential could not be removed".to_string()),
        }
    }
}

pub(crate) async fn native_secret_get(profile_id: String) -> Result<SecretString, String> {
    let _guard = NATIVE_VAULT_LOCK.lock().await;
    tokio::task::spawn_blocking(move || NativeSecretStore.get(&profile_id))
        .await
        .map_err(|_| "the operating-system credential vault stopped unexpectedly".to_string())?
}

pub(crate) async fn native_secret_get_optional(
    profile_id: String,
) -> Result<Option<SecretString>, String> {
    let _guard = NATIVE_VAULT_LOCK.lock().await;
    tokio::task::spawn_blocking(move || NativeSecretStore.get_optional(&profile_id))
        .await
        .map_err(|_| "the operating-system credential vault stopped unexpectedly".to_string())?
}

pub(crate) async fn native_secret_set(
    profile_id: String,
    secret: SecretString,
) -> Result<(), String> {
    let _guard = NATIVE_VAULT_LOCK.lock().await;
    tokio::task::spawn_blocking(move || NativeSecretStore.set(&profile_id, &secret))
        .await
        .map_err(|_| "the operating-system credential vault stopped unexpectedly".to_string())?
}

pub(crate) async fn native_secret_delete(profile_id: String) -> Result<(), String> {
    let _guard = NATIVE_VAULT_LOCK.lock().await;
    tokio::task::spawn_blocking(move || NativeSecretStore.delete(&profile_id))
        .await
        .map_err(|_| "the operating-system credential vault stopped unexpectedly".to_string())?
}

#[cfg(test)]
pub(crate) mod tests {
    use std::collections::HashMap;
    use std::sync::Mutex;

    use super::SecretStore;
    use secrecy::{ExposeSecret, SecretString};

    #[derive(Default)]
    pub(crate) struct MemorySecretStore {
        pub(crate) secrets: Mutex<HashMap<String, String>>,
        pub(crate) fail_set: Mutex<bool>,
        pub(crate) fail_delete: Mutex<bool>,
    }

    impl SecretStore for MemorySecretStore {
        fn get(&self, profile_id: &str) -> Result<SecretString, String> {
            self.secrets
                .lock()
                .unwrap()
                .get(profile_id)
                .cloned()
                .map(SecretString::from)
                .ok_or_else(|| "missing".to_string())
        }

        fn set(&self, profile_id: &str, secret: &SecretString) -> Result<(), String> {
            if *self.fail_set.lock().unwrap() {
                return Err("set failed".into());
            }
            self.secrets
                .lock()
                .unwrap()
                .insert(profile_id.to_string(), secret.expose_secret().to_string());
            Ok(())
        }

        fn delete(&self, profile_id: &str) -> Result<(), String> {
            if *self.fail_delete.lock().unwrap() {
                return Err("delete failed".into());
            }
            self.secrets.lock().unwrap().remove(profile_id);
            Ok(())
        }
    }

    #[test]
    fn memory_secret_store_keeps_profiles_isolated_and_deletion_idempotent() {
        let store = MemorySecretStore::default();
        let first = SecretString::from("first-secret".to_string());
        let second = SecretString::from("second-secret".to_string());
        store.set("profile-a", &first).unwrap();
        store.set("profile-b", &second).unwrap();
        assert_eq!(
            store.get("profile-a").unwrap().expose_secret(),
            "first-secret"
        );
        assert_eq!(
            store.get("profile-b").unwrap().expose_secret(),
            "second-secret"
        );
        store.delete("profile-a").unwrap();
        store.delete("profile-a").unwrap();
        assert!(store.get("profile-a").is_err());
        assert_eq!(
            store.get("profile-b").unwrap().expose_secret(),
            "second-secret"
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_credential_manager_round_trip_uses_a_random_profile_account() {
        struct CredentialCleanup(String);
        impl Drop for CredentialCleanup {
            fn drop(&mut self) {
                let _ = super::NativeSecretStore.delete(&self.0);
            }
        }

        let store = super::NativeSecretStore;
        let profile_id = uuid::Uuid::new_v4().to_string();
        let _cleanup = CredentialCleanup(profile_id.clone());
        let secret = SecretString::from("temporary-wollipog-vault-test".to_string());
        assert!(store.get_optional(&profile_id).unwrap().is_none());
        store.set(&profile_id, &secret).unwrap();
        assert_eq!(
            store.get(&profile_id).unwrap().expose_secret(),
            "temporary-wollipog-vault-test"
        );
        store.delete(&profile_id).unwrap();
        assert!(store.get_optional(&profile_id).unwrap().is_none());
    }
}
