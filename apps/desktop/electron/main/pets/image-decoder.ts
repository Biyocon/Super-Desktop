import { BrowserWindow, nativeImage, session } from "electron";
import { randomUUID } from "node:crypto";
import { petAtlasSize, type PetVersion } from "@pi-desktop/shared";

/** nativeImage on Windows cannot read WebP. Chromium decodes it in an ephemeral, unprivileged renderer. */
export async function decodePetImage(dataUrl: string, version: PetVersion) {
  const expected = petAtlasSize(version);
  if (!/^data:image\/(png|webp);base64,/.test(dataUrl) || dataUrl.length > 11_000_000) throw new Error("PET_INVALID_IMAGE");
  const direct = nativeImage.createFromDataURL(dataUrl);
  if (!direct.isEmpty()) return direct;
  const isolated = session.fromPartition(`pet-decode-${randomUUID()}`);
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolated.setPermissionCheckHandler(() => false);
  isolated.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith("data:") && details.url !== "about:blank" }));
  const decoder = new BrowserWindow({ show: false, width: 1, height: 1,
    webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  decoder.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  decoder.webContents.on("will-navigate", (event) => event.preventDefault());
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    const decode = (async () => {
      await decoder.loadURL("about:blank");
      const png: unknown = await decoder.webContents.executeJavaScript(`(async () => {
        const image = new Image();
        image.src = ${JSON.stringify(dataUrl)};
        await image.decode();
        if (image.naturalWidth !== ${expected.width} || image.naturalHeight !== ${expected.height}) throw new Error('PET_INVALID_IMAGE');
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('PET_INVALID_IMAGE');
        context.drawImage(image, 0, 0);
        return canvas.toDataURL('image/png');
      })()`);
      if (typeof png !== "string" || png.length > 20_000_000) throw new Error("PET_INVALID_IMAGE");
      return nativeImage.createFromDataURL(png);
    })();
    return await Promise.race([decode, new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error("PET_DECODE_TIMEOUT")), 15_000);
    })]);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (!decoder.isDestroyed()) decoder.destroy();
    isolated.webRequest.onBeforeRequest(null);
  }
}
