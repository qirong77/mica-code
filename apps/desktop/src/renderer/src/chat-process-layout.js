export function turnLogVisible({ roundCount, running, interrupted }) {
  return Boolean(running || (interrupted && roundCount > 0))
}
