export function desktopPoint(
  rect: { left: number; top: number; width: number; height: number },
  clientX: number,
  clientY: number,
  viewport = { width: 1280, height: 800 },
) {
  if (rect.width <= 0 || rect.height <= 0) return null;
  return {
    x: Math.min(
      viewport.width - 1,
      Math.max(0, Math.floor(((clientX - rect.left) * viewport.width) / rect.width)),
    ),
    y: Math.min(
      viewport.height - 1,
      Math.max(0, Math.floor(((clientY - rect.top) * viewport.height) / rect.height)),
    ),
  };
}
