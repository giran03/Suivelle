//! Commands for finding and fixing data in a database: duplicate records and property copies.

use super::{lock, logged, worker::blocking};
use crate::database::Db;
use crate::databases::datafix;
use crate::errors::AppResult;
use tauri::{AppHandle, Manager};

/// Groups of records that share the same values in the chosen properties.
#[tauri::command]
pub async fn record_duplicates(
    app: AppHandle,
    input: datafix::DuplicateQuery,
) -> AppResult<datafix::DuplicateReport> {
    blocking("record_duplicates", move || {
        let db = app.state::<Db>();
        let t = std::time::Instant::now();
        let res = lock(&db).and_then(|c| datafix::find_duplicates(&c, &input));
        logged("record_duplicates", t, res)
    })
    .await
}

/// Copies a property, settings and values included.
#[tauri::command]
pub async fn property_duplicate(
    app: AppHandle,
    id: String,
) -> AppResult<crate::databases::Property> {
    blocking("property_duplicate", move || {
        let db = app.state::<Db>();
        let t = std::time::Instant::now();
        let res = lock(&db).and_then(|mut c| datafix::duplicate_property(&mut c, &id));
        logged("property_duplicate", t, res)
    })
    .await
}
