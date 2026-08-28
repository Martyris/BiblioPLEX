import logo from '../assets/logo.png'
import { getSchool } from '../schools'

// The default mark and every school variant under assets/schools/ are square (800x800) —
// `size` sets width and height is left to the image's natural aspect ratio, so a square source
// renders as a square box with no forced letterboxing.
interface Props {
  size?: number
  className?: string
  style?: React.CSSProperties
  // A student's chosen school (see schools.ts) swaps in that school's two-tone variant of the
  // mark instead of the default teal/navy one. null/unset falls back to the default.
  school?: string | null
  onPointerDown?: (e: React.PointerEvent<HTMLImageElement>) => void
}

export default function Logo({ size = 40, className, style, school, onPointerDown }: Props) {
  const src = getSchool(school)?.logo ?? logo
  return (
    <img
      src={src}
      className={className}
      alt=""
      aria-hidden="true"
      style={{ width: size, height: 'auto', display: 'block', ...style }}
      // Plain <img> elements are natively draggable (the browser's own "drag this image out"
      // ghost) — that native drag swallows the pointerup that would otherwise end the pressed
      // state below, leaving the logo stuck looking pressed until a second click. Nothing here
      // wants that native drag at all, so it's turned off outright.
      draggable={false}
      onPointerDown={onPointerDown}
    />
  )
}
