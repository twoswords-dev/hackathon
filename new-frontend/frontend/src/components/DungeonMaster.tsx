import { useEffect, useRef, useState } from "react";
import { useRive, Layout, Fit, Alignment } from "@rive-app/react-canvas";
import StepPanel from "./StepPanel";
import type { GameStepInfo } from "../api/gameApi";
import "./DungeonMaster.css";

interface DungeonMasterProps {
  isSpeaking: boolean;
  speechText: string;
  audioUrl?: string | null;
  onSpeechComplete: () => void;
  step: GameStepInfo | null;
  isMyTurn: boolean;
  connected: boolean;
}

const CHAR_DELAY_MS = 55;
// Narratives and the opening adventure summary can run several hundred
// characters. Reveal more than one character per tick when needed so a long
// passage still finishes within this budget instead of being cut off by the
// next event.
const MAX_REVEAL_MS = 6000;

export default function DungeonMaster({
  isSpeaking,
  speechText,
  audioUrl,
  onSpeechComplete,
  step,
  isMyTurn,
  connected,
}: DungeonMasterProps) {
  const [revealed, setRevealed] = useState("");
  const [driftX, setDriftX] = useState(0);
  const [driftY, setDriftY] = useState(0);
  // Browsers block autoplay until the page has been interacted with. When that
  // happens we surface a button rather than silently dropping the narration.
  const [audioBlocked, setAudioBlocked] = useState(false);
  // Clip length, used to pace the text reveal against the actual narration.
  const [audioDurationMs, setAudioDurationMs] = useState<number | null>(null);

  const intervalRef = useRef<number | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const { rive, RiveComponent } = useRive({
    src: "/wizard.riv",
    autoplay: true,
    stateMachines: "State Machine 1",
    layout: new Layout({
      fit: Fit.Cover,
      alignment: Alignment.Center,
    }),
  });

  // Debug Rive
  useEffect(() => {
    if (!rive) return;
    console.log("Rive loaded");
    console.log("Animations:", rive.animationNames);
    console.log("State Machines:", rive.stateMachineNames);
  }, [rive]);

  // Narration playback. Each new clip replaces the previous one so a fresh
  // event never overlaps the tail of the last.
  useEffect(() => {
    // Tear down any clip still playing from the previous narrative.
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = "";
      audioRef.current = null;
    }
    setAudioDurationMs(null);
    setAudioBlocked(false);

    if (!audioUrl) return;

    const audio = new Audio(audioUrl);
    audio.preload = "auto";
    audioRef.current = audio;

    const onMeta = () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        setAudioDurationMs(audio.duration * 1000);
      }
    };
    audio.addEventListener("loadedmetadata", onMeta);

    audio.play().catch(() => {
      // Autoplay policy rejected playback; offer a manual control instead.
      setAudioBlocked(true);
    });

    return () => {
      audio.removeEventListener("loadedmetadata", onMeta);
      audio.pause();
    };
  }, [audioUrl]);

  const handleEnableAudio = () => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.play()
      .then(() => setAudioBlocked(false))
      .catch(() => setAudioBlocked(true));
  };

  // Speech typing
  useEffect(() => {
    if (!isSpeaking || !speechText) {
      setRevealed("");
      return;
    }

    setRevealed("");
    let i = 0;

    // Pace the reveal to the narration when we know how long it runs, so text
    // and voice finish together; otherwise fall back to the fixed budget.
    const budgetMs = audioDurationMs ?? MAX_REVEAL_MS;
    const maxTicks = Math.max(1, Math.floor(budgetMs / CHAR_DELAY_MS));
    const step = Math.max(1, Math.ceil(speechText.length / maxTicks));

    intervalRef.current = window.setInterval(() => {
      i += step;
      setRevealed(speechText.slice(0, i));

      if (i >= speechText.length) {
        if (intervalRef.current) {
          clearInterval(intervalRef.current);
        }
        onSpeechComplete();
      }
    }, CHAR_DELAY_MS);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [isSpeaking, speechText, onSpeechComplete, audioDurationMs]);

  // Floating effect
  useEffect(() => {
    if (!isSpeaking) {
      setDriftX(0);
      setDriftY(0);
      return;
    }

    const id = window.setInterval(() => {
      setDriftX((Math.random() - 0.5) * 30);
      setDriftY((Math.random() - 0.5) * 15);
    }, 650);

    return () => clearInterval(id);
  }, [isSpeaking]);

  return (
    <section className="dm-stage">
      <div className="dm-stage__glow" data-active={isSpeaking} />

      {/* Structured current-step panel (replaces the old free-text box) */}
      <StepPanel step={step} isMyTurn={isMyTurn} connected={connected} />

      {/* WIZARD CONTAINER */}
      <div
        className="dm-figure"
        style={{
          transform: `translate(${driftX}px, ${driftY}px)`,
        }}
      >
        <RiveComponent className="rive-canvas" />
      </div>

      {/* SPEECH BUBBLE */}
      {(isSpeaking || revealed) && (
        <div className="dm-speech">
          <p>{revealed}</p>
          {audioBlocked && (
            <button
              type="button"
              className="dm-speech__audio-enable"
              onClick={handleEnableAudio}
            >
              🔊 Enable narration
            </button>
          )}
        </div>
      )}
    </section>
  );
}