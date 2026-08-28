import Logo from './Logo'

interface Props {
  // Set once the engine is ready and the fade-out has started — kept mounted for the duration
  // of the transition instead of unmounting instantly, so the fade actually has something to
  // animate rather than just vanishing. The same moment also triggers the default→school-color
  // logo crossfade, so the splash settles into whatever the app's own header logo will already
  // be showing underneath by the time it's fully faded out.
  fadingOut: boolean
  school: string | null
}

export default function SplashScreen({ fadingOut, school }: Props) {
  return (
    <div className={`splash ${fadingOut ? 'splash--fading' : ''}`}>
      <div className="splash__logo-stage">
        {/* 264px — same size as the home hero logo (HomeView.tsx) — so the fade-out reads as
            the same mark settling into place rather than two differently-sized logos. */}
        <Logo size={264} className="splash__logo splash__logo--default" />
        {school && <Logo size={264} school={school} className="splash__logo splash__logo--school" />}
      </div>
    </div>
  )
}
