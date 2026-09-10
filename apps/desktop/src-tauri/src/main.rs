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
mod printer;

/// The local database.
///
/// Resolved by the SQL plugin against the platform's application-data directory —
/// `~/Library/Application Support/com.carl.pos` on macOS, `%APPDATA%\\com.carl.pos` on
/// Windows — so it survives restarts and updates, and is never inside the bundle.
///
/// This string must match the one the frontend passes to `Database.load`, because the
/// plugin keys registered migrations by it. A mismatch means the migrations never run
/// against the database that is actually opened.
const DB_URL: &str = "sqlite:carl.db";

/// Stores the secret issued by `activate_device`.
///
/// Called once, immediately after activation succeeds. The secret is passed straight from
/// the activation response into the OS credential store and is not retained anywhere in
/// between.
/// The printers Windows knows about.
///
/// Empty off Windows, and empty on a machine with none installed — which the console shows
/// as "no printer set up" rather than an error, because it is not one.
#[tauri::command]
fn list_printers() -> Result<Vec<printer::PrinterInfo>, String> {
    printer::list()
}

/// Sends raw ESC/POS bytes to a named printer.
///
/// `Ok` means the spooler accepted the job. It does not mean paper came out — Windows does
/// not report that, and the caller says "sent to the printer" rather than "printed".
#[tauri::command]
fn print_raw(printer_name: String, bytes: Vec<u8>) -> Result<(), String> {
    printer::print_raw(&printer_name, &bytes)
}

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

/// Stores the signed-in cashier's refresh token.
///
/// A sale is attributed to a person, so the terminal must be able to prove which person —
/// and that proof is a bearer credential for a real account, which belongs in the OS
/// credential store rather than in a database file on a counter.
#[tauri::command]
fn store_cashier_token(device_id: String, token: String) -> Result<(), String> {
    credentials::store_cashier_token(&device_id, &token).map_err(|error| error.to_string())
}

#[tauri::command]
fn read_cashier_token(device_id: String) -> Result<String, String> {
    credentials::read_cashier_token(&device_id).map_err(|error| error.to_string())
}

#[tauri::command]
fn clear_cashier_token(device_id: String) -> Result<(), String> {
    credentials::clear_cashier_token(&device_id).map_err(|error| error.to_string())
}

fn main() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_sql::Builder::default()
                /*
                 * The local schema, applied on first connection.
                 *
                 * This registration is the whole reason the terminal has any tables. Without
                 * it `Builder::default()` runs no migrations at all, `Database.load` returns
                 * an empty database, and the first query fails with "no such table:
                 * device_config" — after the application has already told the user it
                 * started.
                 *
                 * `include_str!` embeds the schema into the binary, so a terminal carries
                 * its own migrations and does not need to fetch anything to come up. A
                 * terminal updated after months offline brings its database forward before
                 * it is used.
                 *
                 * Adding to the schema means adding a NEW migration with the next version
                 * number, never editing this one: sqlx records which versions have run, and
                 * an edited migration is silently skipped on every terminal that already
                 * applied it.
                 */
                .add_migrations(
                    DB_URL,
                    vec![tauri_plugin_sql::Migration {
                        version: 1,
                        description: "carl local schema",
                        sql: include_str!("../schema.sql"),
                        kind: tauri_plugin_sql::MigrationKind::Up,
                    }],
                )
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            list_printers,
            print_raw,
            store_device_secret,
            read_device_secret,
            clear_device_secret,
            store_cashier_token,
            read_cashier_token,
            clear_cashier_token
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
