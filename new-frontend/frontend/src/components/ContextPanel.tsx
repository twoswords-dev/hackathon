import { useState, useEffect } from "react";
import "./ContextPanel.css";

interface ContextPanelProps {
  steps: string[];
}

export default function ContextPanel({ steps }: ContextPanelProps) {
  const [page, setPage] = useState(0);

  // Automatically move to newest step
  useEffect(() => {
    if (steps.length > 0) {
      setPage(steps.length - 1);
    }
  }, [steps]);

  if (steps.length === 0) {
    return (
      <div className="context-panel">
        <h3>Dungeon Master Steps</h3>
        <div className="context-card">
          Awaiting Dungeon Master...
        </div>
      </div>
    );
  }

  return (
    <div className="context-panel">
      <h3>Dungeon Master Steps</h3>

      <div className="context-card">
        {steps[page]}
      </div>

      <div className="context-controls">
        <button
          disabled={page === 0}
          onClick={() => setPage(page - 1)}
        >
          ◀ Previous
        </button>

        <span>
          {page + 1}/{steps.length}
        </span>

        <button
          disabled={page === steps.length - 1}
          onClick={() => setPage(page + 1)}
        >
          Next ▶
        </button>
      </div>
    </div>
  );
}