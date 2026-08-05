import { useState, useRef, useEffect } from "react";
import {
  useRive,
  Layout,
  Fit,
  Alignment,
} from "@rive-app/react-canvas";
import type { DiceRequestData, DiceResultData } from "../api/gameApi";
import "./VideoScreen.css";

interface VideoScreenProps {
  diceRequest?: DiceRequestData | null;
  lastRollValue?: number | null;
  onDiceRoll?: (value: number) => void;
  onVirtualRoll?: () => void;
  pendingDiceType?: string | null;
  diceResult?: DiceResultData | null;
  diceSubmitted?: boolean;
}

export default function VideoScreen({
  diceRequest,
  lastRollValue,
  onDiceRoll,
  onVirtualRoll,
  pendingDiceType,
  diceResult,
  diceSubmitted,
}: VideoScreenProps) {
  const [cvConnected, setCvConnected] = useState(false);
  const [localRoll, setLocalRoll] = useState<number | null>(null);
  const [rolling, setRolling] = useState(false);
  const isRolling = useRef(false);

  const displayRoll = lastRollValue ?? localRoll;

  const { rive, RiveComponent } = useRive({
    src: "/dice.riv",
    autoplay: true,
    layout: new Layout({
      fit: Fit.Cover,
      alignment: Alignment.Center,
    }),
  });

  useEffect(() => {
    if (!rive) return;
    if (rive.animationNames.length > 0) {
      rive.play(rive.animationNames[0]);
    }
  }, [rive]);

  // Reset local roll when new dice request comes in
  useEffect(() => {
    if (diceRequest && !diceSubmitted) {
      setLocalRoll(null);
    }
  }, [diceRequest, diceSubmitted]);

  const triggerRoll = () => {
    if (!rive || isRolling.current || !onDiceRoll || diceSubmitted) return;
    isRolling.current = true;
    setRolling(true);
    setLocalRoll(null);

    // Restart animation
    rive.stop();
    if (rive.animationNames.length > 0) {
      rive.play(rive.animationNames[0]);
    }

    const maxDie = pendingDiceType
      ? parseInt(pendingDiceType.replace('d', ''))
      : 20;

    setTimeout(() => {
      const roll = Math.floor(Math.random() * maxDie) + 1;
      setLocalRoll(roll);
      setRolling(false);
      isRolling.current = false;
      onDiceRoll(roll);
    }, 3000);
  };

  const handleVirtualRoll = () => {
    if (!onVirtualRoll || diceSubmitted) return;
    setRolling(true);

    if (rive) {
      rive.stop();
      if (rive.animationNames.length > 0) {
        rive.play(rive.animationNames[0]);
      }
    }

    onVirtualRoll();
    setTimeout(() => setRolling(false), 3000);
  };

  const canRoll = !!onDiceRoll && !diceSubmitted;

  return (
    <section className="video-screen">
      <header className="video-screen__header">
        <h2>Dice Tracker</h2>
        <span className="video-screen__badge" data-live={cvConnected}>
          {cvConnected ? "CV ACTIVE" : "CV OFFLINE"}
        </span>
      </header>

      {/* Dice request info */}
      {diceRequest && !diceResult && (
        <div className="video-screen__request">
          <span className="dice-request-label">
            🎯 Roll {diceRequest.diceType.toUpperCase()}
          </span>
          <span className="dice-request-reason">{diceRequest.reason}</span>
        </div>
      )}

      {/* Dice result display */}
      {diceResult && (
        <div className={`video-screen__result ${getOutcomeClass(diceResult.outcome)}`}>
          <div className="result-roll">
            <span className="result-die">{diceResult.diceType.toUpperCase()}</span>
            <span className="result-value">{diceResult.rollValue}</span>
            <span className="result-max">/{diceResult.maxValue}</span>
          </div>
          <span className="result-outcome">{diceResult.outcome}</span>
          {diceResult.statChanges && diceResult.statChanges.length > 0 && (
            <div className="result-stats">
              {diceResult.statChanges.map((sc, i) => (
                <span key={i} className={`result-stat ${sc.delta > 0 ? 'stat-up' : 'stat-down'}`}>
                  {sc.stat.toUpperCase()} {sc.delta > 0 ? '+' : ''}{sc.delta}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="video-screen__feed" onClick={canRoll ? triggerRoll : undefined}>
        <RiveComponent className="rive-dice-canvas" />
        {rolling && (
          <div className="video-screen__rolling-overlay">
            <span>🎲 Rolling...</span>
          </div>
        )}
      </div>

      <div className="video-screen__controls">
        <button onClick={() => setCvConnected(!cvConnected)}>
          {cvConnected ? "Disconnect CV" : "Connect CV Script"}
        </button>

        {diceRequest && canRoll ? (
          <>
            <button
              className="video-screen__roll-btn"
              onClick={triggerRoll}
              disabled={rolling || diceSubmitted}
            >
              🎲 Roll {diceRequest.diceType.toUpperCase()}
            </button>
            <button
              className="video-screen__roll-btn"
              onClick={handleVirtualRoll}
              disabled={rolling || diceSubmitted}
            >
              🤖 Virtual Roll
            </button>
          </>
        ) : (
          <button
            className="video-screen__roll-btn"
            onClick={canRoll ? triggerRoll : undefined}
            disabled={!canRoll}
          >
            {diceSubmitted ? '✅ Roll Submitted' : 'Waiting...'}
          </button>
        )}
      </div>

      <div className="video-screen__readout">
        <span>{diceRequest ? `${diceRequest.diceType.toUpperCase()} Result` : 'Detected Roll'}</span>
        <strong>{displayRoll ?? "—"}</strong>
      </div>
    </section>
  );
}

function getOutcomeClass(outcome: string): string {
  if (outcome.includes('Critical success') || outcome.includes('⚡')) return 'outcome-crit';
  if (outcome.includes('Success') || outcome.includes('prevails') || outcome.includes('✅')) return 'outcome-success';
  if (outcome.includes('Partial') || outcome.includes('mixed') || outcome.includes('⚠️')) return 'outcome-partial';
  if (outcome.includes('Critical failure') || outcome.includes('💀')) return 'outcome-crit-fail';
  if (outcome.includes('Failure') || outcome.includes('not go as planned') || outcome.includes('❌')) return 'outcome-fail';
  return '';
}
