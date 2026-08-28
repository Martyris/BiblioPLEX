import { isSoundMuted } from './soundSettings'

// Tiny synthesized cues for the Playtest board — same approach as clickSound.ts (generated at
// play time via the Web Audio API, nothing to source/license), applied to the specific game
// actions a spectator most wants audible feedback for: a spell being cast, something entering
// the battlefield, drawing/discarding, dying/being exiled, taking damage, and gaining counters.
let ctx: AudioContext | null = null

function getCtx(): AudioContext {
  ctx ??= new AudioContext()
  if (ctx.state === 'suspended') ctx.resume()
  return ctx
}

function scheduleTone(startTime: number, startFreq: number, endFreq: number, duration: number, gainPeak = 0.12, type: OscillatorType = 'sine'): void {
  const audio = getCtx()
  const osc = audio.createOscillator()
  const gain = audio.createGain()
  osc.type = type
  osc.frequency.setValueAtTime(startFreq, startTime)
  osc.frequency.exponentialRampToValueAtTime(endFreq, startTime + duration)
  gain.gain.setValueAtTime(gainPeak, startTime)
  gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration * 1.5)

  osc.connect(gain)
  gain.connect(audio.destination)
  osc.start(startTime)
  osc.stop(startTime + duration * 1.6)
}

function safePlay(build: (now: number) => void): void {
  if (isSoundMuted()) return
  try {
    build(getCtx().currentTime)
  } catch {
    // Audio unavailable/blocked — the board keeps updating visually regardless.
  }
}

/** A spell resolving onto the stack — a rising two-part swoosh. */
export function playCastSound(): void {
  safePlay((now) => {
    scheduleTone(now, 240, 520, 0.11, 0.1)
  })
}

/** A permanent entering the battlefield — a soft, quick pop. */
export function playEtbSound(): void {
  safePlay((now) => {
    scheduleTone(now, 480, 520, 0.05, 0.08, 'triangle')
  })
}

/** Drawing a card — two very fast ticks, like a card flipping off the top of a deck. */
export function playDrawSound(): void {
  safePlay((now) => {
    scheduleTone(now, 700, 780, 0.03, 0.07, 'triangle')
    scheduleTone(now + 0.03, 900, 1000, 0.03, 0.06, 'triangle')
  })
}

/** Discarding a card — a short low thud. */
export function playDiscardSound(): void {
  safePlay((now) => {
    scheduleTone(now, 190, 90, 0.12, 0.11)
  })
}

/** A permanent going to the graveyard — a somber two-step descent. */
export function playGraveyardSound(): void {
  safePlay((now) => {
    scheduleTone(now, 400, 260, 0.14, 0.1)
    scheduleTone(now + 0.11, 260, 140, 0.16, 0.08)
  })
}

/** A permanent being exiled — a bright ascending shimmer, distinct from a graveyard's descent. */
export function playExileSound(): void {
  safePlay((now) => {
    scheduleTone(now, 700, 760, 0.05, 0.06, 'triangle')
    scheduleTone(now + 0.045, 950, 1010, 0.05, 0.06, 'triangle')
    scheduleTone(now + 0.09, 1300, 1380, 0.06, 0.06, 'triangle')
  })
}

/** Damage being dealt (to a creature or a player) — a sharp, brief impact. */
export function playDamageSound(): void {
  safePlay((now) => {
    scheduleTone(now, 220, 70, 0.07, 0.12, 'square')
  })
}

/** A permanent gaining counters — a single bright, bell-like ding. */
export function playCounterSound(): void {
  safePlay((now) => {
    scheduleTone(now, 820, 800, 0.22, 0.07)
  })
}

/** Flipping a card face-down/face-up — a quick down-then-up snap, like the flap of the card
 *  turning over. Distinct from the draw sound's two flat ticks. */
export function playFlipSound(): void {
  safePlay((now) => {
    scheduleTone(now, 900, 200, 0.05, 0.08, 'triangle')
    scheduleTone(now + 0.045, 300, 650, 0.04, 0.05, 'triangle')
  })
}

/** Shuffling the library — a dense flutter of quick, randomly-pitched ticks (same texture idea
 *  as clickSound.ts's playScrambleSound, tuned faster/shorter for a riffle rather than a
 *  "decoding" read). */
export function playShuffleSound(): void {
  safePlay((now) => {
    const tickCount = 14
    const tickInterval = 0.02
    for (let i = 0; i < tickCount; i++) {
      const freq = 260 + Math.random() * 340
      scheduleTone(now + i * tickInterval, freq, freq * 0.85, 0.025, 0.045, 'triangle')
    }
  })
}
