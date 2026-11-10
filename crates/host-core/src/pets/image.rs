//! Bounded container/dimension checks before any image reaches the native decoder.
//! Electron additionally decodes preview bytes before issuing an import token.
use anyhow::{bail, Context, Result};

fn le24(data: &[u8]) -> u32 {
    u32::from(data[0]) | u32::from(data[1]) << 8 | u32::from(data[2]) << 16
}
fn le32(data: &[u8]) -> Result<u32> {
    Ok(u32::from_le_bytes(
        data.try_into().context("PET_INVALID_IMAGE")?,
    ))
}
fn be32(data: &[u8]) -> Result<u32> {
    Ok(u32::from_be_bytes(
        data.try_into().context("PET_INVALID_IMAGE")?,
    ))
}

pub(super) fn validate(data: &[u8], version: u8, name: &str) -> Result<()> {
    if data.len() > super::MAX_IMAGE as usize {
        bail!("PET_IMAGE_TOO_LARGE");
    }
    let (width, height) = if name.ends_with(".png") {
        if data.len() < 45
            || &data[..8] != b"\x89PNG\r\n\x1a\n"
            || &data[12..16] != b"IHDR"
            || be32(&data[8..12])? != 13
        {
            bail!("PET_INVALID_IMAGE");
        }
        // Require an alpha-bearing PNG; reject opaque screenshots and animated PNG.
        if !matches!(data[25], 4 | 6) {
            bail!("PET_IMAGE_NEEDS_ALPHA");
        }
        let mut offset = 8;
        let mut has_data = false;
        let mut end = false;
        while offset + 12 <= data.len() {
            let size = be32(&data[offset..offset + 4])? as usize;
            let next = offset.checked_add(size + 12).context("PET_INVALID_IMAGE")?;
            if next > data.len() {
                bail!("PET_TRUNCATED_IMAGE");
            }
            let kind = &data[offset + 4..offset + 8];
            if kind == b"acTL" {
                bail!("PET_ANIMATED_ATLAS");
            }
            if kind == b"IDAT" {
                has_data = true;
            }
            if kind == b"IEND" {
                end = true;
                break;
            }
            offset = next;
        }
        if !has_data || !end {
            bail!("PET_TRUNCATED_IMAGE");
        }
        (be32(&data[16..20])?, be32(&data[20..24])?)
    } else {
        if data.len() < 30
            || &data[..4] != b"RIFF"
            || &data[8..12] != b"WEBP"
            || le32(&data[4..8])? as usize + 8 != data.len()
        {
            bail!("PET_INVALID_IMAGE");
        }
        let mut offset = 12;
        let mut dimensions = None;
        let mut pixel_data = false;
        let mut alpha = false;
        while offset + 8 <= data.len() {
            let kind = &data[offset..offset + 4];
            let size = le32(&data[offset + 4..offset + 8])? as usize;
            let start = offset + 8;
            let end = start.checked_add(size).context("PET_INVALID_IMAGE")?;
            if end > data.len() {
                bail!("PET_TRUNCATED_IMAGE");
            }
            let chunk = &data[start..end];
            if kind == b"ANIM" || kind == b"ANMF" {
                bail!("PET_ANIMATED_ATLAS");
            }
            if kind == b"VP8X" && chunk.len() >= 10 {
                if chunk[0] & 2 != 0 {
                    bail!("PET_ANIMATED_ATLAS");
                }
                alpha |= chunk[0] & 16 != 0;
                dimensions = Some((le24(&chunk[4..7]) + 1, le24(&chunk[7..10]) + 1));
            } else if kind == b"VP8L" && chunk.len() >= 5 && chunk[0] == 0x2f {
                let bits = le32(&chunk[1..5])?;
                alpha |= bits & (1 << 28) != 0;
                dimensions.get_or_insert(((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1));
                pixel_data = true;
            } else if kind == b"VP8 " && chunk.len() >= 10 && &chunk[3..6] == b"\x9d\x01\x2a" {
                let w = u16::from_le_bytes([chunk[6], chunk[7]]) & 0x3fff;
                let h = u16::from_le_bytes([chunk[8], chunk[9]]) & 0x3fff;
                dimensions.get_or_insert((u32::from(w), u32::from(h)));
                pixel_data = true;
            } else if kind == b"ALPH" {
                alpha = true;
            }
            offset = end + size % 2;
        }
        if !alpha || !pixel_data || offset != data.len() {
            bail!("PET_INVALID_IMAGE");
        }
        dimensions.context("PET_INVALID_IMAGE")?
    };
    let expected_height = if version == 2 { 2288 } else { 1872 };
    if width != 1536 || height != expected_height {
        bail!("PET_INVALID_DIMENSIONS: expected 1536x{expected_height}");
    }
    Ok(())
}
