import { BrowserRouter, Routes, Route, Link } from 'react-router-dom';
import CreateGame from './pages/CreateGame';
import Lobby from './pages/Lobby';
import GameView from './pages/GameView';

function Home() {
  return (
    <div className="app-container">
      <header className="app-header">
        <h1>⚔️ Gen DND</h1>
        <p>AI-Powered Multiplayer D&D Game Engine</p>
      </header>
      <main className="app-main">
        <div className="card">
          <h2>Welcome, Adventurer!</h2>
          <p>Create a new campaign from your favorite movie, TV show, or book — or bring your own world.</p>
          <div className="actions">
            <Link to="/create" className="btn btn-primary">Create New Game</Link>
            <button className="btn btn-secondary" onClick={() => {
              const id = prompt('Enter session ID:');
              if (id) window.location.href = `/lobby/${id}`;
            }}>Join Game</button>
          </div>
        </div>
        <div className="features">
          <div className="feature">
            <span className="feature-icon">🎲</span>
            <h3>Physical Dice</h3>
            <p>Roll real dice — our AI reads them via camera</p>
          </div>
          <div className="feature">
            <span className="feature-icon">🗺️</span>
            <h3>Generated Maps</h3>
            <p>AI-illustrated campaign and grid maps</p>
          </div>
          <div className="feature">
            <span className="feature-icon">🤖</span>
            <h3>AI Dungeon Master</h3>
            <p>Powered by Amazon Bedrock agents</p>
          </div>
        </div>
      </main>
    </div>
  );
}

function App() {
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

export default App;
