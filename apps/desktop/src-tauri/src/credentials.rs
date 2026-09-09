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
//!
//! The cashier's refresh token lives here too, for the same reason: it is a bearer
//! credential for a real person's account, and a shift's worth of it sitting in a SQLite
//! file on a counter is a shift's worth of it walking out of the shop.

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

fn entry_for(account: &str) -> Result<Entry, CredentialError> {
    Entry::new(SERVICE, account).map_err(|_| CredentialError::Unavailable)
}

/// Stores the device secret issued at activation.
pub fn store_device_secret(device_id: &str, secret: &str) -> Result<(), CredentialError> {
    entry_for(device_id)?
        .set_password(secret)
        .map_err(|_| CredentialError::Unavailable)
}

/// The keychain account holding the signed-in cashier's refresh token.
///
/// Namespaced by device so a machine re-activated against a different branch cannot
/// present the previous branch's cashier session.
fn cashier_account(device_id: &str) -> String {
    format!("{device_id}:cashier")
}

/// Stores the refresh token for the cashier signed in at this terminal.
pub fn store_cashier_token(device_id: &str, token: &str) -> Result<(), CredentialError> {
    entry_for(&cashier_account(device_id))?
        .set_password(token)
        .map_err(|_| CredentialError::Unavailable)
}

pub fn read_cashier_token(device_id: &str) -> Result<String, CredentialError> {
    entry_for(&cashier_account(device_id))?
        .get_password()
        .map_err(|_| CredentialError::NotActivated)
}

/// Called when the cashier signs out, or at the end of a shift.
pub fn clear_cashier_token(device_id: &str) -> Result<(), CredentialError> {
    let _ = entry_for(&cashier_account(device_id))?.delete_credential();
    Ok(())
}

/// Reads the device secret.
///
/// Deliberately returns `NotActivated` rather than an empty string for a missing entry: an
/// empty secret would be sent to the server and rejected as a wrong credential, which is a
/// far more confusing failure than "this terminal is not set up".
pub fn read_device_secret(device_id: &str) -> Result<String, CredentialError> {
    entry_for(device_id)?
        .get_password()
        .map_err(|_| CredentialError::NotActivated)
}

/// Removes the secret. Called when a terminal is decommissioned or re-activated elsewhere.
pub fn clear_device_secret(device_id: &str) -> Result<(), CredentialError> {
    // A missing entry is the desired end state, so it is not an error.
    let _ = entry_for(device_id)?.delete_credential();
    Ok(())
}
