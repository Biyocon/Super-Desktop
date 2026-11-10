//! Versioned, host-owned pet library. Imports copy data, never execute it.
mod image;
#[cfg(test)]
mod tests;

use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use uuid::Uuid;

const MAX_IMAGE: u64 = 8_000_000;
const MAX_MANIFEST: u64 = 16_384;
const MAX_LIBRARY: usize = 20;
const HASSAN: &[u8] = include_bytes!("../assets/pets/hassan.webp");

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub id: String,
    pub display_name: String,
    pub description: String,
    #[serde(default = "v1")]
    pub sprite_version_number: u8,
    pub spritesheet_path: String,
}
fn v1() -> u8 {
    1
}
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 40
        && id.as_bytes()[0].is_ascii_lowercase()
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}
impl Manifest {
    fn validate(&self) -> Result<()> {
        if !valid_id(&self.id) {
            bail!("PET_INVALID_ID");
        }
        if self.display_name.trim().is_empty()
            || self.display_name.chars().count() > 80
            || self.description.chars().count() > 500
        {
            bail!("PET_INVALID_METADATA");
        }
        if !matches!(self.sprite_version_number, 1 | 2) {
            bail!("PET_INVALID_VERSION");
        }
        if !matches!(
            self.spritesheet_path.as_str(),
            "spritesheet.webp" | "spritesheet.png"
        ) {
            bail!("PET_INVALID_PATH");
        }
        Ok(())
    }
    fn record(&self, builtin: bool) -> Value {
        json!({"id": self.id, "displayName": self.display_name, "description": self.description,
            "spriteVersionNumber": self.sprite_version_number, "spritesheetPath": self.spritesheet_path,
            "builtin": builtin})
    }
}
fn hassan() -> Manifest {
    Manifest {
        id: "hassan".into(),
        display_name: "Hassan".into(),
        description: "A calm, curious technical companion with a sense of structure and quality."
            .into(),
        sprite_version_number: 2,
        spritesheet_path: "spritesheet.webp".into(),
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Position {
    pub x: i32,
    pub y: i32,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct Preferences {
    pub selected_pet: Option<String>,
    pub mini_visible: bool,
    pub always_on_top: bool,
    pub scale: f64,
    pub follow_pointer: bool,
    pub position: Option<Position>,
}
impl Default for Preferences {
    fn default() -> Self {
        Self {
            selected_pet: Some("hassan".into()),
            mini_visible: false,
            always_on_top: true,
            scale: 1.0,
            follow_pointer: true,
            position: None,
        }
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    manifest: Manifest,
    directory: String,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Library {
    version: u8,
    preferences: Preferences,
    pets: Vec<Entry>,
}
impl Default for Library {
    fn default() -> Self {
        Self {
            version: 1,
            preferences: Preferences::default(),
            pets: vec![],
        }
    }
}

fn bounded_read(path: &Path, limit: u64) -> Result<Vec<u8>> {
    let meta = fs::symlink_metadata(path).context("PET_FILE_UNAVAILABLE")?;
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > limit {
        bail!("PET_INVALID_FILE");
    }
    let mut data = Vec::new();
    File::open(path)?.take(limit + 1).read_to_end(&mut data)?;
    if data.len() as u64 > limit {
        bail!("PET_FILE_TOO_LARGE");
    }
    Ok(data)
}
fn atomic_write(path: &Path, data: &[u8]) -> Result<()> {
    let parent = path.parent().context("PET_INVALID_STORAGE")?;
    fs::create_dir_all(parent)?;
    let temp = parent.join(format!(".{}.tmp", Uuid::new_v4()));
    let result = (|| -> Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        file.write_all(data)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temp, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

pub struct PetLibrary {
    root: PathBuf,
}
impl PetLibrary {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            root: data_dir.join("pets"),
        }
    }
    fn load(&self) -> Result<Library> {
        let path = self.root.join("library.json");
        let library: Library = match fs::symlink_metadata(&path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Library::default(),
            Err(e) => return Err(e.into()),
            Ok(_) => serde_json::from_slice(&bounded_read(&path, 128_000)?)
                .context("PET_STORAGE_CORRUPT")?,
        };
        if library.version != 1 || library.pets.len() > MAX_LIBRARY {
            bail!("PET_STORAGE_VERSION");
        }
        let mut ids = std::collections::HashSet::new();
        ids.insert("hassan".to_string());
        for entry in &library.pets {
            entry.manifest.validate()?;
            Uuid::parse_str(&entry.directory).context("PET_INVALID_STORAGE_PATH")?;
            if !ids.insert(entry.manifest.id.clone()) {
                bail!("PET_DUPLICATE_ID");
            }
        }
        self.validate_preferences(&library.preferences, &library)?;
        Ok(library)
    }
    fn save(&self, library: &Library) -> Result<()> {
        atomic_write(
            &self.root.join("library.json"),
            &serde_json::to_vec_pretty(library)?,
        )
    }
    fn validate_preferences(&self, preferences: &Preferences, library: &Library) -> Result<()> {
        if !preferences.scale.is_finite() || !(0.75..=1.5).contains(&preferences.scale) {
            bail!("PET_INVALID_SCALE");
        }
        if let Some(pos) = &preferences.position {
            if pos.x.unsigned_abs() > 1_000_000 || pos.y.unsigned_abs() > 1_000_000 {
                bail!("PET_INVALID_POSITION");
            }
        }
        if let Some(id) = &preferences.selected_pet {
            if id != "hassan" && !library.pets.iter().any(|e| &e.manifest.id == id) {
                bail!("PET_NOT_FOUND");
            }
        }
        Ok(())
    }
    pub fn list(&self) -> Result<Value> {
        let library = self.load()?;
        let mut pets = vec![hassan().record(true)];
        pets.extend(library.pets.iter().map(|p| p.manifest.record(false)));
        Ok(json!({"pets": pets, "preferences": library.preferences}))
    }
    pub fn update(&self, patch: Value) -> Result<Value> {
        let mut library = self.load()?;
        let mut value = serde_json::to_value(&library.preferences)?;
        let patch = patch.as_object().context("PET_INVALID_PREFERENCES")?;
        for (key, item) in patch {
            value[key] = item.clone();
        }
        let preferences: Preferences =
            serde_json::from_value(value).context("PET_INVALID_PREFERENCES")?;
        self.validate_preferences(&preferences, &library)?;
        library.preferences = preferences;
        self.save(&library)?;
        self.list()
    }
    fn source(&self, path: &Path) -> Result<(Manifest, Vec<u8>, String)> {
        if !path.is_absolute() || path.file_name().and_then(|s| s.to_str()) != Some("pet.json") {
            bail!("PET_INVALID_MANIFEST_PATH");
        }
        let raw = bounded_read(path, MAX_MANIFEST)?;
        let manifest: Manifest = serde_json::from_slice(&raw).context("PET_INVALID_MANIFEST")?;
        manifest.validate()?;
        let parent = path
            .parent()
            .context("PET_INVALID_MANIFEST_PATH")?
            .canonicalize()?;
        let image_path = parent.join(&manifest.spritesheet_path);
        let image = bounded_read(&image_path, MAX_IMAGE)?;
        if image_path.canonicalize()?.parent() != Some(parent.as_path()) {
            bail!("PET_INVALID_PATH");
        }
        image::validate(
            &image,
            manifest.sprite_version_number,
            &manifest.spritesheet_path,
        )?;
        let mut hasher = Sha256::new();
        hasher.update(&raw);
        hasher.update(&image);
        Ok((manifest, image, hex::encode(hasher.finalize())))
    }
    pub fn preview(&self, path: &Path) -> Result<Value> {
        let (manifest, bytes, fingerprint) = self.source(path)?;
        let library = self.load()?;
        if manifest.id == "hassan" || library.pets.iter().any(|e| e.manifest.id == manifest.id) {
            bail!("PET_DUPLICATE_ID");
        }
        Ok(
            json!({"pet": manifest.record(false), "dataUrl": data_url(&bytes, &manifest.spritesheet_path), "fingerprint": fingerprint}),
        )
    }
    pub fn import(&self, path: &Path, fingerprint: &str) -> Result<Value> {
        let (mut manifest, bytes, current_fingerprint) = self.source(path)?;
        if current_fingerprint != fingerprint {
            bail!("PET_SOURCE_CHANGED");
        }
        let mut library = self.load()?;
        if library.pets.len() >= MAX_LIBRARY {
            bail!("PET_LIBRARY_FULL");
        }
        if manifest.id == "hassan" || library.pets.iter().any(|e| e.manifest.id == manifest.id) {
            bail!("PET_DUPLICATE_ID");
        }
        manifest.display_name = manifest.display_name.trim().to_string();
        let directory = Uuid::new_v4().to_string();
        let dest = self.root.join("imported").join(&directory);
        fs::create_dir_all(dest.parent().context("PET_INVALID_STORAGE")?)?;
        fs::create_dir(&dest)?;
        let result = (|| -> Result<()> {
            atomic_write(&dest.join(&manifest.spritesheet_path), &bytes)?;
            atomic_write(
                &dest.join("pet.json"),
                &serde_json::to_vec_pretty(&manifest)?,
            )?;
            library.preferences.selected_pet = Some(manifest.id.clone());
            library.pets.push(Entry {
                manifest,
                directory,
            });
            self.save(&library)
        })();
        if result.is_err() {
            let _ = fs::remove_dir_all(&dest);
        }
        result?;
        self.list()
    }
    pub fn image(&self, id: &str) -> Result<Value> {
        if id == "hassan" {
            return Ok(json!({"dataUrl": data_url(HASSAN, "spritesheet.webp")}));
        }
        if !valid_id(id) {
            bail!("PET_INVALID_ID");
        }
        let library = self.load()?;
        let entry = library
            .pets
            .iter()
            .find(|e| e.manifest.id == id)
            .context("PET_NOT_FOUND")?;
        let parent = self.root.join("imported").join(&entry.directory);
        let path = parent.join(&entry.manifest.spritesheet_path);
        let bytes = bounded_read(&path, MAX_IMAGE)?;
        let canonical_root = self.root.canonicalize()?;
        if !path.canonicalize()?.starts_with(&canonical_root) {
            bail!("PET_INVALID_PATH");
        }
        image::validate(
            &bytes,
            entry.manifest.sprite_version_number,
            &entry.manifest.spritesheet_path,
        )?;
        Ok(json!({"dataUrl": data_url(&bytes, &entry.manifest.spritesheet_path)}))
    }
}
fn data_url(bytes: &[u8], filename: &str) -> String {
    let mime = if filename.ends_with(".png") {
        "image/png"
    } else {
        "image/webp"
    };
    format!("data:{mime};base64,{}", STANDARD.encode(bytes))
}
