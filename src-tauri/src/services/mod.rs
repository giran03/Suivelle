//! Application services: validation + transactions + repository orchestration.
//! All mutations go through here so there is a single write path.

use crate::domain::*;
use crate::errors::{AppError, AppResult};
use crate::repositories as repo;
use crate::search;
use rusqlite::Connection;

pub mod duplicate;

pub mod workspace;

pub mod page;

pub mod block;

#[cfg(test)]
mod tests;
