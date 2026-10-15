export const mean = (values: (number | null)[], index: number, period: number): number | null => {
  if (index < period - 1) return null
  let sum = 0
  for (let j = index - period + 1; j <= index; j += 1) {
    if (values[j] === null) return null
    sum += values[j]!
  }
  return sum / period
}
export const extreme = (values: (number | null)[], index: number, period: number, high = false): number | null => {
  if (index < period - 1) return null
  let value = high ? -Infinity : Infinity
  for (let j = index - period + 1; j <= index; j += 1) {
    if (values[j] === null) return null
    value = high ? Math.max(value, values[j]!) : Math.min(value, values[j]!)
  }
  return value
}
export const smooth = (previous: number | null, value: number, weight: number) => previous === null ? value : previous + weight * (value - previous)
