import { BrowserRouter, Routes, Route, Link, useNavigate } from "react-router-dom";
import { useState } from "react";
import CreateGame from "./pages/CreateGame";
import Lobby from "./pages/Lobby";
import GameView from "./pages/GameView";
import "./App.css";

function Home() {
  const navigate = useNavigate();
  const [joinId, setJoinId] = useState("");

  const handleJoin = () => {
    const id = joinId.trim();
    if (id) navigate(`/lobby/${id}`);
  };

  return (
    <div className="home-page">
      <div className="home-hero">
        <h1 className="home-title">AI Dungeon Master</h1>
        <p className="home-subtitle">Crit Happens — An AI-powered tabletop adventure</p>

        <div className="home-actions">
          <Link to="/create" className="btn-primary btn-large">
            ✨ Create New Game
          </Link>

          <div className="home-join">
            <input
              type="text"
              placeholder="Enter session ID to join..."
              value={joinId}
              onChange={(e) => setJoinId(e.target.value)}
              className="form-input"
              onKeyDown={(e) => e.key === "Enter" && handleJoin()}
            />
            <button onClick={handleJoin} className="btn-secondary" disabled={!joinId.trim()}>
              Join Game
            </button>
          </div>
        </div>

        <div className="home-features">
          <div className="feature-card">
            <span className="feature-icon">🎲</span>
            <h3>Physical Dice</h3>
            <p>Roll real dice — CV detects your results</p>
          </div>
          <div className="feature-card">
            <span className="feature-icon">🗺️</span>
            <h3>AI-Generated Worlds</h3>
            <p>Every campaign is unique, powered by AI</p>
          </div>
          <div className="feature-card">
            <span className="feature-icon">🧙</span>
            <h3>AI Dungeon Master</h3>
            <p>Real-time narration and story progression</p>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/create" element={<CreateGame />} />
        <Route path="/lobby/:sessionId" element={<Lobby />} />
        <Route path="/game/:sessionId" element={<GameView />} />
      </Routes>
    </BrowserRouter>
  );
}
