import type { DiceRequestData, DiceResultData } from "../api/gameApi";
import { SUPPORTED_DICE } from "../api/gameApi";
import "./VideoScreen.css";
import ContextPanel from "./ContextPanel";

/** Face count per die, used to render the tray labels. */
const DIE_FACES: Record<string, number> = {
  d4: 4, d6: 6, d8: 8, d10: 10, d12: 12, d20: 20, d100: 100,
};

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
      <ContextPanel steps={gameSteps} />
      <header className="video-screen__header">
        <h2>🎲 Dice</h2>
      </header>

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

          {/* Full dice tray. Only the die the DM asked for is rollable — the
              others are shown so the available set is visible, but rolling a
              different die would not match the challenge's difficulty. */}
          <div className="dice-tray" role="group" aria-label="Available dice">
            {SUPPORTED_DICE.map((die) => {
              const isRequested = die === diceRequest.diceType.toLowerCase();
              const rollable = isRequested && canRoll;
              return (
                <button
                  key={die}
                  type="button"
                  className={`dice-chip${isRequested ? " dice-chip--requested" : ""}`}
                  onClick={rollable ? handleVirtualRoll : undefined}
                  disabled={!rollable}
                  aria-current={isRequested ? "true" : undefined}
                  title={
                    isRequested
                      ? `Roll ${die.toUpperCase()} (1-${DIE_FACES[die]})`
                      : `The Dungeon Master asked for ${diceRequest.diceType.toUpperCase()}, not ${die.toUpperCase()}`
                  }
                >
                  <span className="dice-chip__label">{die.toUpperCase()}</span>
                  <span className="dice-chip__faces">1-{DIE_FACES[die]}</span>
                </button>
              );
            })}
          </div>

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
