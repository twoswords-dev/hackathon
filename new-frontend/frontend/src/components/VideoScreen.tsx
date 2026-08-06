import type { DiceRequestData, DiceResultData } from "../api/gameApi";
import "./VideoScreen.css";
import ContextPanel from "./ContextPanel";

interface VideoScreenProps {
  diceRequest?: DiceRequestData | null;
  lastRollValue?: number | null;
  onVirtualRoll?: () => void;
  pendingDiceType?: string | null;
  diceResult?: DiceResultData | null;
  diceSubmitted?: boolean;
  gameSteps?: string[];
}

export default function VideoScreen({
  diceRequest,
  lastRollValue,
  onVirtualRoll,
  diceResult,
  diceSubmitted,
  gameSteps = [],
}: VideoScreenProps) {

  const handleVirtualRoll = () => {
    if (!onVirtualRoll || diceSubmitted) return;
    onVirtualRoll();
  };

  const canRoll = !!onVirtualRoll && !diceSubmitted;

  return (
    <section className="video-screen">
      <header className="video-screen__header">
        <h2>🎲 Dice</h2>
      </header>

      <ContextPanel steps={gameSteps} />

      {/* Idle state — no request, no result */}
      {!diceRequest && !diceResult && (
        <div className="video-screen__idle">
          <div className="idle-dice-icon">🎲</div>
          <p>Waiting for the Dungeon Master...</p>
        </div>
      )}

      {/* Dice request - waiting for roll */}
      {diceRequest && !diceResult && (
        <div className="video-screen__request-display">
          <div className="request-dice-type">{diceRequest.diceType.toUpperCase()}</div>
          <p className="request-character">{diceRequest.characterName}</p>
          <p className="request-reason">{diceRequest.reason}</p>

          {canRoll && (
            <button
              className="roll-button"
              onClick={handleVirtualRoll}
              disabled={diceSubmitted}
            >
              🎲 Roll {diceRequest.diceType.toUpperCase()}
            </button>
          )}

          {diceSubmitted && !diceResult && (
            <div className="roll-submitted">
              <span className="roll-submitted-icon">⏳</span>
              <span>Rolling... {lastRollValue && `(${lastRollValue})`}</span>
            </div>
          )}

          {!canRoll && !diceSubmitted && (
            <p className="waiting-for-player">
              ⏳ Waiting for {diceRequest.targetPlayerName} to roll...
            </p>
          )}
        </div>
      )}

      {/* Dice result display */}
      {diceResult && (
        <div className={`video-screen__result-display ${getOutcomeClass(diceResult.outcome)}`}>
          <div className="result-dice-type">{diceResult.diceType.toUpperCase()}</div>
          <div className="result-big-number">{diceResult.rollValue}</div>
          <div className="result-max-value">out of {diceResult.maxValue}</div>
          <div className="result-outcome-text">{diceResult.outcome}</div>

          {diceResult.statChanges && diceResult.statChanges.length > 0 && (
            <div className="result-stat-changes">
              {diceResult.statChanges.map((sc, i) => (
                <span key={i} className={`result-stat-badge ${sc.delta > 0 ? 'stat-up' : 'stat-down'}`}>
                  {sc.stat.toUpperCase()} {sc.delta > 0 ? '+' : ''}{sc.delta}
                </span>
              ))}
            </div>
          )}

          {diceResult.isBossFight && diceResult.bossHp !== undefined && (
            <div className="result-boss-hp">
              👹 Boss HP: {diceResult.bossHp}/{diceResult.bossMaxHp}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function getOutcomeClass(outcome: string): string {
  if (outcome.includes('Critical success') || outcome.includes('⚡') || outcome.includes('Outstanding')) return 'outcome-crit';
  if (outcome.includes('Success') || outcome.includes('prevails') || outcome.includes('✅') || outcome.includes('strikes')) return 'outcome-success';
  if (outcome.includes('Partial') || outcome.includes('mixed') || outcome.includes('⚠️') || outcome.includes('weak')) return 'outcome-partial';
  if (outcome.includes('Critical failure') || outcome.includes('💀') || outcome.includes('disastrous')) return 'outcome-crit-fail';
  if (outcome.includes('Failure') || outcome.includes('not go as planned') || outcome.includes('❌') || outcome.includes('misses')) return 'outcome-fail';
  return '';
}
