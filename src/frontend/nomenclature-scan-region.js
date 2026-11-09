// The preview uses object-fit: cover and object-position: center. Map the
// visible inner frame from CSS pixels to the original camera pixels.
export function getVideoScanRegion(sourceWidth, sourceHeight, videoRect, frameRect) {
  const values = [sourceWidth, sourceHeight, videoRect.left, videoRect.top, videoRect.width,
    videoRect.height, frameRect.left, frameRect.top, frameRect.width, frameRect.height];
  if (values.some((value) => !Number.isFinite(value)) || sourceWidth <= 0 || sourceHeight <= 0
    || videoRect.width <= 0 || videoRect.height <= 0 || frameRect.width <= 0 || frameRect.height <= 0) return null;

  const left = Math.max(videoRect.left, frameRect.left);
  const top = Math.max(videoRect.top, frameRect.top);
  const right = Math.min(videoRect.left + videoRect.width, frameRect.left + frameRect.width);
  const bottom = Math.min(videoRect.top + videoRect.height, frameRect.top + frameRect.height);
  if (right <= left || bottom <= top) return null;

  const scale = Math.max(videoRect.width / sourceWidth, videoRect.height / sourceHeight);
  const offsetX = (sourceWidth * scale - videoRect.width) / 2;
  const offsetY = (sourceHeight * scale - videoRect.height) / 2;
  // Round inward so no pixel outside the visible frame reaches the decoder.
  const x = Math.max(0, Math.ceil((left - videoRect.left + offsetX) / scale));
  const y = Math.max(0, Math.ceil((top - videoRect.top + offsetY) / scale));
  const endX = Math.min(sourceWidth, Math.floor((right - videoRect.left + offsetX) / scale));
  const endY = Math.min(sourceHeight, Math.floor((bottom - videoRect.top + offsetY) / scale));
  return endX > x && endY > y ? { x, y, width: endX - x, height: endY - y } : null;
}
