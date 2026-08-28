const SCRAMBLE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

/** Animates text from `from` to `to` — a "decode" transition where each character flickers
 *  through random glyphs before locking in, revealing left-to-right over the run. `onFrame` is
 *  called every animation frame with the in-progress string and overall progress (0-1, handy
 *  for driving something else, like a crossfade opacity, off the same clock); `onDone` fires
 *  once with the final `to` string. Returns a cancel function (call on unmount). */
export function scrambleTransition(
  from: string,
  to: string,
  durationMs: number,
  onFrame: (text: string, progress: number) => void,
  onDone: () => void
): () => void {
  const length = Math.max(from.length, to.length)
  const start = performance.now()
  let frameId = 0
  let cancelled = false

  function step(now: number): void {
    if (cancelled) return
    const t = Math.min(1, (now - start) / durationMs)

    let result = ''
    for (let i = 0; i < length; i++) {
      // Staggered left-to-right reveal, each character spending a slice of the run scrambling
      // before it locks — reaching t=1 well before the overall animation ends so the tail end
      // reads as settled rather than still flickering.
      const revealAt = (i / length) * 0.7
      if (t >= revealAt + 0.2) {
        result += to[i] ?? ''
      } else if (t >= revealAt) {
        result += SCRAMBLE_CHARS[Math.floor(Math.random() * SCRAMBLE_CHARS.length)]
      } else {
        result += from[i] ?? to[i] ?? ''
      }
    }

    onFrame(result, t)

    if (t < 1) {
      frameId = requestAnimationFrame(step)
    } else {
      onFrame(to, 1)
      onDone()
    }
  }

  frameId = requestAnimationFrame(step)
  return () => {
    cancelled = true
    cancelAnimationFrame(frameId)
  }
}
