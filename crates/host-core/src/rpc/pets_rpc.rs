use crate::pets::PetLibrary;
use anyhow::{bail, Context, Result};
use serde_json::Value;
use std::path::Path;

pub(super) fn handle(data_dir: &Path, method: &str, params: &Value) -> Result<Value> {
    let library = PetLibrary::new(data_dir);
    let string = |key: &str| {
        params
            .get(key)
            .and_then(Value::as_str)
            .context("PET_INVALID_REQUEST")
    };
    match method {
        "pets.list" => library.list(),
        "pets.preferences" => library.update(params.clone()),
        "pets.image" => library.image(string("id")?),
        "pets.preview" => library.preview(Path::new(string("manifestPath")?)),
        "pets.import" => library.import(Path::new(string("manifestPath")?), string("fingerprint")?),
        _ => bail!("PET_UNKNOWN_METHOD"),
    }
}
