//! Device credential storage.
//!
//! The device secret is the terminal's identity: whatever holds it can file sales as this
//! till. It therefore goes into the operating system's credential store — Keychain on
//! macOS, Credential Manager on Windows — and never into SQLite, a config file, or an
//! environment variable.
//!
//! The distinction matters for a stolen laptop. With the secret in the OS store, a thief
//! who copies the application directory gets a product catalogue and a queue of receipts
//! that have already been printed. They do not get a working credential for the tenant.
//!
//! It is written once, at activation, and read only by the sync engine.

use keyring::Entry;
use thiserror::Error;

const SERVICE: &str = "com.carl.pos";

#[derive(Debug, Error)]
pub enum CredentialError {
    #[error("the operating system credential store is unavailable")]
    Unavailable,
    #[error("this terminal has not been activated")]
    NotActivated,
}

/// Stores the device secret issued at activation.
pub fn store_device_secret(device_id: &str, secret: &str) -> Result<(), CredentialError> {
    let entry = Entry::new(SERVICE, device_id).map_err(|_| CredentialError::Unavailable)?;
    entry
        .set_password(secret)
        .map_err(|_| CredentialError::Unavailable)
}

/// Reads the device secret.
///
/// Deliberately returns `NotActivated` rather than an empty string for a missing entry: an
/// empty secret would be sent to the server and rejected as a wrong credential, which is a
/// far more confusing failure than "this terminal is not set up".
pub fn read_device_secret(device_id: &str) -> Result<String, CredentialError> {
    let entry = Entry::new(SERVICE, device_id).map_err(|_| CredentialError::Unavailable)?;
    entry.get_password().map_err(|_| CredentialError::NotActivated)
}

/// Removes the secret. Called when a terminal is decommissioned or re-activated elsewhere.
pub fn clear_device_secret(device_id: &str) -> Result<(), CredentialError> {
    let entry = Entry::new(SERVICE, device_id).map_err(|_| CredentialError::Unavailable)?;
    // A missing entry is the desired end state, so it is not an error.
    let _ = entry.delete_credential();
    Ok(())
}
