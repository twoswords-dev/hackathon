import { useEffect, useRef, useState } from "react";
import { useRive, Layout, Fit, Alignment } from "@rive-app/react-canvas";
import StepPanel from "./StepPanel";
import type { GameStepInfo } from "../api/gameApi";
import "./DungeonMaster.css";

interface DungeonMasterProps {
  isSpeaking: boolean;
  speechText: string;
  onSpeechComplete: () => void;
  nextStepText?: string;
  audioUrl?: string;
  step: GameStepInfo | null;
  isMyTurn: boolean;
  connected: boolean;
}

const CHAR_DELAY_MS = 55;

export default function DungeonMaster({
  isSpeaking,
  speechText,
  onSpeechComplete,
  nextStepText,
  audioUrl,
  step,
  isMyTurn,
  connected,
}: DungeonMasterProps) {
  const [revealed, setRevealed] = useState("");
  const [driftX, setDriftX] = useState(0);
  const [driftY, setDriftY] = useState(0);

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

  // Audio playback
  useEffect(() => {
    if (!isSpeaking || !audioUrl) {
      // Stop any playing audio when speech ends
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
      return;
    }

    const audio = new Audio(audioUrl);
    audioRef.current = audio;

    audio.play().catch((err) => {
      console.warn("[DungeonMaster] Audio playback failed:", err);
      // Graceful degradation — typewriter still works without audio
    });

    // Cleanup on unmount or when audioUrl changes
    return () => {
      audio.pause();
      audio.src = "";
      audioRef.current = null;
    };
  }, [isSpeaking, audioUrl]);

  // Speech typing
  useEffect(() => {
    if (!isSpeaking || !speechText) {
      setRevealed("");
      return;
    }

    setRevealed("");
    let i = 0;

    intervalRef.current = window.setInterval(() => {
      i++;
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
  }, [isSpeaking, speechText, onSpeechComplete]);

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
        </div>
      )}
    </section>
  );
}