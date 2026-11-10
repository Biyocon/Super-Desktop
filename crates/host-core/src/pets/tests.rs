use super::*;
use tempfile::TempDir;

fn source(id: &str) -> (TempDir, PathBuf) {
    let source = tempfile::tempdir().unwrap();
    let mut pet = hassan();
    pet.id = id.into();
    pet.display_name = "Test companion".into();
    fs::write(
        source.path().join("pet.json"),
        serde_json::to_vec(&pet).unwrap(),
    )
    .unwrap();
    fs::write(source.path().join("spritesheet.webp"), HASSAN).unwrap();
    let manifest = source.path().join("pet.json");
    (source, manifest)
}
#[test]
fn defaults_do_not_create_storage_or_change_settings() {
    let data = tempfile::tempdir().unwrap();
    let library = PetLibrary::new(data.path());
    let result = library.list().unwrap();
    assert_eq!(result["preferences"]["selectedPet"], "hassan");
    assert_eq!(result["preferences"]["miniVisible"], false);
    assert_eq!(result["pets"].as_array().unwrap().len(), 1);
    assert!(!data.path().join("pets").exists());
    image::validate(HASSAN, 2, "spritesheet.webp").unwrap();
}
#[test]
fn import_select_none_and_restart_user_path() {
    let data = tempfile::tempdir().unwrap();
    let (source_dir, manifest) = source("new-pet");
    let library = PetLibrary::new(data.path());
    let before = fs::read(&manifest).unwrap();
    let preview = library.preview(&manifest).unwrap();
    assert!(
        !data.path().join("pets").exists(),
        "Preview must not install"
    );
    let result = library
        .import(&manifest, preview["fingerprint"].as_str().unwrap())
        .unwrap();
    assert_eq!(result["preferences"]["selectedPet"], "new-pet");
    assert_eq!(fs::read(&manifest).unwrap(), before);
    drop(source_dir);
    assert!(library.image("new-pet").unwrap()["dataUrl"]
        .as_str()
        .unwrap()
        .starts_with("data:image/webp;base64,"));
    library.update(json!({"selectedPet":null,"miniVisible":true,"scale":1.25,"position":{"x":-200,"y":50}})).unwrap();
    let restarted = PetLibrary::new(data.path()).list().unwrap();
    assert!(restarted["preferences"]["selectedPet"].is_null());
    assert_eq!(restarted["preferences"]["miniVisible"], true);
    assert_eq!(restarted["preferences"]["scale"], 1.25);
    assert_eq!(restarted["preferences"]["position"]["x"], -200);
    assert_eq!(restarted["pets"].as_array().unwrap().len(), 2);
}
#[test]
fn duplicate_or_builtin_import_never_overwrites() {
    let data = tempfile::tempdir().unwrap();
    let library = PetLibrary::new(data.path());
    let (_source, manifest) = source("new-pet");
    let preview = library.preview(&manifest).unwrap();
    let hash = preview["fingerprint"].as_str().unwrap();
    library.import(&manifest, hash).unwrap();
    assert!(library.import(&manifest, hash).is_err());
    assert!(library.preview(&manifest).is_err());
    let (_source, manifest) = source("hassan");
    assert!(library.preview(&manifest).is_err());
    assert_eq!(library.list().unwrap()["pets"].as_array().unwrap().len(), 2);
}
#[test]
fn changed_source_requires_a_new_preview() {
    let data = tempfile::tempdir().unwrap();
    let library = PetLibrary::new(data.path());
    let (_source, manifest) = source("new-pet");
    let preview = library.preview(&manifest).unwrap();
    let mut pet: Manifest = serde_json::from_slice(&fs::read(&manifest).unwrap()).unwrap();
    pet.description = "Changed after preview".into();
    fs::write(&manifest, serde_json::to_vec(&pet).unwrap()).unwrap();
    assert!(library
        .import(&manifest, preview["fingerprint"].as_str().unwrap())
        .unwrap_err()
        .to_string()
        .contains("SOURCE_CHANGED"));
    assert!(!data.path().join("pets").exists());
}
#[test]
fn invalid_paths_versions_and_images_are_rejected() {
    let data = tempfile::tempdir().unwrap();
    let library = PetLibrary::new(data.path());
    let (_source, manifest) = source("new-pet");
    let original = fs::read(&manifest).unwrap();
    for path in [
        "../spritesheet.webp",
        "C:/secret.png",
        "https://example.com/pet.png",
        "sub/spritesheet.webp",
    ] {
        let mut pet: Value = serde_json::from_slice(&original).unwrap();
        pet["spritesheetPath"] = json!(path);
        fs::write(&manifest, serde_json::to_vec(&pet).unwrap()).unwrap();
        assert!(library.preview(&manifest).is_err());
    }
    fs::write(&manifest, &original).unwrap();
    fs::write(
        manifest.parent().unwrap().join("spritesheet.webp"),
        b"not an image",
    )
    .unwrap();
    assert!(library.preview(&manifest).is_err());
    assert!(library.preview(Path::new("relative/pet.json")).is_err());
    assert!(image::validate(HASSAN, 1, "spritesheet.webp").is_err());
    assert!(image::validate(&HASSAN[..100], 2, "spritesheet.webp").is_err());
}
#[test]
fn invalid_preference_patch_preserves_selection() {
    let data = tempfile::tempdir().unwrap();
    let library = PetLibrary::new(data.path());
    library.update(json!({"selectedPet":null})).unwrap();
    for patch in [
        json!({"selectedPet":"missing"}),
        json!({"scale":10}),
        json!({"position":{"x":2000000,"y":0}}),
        json!({"unexpected":true}),
        json!({"miniVisible":"yes"}),
    ] {
        assert!(library.update(patch).is_err());
        assert!(library.list().unwrap()["preferences"]["selectedPet"].is_null());
    }
}
#[test]
fn corrupt_or_future_storage_is_not_silently_reset() {
    let data = tempfile::tempdir().unwrap();
    let library = PetLibrary::new(data.path());
    fs::create_dir_all(&library.root).unwrap();
    let file = library.root.join("library.json");
    for bytes in [
        b"broken".as_slice(),
        b"{\"version\":9,\"preferences\":{},\"pets\":[]}".as_slice(),
    ] {
        fs::write(&file, bytes).unwrap();
        assert!(library.list().is_err());
        assert_eq!(fs::read(&file).unwrap(), bytes);
    }
}
#[cfg(unix)]
#[test]
fn symlinked_images_are_rejected() {
    let data = tempfile::tempdir().unwrap();
    let library = PetLibrary::new(data.path());
    let (_source, manifest) = source("new-pet");
    let image = manifest.parent().unwrap().join("spritesheet.webp");
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("outside.webp"), HASSAN).unwrap();
    fs::remove_file(&image).unwrap();
    std::os::unix::fs::symlink(outside.path().join("outside.webp"), image).unwrap();
    assert!(library.preview(&manifest).is_err());
}
