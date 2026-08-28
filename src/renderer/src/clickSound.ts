import { isSoundMuted } from './soundSettings'

// Tiny synthesized UI cues — generated at play time via the Web Audio API rather than shipped
// as audio files, so there's nothing to source/license for a handful of one-off blips.
let ctx: AudioContext | null = null

function getCtx(): AudioContext {
  ctx ??= new AudioContext()
  if (ctx.state === 'suspended') ctx.resume()
  return ctx
}

function scheduleTone(startTime: number, startFreq: number, endFreq: number, duration: number): void {
  const audio = getCtx()
  const osc = audio.createOscillator()
  const gain = audio.createGain()
  osc.type = 'sine'
  osc.frequency.setValueAtTime(startFreq, startTime)
  osc.frequency.exponentialRampToValueAtTime(endFreq, startTime + duration)
  gain.gain.setValueAtTime(0.16, startTime)
  gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration * 1.5)

  osc.connect(gain)
  gain.connect(audio.destination)
  osc.start(startTime)
  osc.stop(startTime + duration * 1.6)
}

// A descending tone reads as a press-down; an ascending tone (its mirror) reads as the
// release, the same way a physical switch sounds different going each direction.
export function playPressSound(): void {
  if (isSoundMuted()) return
  try {
    scheduleTone(getCtx().currentTime, 320, 110, 0.09)
  } catch {
    // Audio unavailable/blocked — the visual press effect still plays on its own.
  }
}

export function playReleaseSound(): void {
  if (isSoundMuted()) return
  try {
    scheduleTone(getCtx().currentTime, 150, 420, 0.09)
  } catch {
    // Audio unavailable/blocked — the visual release effect still plays on its own.
  }
}

// Two short tones crossing in pitch (one rising, one falling, overlapping) — reads as two
// things trading places, distinct from the single-direction press/release glides. Used for an
// actual completed swap (deck reorder, card reorder, Hot Swap), not just letting go of a drag.
export function playSwapSound(): void {
  if (isSoundMuted()) return
  try {
    const now = getCtx().currentTime
    scheduleTone(now, 260, 480, 0.07)
    scheduleTone(now + 0.05, 480, 260, 0.08)
  } catch {
    // Audio unavailable/blocked — the visual swap still happens on its own.
  }
}

function scheduleTick(startTime: number, freq: number, duration: number): void {
  const audio = getCtx()
  const osc = audio.createOscillator()
  const gain = audio.createGain()
  osc.type = 'triangle'
  osc.frequency.setValueAtTime(freq, startTime)
  gain.gain.setValueAtTime(0.05, startTime)
  gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration)

  osc.connect(gain)
  gain.connect(audio.destination)
  osc.start(startTime)
  osc.stop(startTime + duration + 0.01)
}

// A stream of quick, randomly-pitched blips for the whole run of a scramble-text transition —
// a "decoding" texture rather than one clean directional tone, since it's covering a few
// hundred milliseconds of flickering characters, not a single instant. Scheduled all at once up
// front (Web Audio lets tones be queued ahead of time), not on a per-frame timer.
export function playScrambleSound(durationMs: number): void {
  if (isSoundMuted()) return
  try {
    const audio = getCtx()
    const start = audio.currentTime
    const tickInterval = 0.045
    const tickDuration = 0.03
    const tickCount = Math.floor(durationMs / 1000 / tickInterval)
    for (let i = 0; i < tickCount; i++) {
      const freq = 240 + Math.random() * 620
      scheduleTick(start + i * tickInterval, freq, tickDuration)
    }
  } catch {
    // Audio unavailable/blocked — the scramble-text effect still plays on its own.
  }
}

// Wires the press/release cue into every plain <button> in the app (menu triggers, tab
// buttons, filter chips, etc.) from one place, instead of hand-adding pointer handlers to each
// button across every component. The release listener is (re)attached fresh on window on each
// press, same trick as the Home logo's own press/hold handling, so it always fires exactly once
// per press regardless of where the pointer ends up (dragged off, released elsewhere, etc).
// Draggable buttons (e.g. deck tiles) still only get this single press — drag-and-drop
// reordering plays its own dedicated swap sound instead of a second, redundant press/release
// pair (see DecksBrowser.tsx / DeckBuilder.tsx).
export function attachGlobalButtonSounds(): () => void {
  function handlePointerDown(e: PointerEvent): void {
    const target = e.target
    if (!(target instanceof Element)) return
    if (!target.closest('button:not(:disabled)')) return

    playPressSound()
    const handleRelease = (): void => {
      playReleaseSound()
      window.removeEventListener('pointerup', handleRelease)
    }
    window.addEventListener('pointerup', handleRelease)
  }

  document.addEventListener('pointerdown', handlePointerDown)
  return () => document.removeEventListener('pointerdown', handlePointerDown)
}
