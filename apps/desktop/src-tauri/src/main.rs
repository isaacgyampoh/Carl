//! Carl Desktop.
//!
//! A thin Rust host around the same POS interface the web application serves. Its job is
//! the three things a browser cannot do: keep a durable local database, hold a credential
//! in the OS keychain, and talk to a receipt printer and cash drawer.
//!
//! Business rules live in TypeScript and, ultimately, in PostgreSQL. Nothing here decides
//! what anything costs.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod credentials;

/// Stores the secret issued by `activate_device`.
///
/// Called once, immediately after activation succeeds. The secret is passed straight from
/// the activation response into the OS credential store and is not retained anywhere in
/// between.
#[tauri::command]
fn store_device_secret(device_id: String, secret: String) -> Result<(), String> {
    credentials::store_device_secret(&device_id, &secret).map_err(|error| error.to_string())
}

/// Reads the secret for the sync engine.
#[tauri::command]
fn read_device_secret(device_id: String) -> Result<String, String> {
    credentials::read_device_secret(&device_id).map_err(|error| error.to_string())
}

#[tauri::command]
fn clear_device_secret(device_id: String) -> Result<(), String> {
    credentials::clear_device_secret(&device_id).map_err(|error| error.to_string())
}

fn main() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_sql::Builder::default()
                // Migrations are applied by the plugin on startup, so a terminal updated
                // after months offline brings its local database forward before it is used.
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            store_device_secret,
            read_device_secret,
            clear_device_secret
        ])
        .setup(|_app| {
            // Developer tools are deliberately NOT opened here, even in debug builds. A
            // till is operated by staff, and a devtools window that appears on a shop
            // floor is both confusing and a way to inspect a session that should not be
            // inspected. Open them explicitly when debugging instead.
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Carl Desktop failed to start");
}
