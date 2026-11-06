// This is a connection/activity indicator, not a simulated microphone waveform.
export default function CallStage({ state }: { state: string }) {
  return <div className="voice-stage" aria-label="动态通话画面" role="img" data-state={state}>
    <div className="voice-orbit voice-orbit-outer" aria-hidden="true" />
    <div className="voice-orbit voice-orbit-inner" aria-hidden="true" />
    <div className="voice-orb" aria-hidden="true">
      <div className="voice-orb-flow" /><div className="voice-orb-light" /><div className="voice-orb-glass" />
    </div>
  </div>
}
