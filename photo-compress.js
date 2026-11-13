const maxEdge = 1600;
const targetBytes = 250 * 1024;
const maxBytes = 350 * 1024;

async function decodePhoto(file) {
  const url = URL.createObjectURL(file);
  const image = new Image();
  try {
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = reject;
      image.src = url;
    });
    return { source: image, width: image.naturalWidth, height: image.naturalHeight,
      release: () => URL.revokeObjectURL(url) };
  } catch {
    URL.revokeObjectURL(url);
    if (typeof createImageBitmap === 'function') {
      try {
        const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
        return { source: bitmap, width: bitmap.width, height: bitmap.height,
          release: () => bitmap.close() };
      } catch { /* Both decoders have now tried the original file. */ }
    }
    throw new Error('这张照片无法读取，请换一张，或选用 JPEG、PNG 格式。');
  }
}

function encodeJpeg(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (blob?.size && blob.type === 'image/jpeg') resolve(blob);
      else reject(new Error('照片压缩失败，请重新选择。'));
    }, 'image/jpeg', quality);
  });
}

export async function compressPhoto(file) {
  if (!file?.size) throw new Error('照片文件为空，请重新选择。');
  const image = await decodePhoto(file);
  const canvas = document.createElement('canvas');
  try {
    const context = canvas.getContext('2d', { alpha: false, colorSpace: 'srgb' });
    if (!context || !image.width || !image.height) throw new Error('无法处理这张照片，请重新选择。');

    const originalEdge = Math.max(image.width, image.height);
    let edge = Math.min(maxEdge, originalEdge);
    while (edge >= 1) {
      const width = Math.max(1, Math.round(image.width * edge / originalEdge));
      const height = Math.max(1, Math.round(image.height * edge / originalEdge));
      canvas.width = width;
      canvas.height = height;
      context.imageSmoothingQuality = 'high';
      context.fillStyle = '#fff';
      context.fillRect(0, 0, width, height);
      context.drawImage(image.source, 0, 0, width, height);

      let blob = await encodeJpeg(canvas, 0.84);
      if (blob.size <= Math.min(targetBytes, file.size)) return { blob, width, height };
      const compact = await encodeJpeg(canvas, 0.76);
      if (compact.size < blob.size) blob = compact;
      if (blob.size <= maxBytes) return { blob, width, height };

      // Keep texture legible by reducing dimensions before lowering quality further.
      edge = Math.floor(edge * Math.min(0.9, Math.sqrt(targetBytes / blob.size)));
    }
    throw new Error('无法将这张照片压缩到大小上限内，请重新选择。');
  } finally {
    image.release();
    canvas.width = canvas.height = 1;
  }
}
