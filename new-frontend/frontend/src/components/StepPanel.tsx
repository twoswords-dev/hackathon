import type { GameStepInfo } from '../api/gameApi';
import './StepPanel.css';

interface StepPanelProps {
  step: GameStepInfo | null;
  /** Set when the step is waiting on the local player specifically. */
  isMyTurn: boolean;
  connected: boolean;
}

const PHASE_LABELS: Record<GameStepInfo['phase'], string> = {
  idle: 'Waiting',
  narrating: 'Narrating',
  awaiting_roll: 'Awaiting Roll',
  resolving: 'Resolving',
  complete: 'Complete',
};

/**
 * Shows exactly what the game is waiting on right now: the phase, the event
 * position, whose turn it is, what roll is needed, and live enemy HP during a
 * fight. Driven by the backend's step_update events so it never goes stale.
 */
export default function StepPanel({ step, isMyTurn, connected }: StepPanelProps) {
  if (!step) {
    return (
      <div className="step-panel">
        <div className="step-panel__head">
          <h3 className="step-panel__title">Current Step</h3>
          <span className="step-badge step-badge--idle">Waiting</span>
        </div>
        <p className="step-panel__detail">
          {connected ? 'Waiting for the Dungeon Master to begin...' : 'Reconnecting to the table...'}
        </p>
      </div>
    );
  }

  const enemyPct =
    step.enemyHp !== undefined && step.enemyMaxHp
      ? Math.max(0, Math.min(100, (step.enemyHp / step.enemyMaxHp) * 100))
      : null;

  const encounterLabel =
    step.encounter === 'boss' ? '👹 Boss Fight' : step.encounter === 'combat' ? '⚔️ Combat' : null;

  return (
    <div className={`step-panel step-panel--${step.phase} ${isMyTurn ? 'step-panel--mine' : ''}`}>
      <div className="step-panel__head">
        <h3 className="step-panel__title">Current Step</h3>
        <div className="step-panel__badges">
          {encounterLabel && <span className="step-badge step-badge--encounter">{encounterLabel}</span>}
          <span className={`step-badge step-badge--${step.phase}`}>{PHASE_LABELS[step.phase]}</span>
          {step.totalEvents > 0 && (
            <span className="step-badge step-badge--count">
              Event {step.eventNumber}/{step.totalEvents}
            </span>
          )}
          {step.roundNumber !== undefined && (
            <span className="step-badge step-badge--count">Round {step.roundNumber}</span>
          )}
        </div>
      </div>

      <p className="step-panel__heading">{step.title}</p>
      <p className="step-panel__detail">{step.detail}</p>

      {/* Whose turn / what is needed */}
      {step.phase === 'awaiting_roll' && step.characterName && (
        <div className={`step-turn ${isMyTurn ? 'step-turn--mine' : ''}`}>
          <span className="step-turn__who">
            {isMyTurn ? '🎯 Your turn' : `⏳ ${step.activePlayerName ?? 'Another player'}`}
          </span>
          <span className="step-turn__char">
            {step.characterName}
            {step.characterClass ? ` · ${step.characterClass}` : ''}
          </span>
          {step.diceType && (
            <span className="step-turn__dice">needs {step.diceType.toUpperCase()}</span>
          )}
        </div>
      )}

      {/* Live enemy HP during a fight */}
      {enemyPct !== null && step.enemyName && (
        <div className="step-enemy">
          <div className="step-enemy__row">
            <span className="step-enemy__name">
              {step.encounter === 'boss' ? '👹' : '🗡️'} {step.enemyName}
            </span>
            <span className="step-enemy__hp">
              {step.enemyHp}/{step.enemyMaxHp} HP
            </span>
          </div>
          <div className="step-enemy__bar">
            <div className="step-enemy__fill" style={{ width: `${enemyPct}%` }} />
          </div>
        </div>
      )}

      {/* Most recent roll outcome */}
      {step.lastRoll && (
        <div className="step-last-roll">
          <span className="step-last-roll__label">Last roll</span>
          <span className="step-last-roll__value">
            {step.lastRoll.characterName} rolled {step.lastRoll.rollValue}/{step.lastRoll.maxValue}
          </span>
          <span className="step-last-roll__outcome">{step.lastRoll.outcome}</span>
        </div>
      )}
    </div>
  );
}
