export interface ChartZoomRange {
  start: number
  end: number
}

export interface DataZoomValueWindow {
  startValue: number
  endValue: number
}

/**
 * Keep the current dataZoom width and move the clicked category to its right edge.
 * The window is expressed as category indexes for an exact end position.
 */
export function zoomWindowEndingAt(
  index: number,
  total: number,
  zoom: ChartZoomRange,
): DataZoomValueWindow | null {
  if (!Number.isInteger(index) || !Number.isInteger(total) || total <= 0 || index < 0 || index >= total) {
    return null
  }

  const span = Number.isFinite(zoom.start) && Number.isFinite(zoom.end)
    ? Math.max(0, Math.min(100, zoom.end - zoom.start))
    : 100
  const visibleCount = Math.max(1, Math.min(total, Math.round(total * span / 100)))
  return {
    startValue: Math.max(0, index - visibleCount + 1),
    endValue: index,
  }
}
