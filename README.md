# Gen DND - AI-Powered Multiplayer D&D Game Engine

A web-hosted, multiplayer D&D game engine where each step of the game loop is handled by a specialized AI agent powered by Amazon Bedrock.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Browser (React UI)                     │
└───────────────────────────┬─────────────────────────────┘
                            │ HTTP / SSE
┌───────────────────────────▼─────────────────────────────┐
│                    Nginx (Reverse Proxy)                  │
├─────────────┬──────────────────┬────────────────────────┤
│  /  →       │  /api/ →         │  /dice/ →              │
│  Frontend   │  Backend API     │  Dice Agent            │
│  (React)    │  (Express/TS)    │  (FastAPI/OpenCV)      │
└─────────────┴────────┬─────────┴────────────────────────┘
                       │
         ┌─────────────┼──────────────┐
         │             │              │
    ┌────▼────┐  ┌─────▼────┐  ┌─────▼────┐
    │ Bedrock │  │ DynamoDB │  │  Titan   │
    │ Agents  │  │  (State) │  │  Image   │
    └─────────┘  └──────────┘  └──────────┘
```

## Services

| Service | Port | Description |
|---------|------|-------------|
| Nginx | 80/443 | Reverse proxy, SSL termination |
| Frontend | 3000 (internal) | React + Vite SPA |
| Backend | 4000 (internal) | Express API + SSE events |
| Dice Agent | 5000 (internal) | OpenCV dice reader + virtual fallback |
| DynamoDB Local | 8000 | Local dev database |

## Quick Start

### Prerequisites
- Docker & Docker Compose
- AWS account with Bedrock access (for AI features)

### Development

```bash
# Clone and enter project
cd /gen-dnd

# Copy environment file
cp .env.example .env
# Edit .env with your AWS credentials

# Build and start all services
docker-compose up --build

# Access the app
open http://localhost
```

### Endpoints

- **Frontend**: http://localhost
- **Backend Health**: http://localhost/api/health
- **Dice Agent Status**: http://localhost/dice/status
- **DynamoDB Local**: http://localhost:8000

## Project Structure

```
/gen-dnd
├── frontend/          # React + Vite + TypeScript
│   ├── src/
│   ├── Dockerfile
│   └── package.json
├── backend/           # Express + TypeScript
│   ├── src/
│   ├── Dockerfile
│   └── package.json
├── dice-agent/        # Python + FastAPI + OpenCV
│   ├── main.py
│   ├── Dockerfile
│   └── requirements.txt
├── docker/            # Docker configs
│   └── nginx/
│       └── nginx.conf
├── infra/             # AWS infrastructure (CloudFormation, scripts)
├── assets/            # Static assets and generated images
│   └── defaults/      # Fallback images
├── docker-compose.yml
├── .env.example
├── PLAN.md            # Full implementation plan
└── README.md
```

## Game Flow

1. **Create Game** — Choose source material (movie/show/book/custom) + game length
2. **Lore Generation** — AI generates world, characters, event outlines, map
3. **Lobby** — Players join, pick characters, view campaign map
4. **Game Loop**:
   - DM Agent narrates event context
   - Requests dice roll from active player
   - Player rolls physical dice (or uses virtual fallback)
   - OpenCV agent reads result → JSON
   - State Updater agent applies outcome to stats/map
   - Next turn
5. **Game Over** — Final summary when all events complete

## Tech Stack

- **Frontend**: React, Vite, TypeScript, React Router, TanStack Query
- **Backend**: Node.js, Express, TypeScript
- **Dice Agent**: Python, FastAPI, OpenCV
- **AI**: Amazon Bedrock (Claude for narrative, Titan for images)
- **Database**: Amazon DynamoDB
- **Real-time**: Server-Sent Events (SSE)
- **Deployment**: Docker Compose, Nginx, Route 53

## Development Commands

```bash
# Start all services
docker-compose up --build

# Start specific service
docker-compose up backend

# View logs
docker-compose logs -f backend

# Stop all
docker-compose down

# Reset database
docker-compose down -v
```
