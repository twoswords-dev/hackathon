from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from datetime import datetime
from typing import Optional
import random

app = FastAPI(title="Gen DND Dice Agent", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class DiceReadResponse(BaseModel):
    success: bool
    dice_type: Optional[str] = None
    roll_value: Optional[int] = None
    confidence: Optional[float] = None
    error: Optional[str] = None


class StatusResponse(BaseModel):
    status: str
    service: str
    timestamp: str
    version: str
    opencv_available: bool


@app.get("/status", response_model=StatusResponse)
async def status():
    """Health check endpoint."""
    opencv_available = False
    try:
        import cv2  # noqa: F401
        opencv_available = True
    except ImportError:
        pass

    return StatusResponse(
        status="ok",
        service="gen-dnd-dice-agent",
        timestamp=datetime.utcnow().isoformat(),
        version="1.0.0",
        opencv_available=opencv_available,
    )


@app.post("/read", response_model=DiceReadResponse)
async def read_dice(file: UploadFile = File(...)):
    """
    Read a dice roll from an uploaded image.
    Accepts an image file and returns the detected dice type and value.
    """
    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="File must be an image")

    # TODO: Implement actual OpenCV dice detection pipeline
    # For now, return a placeholder indicating the service is ready
    # but actual detection is not yet implemented
    return DiceReadResponse(
        success=False,
        error="OpenCV dice detection pipeline not yet implemented. Use /virtual endpoint.",
    )


class VirtualDiceRequest(BaseModel):
    dice_type: str  # d4, d6, d8, d10, d12, d20


class VirtualDiceResponse(BaseModel):
    success: bool
    dice_type: str
    roll_value: int


DICE_MAX = {
    "d4": 4,
    "d6": 6,
    "d8": 8,
    "d10": 10,
    "d12": 12,
    "d20": 20,
    "d100": 100,
}


@app.post("/virtual", response_model=VirtualDiceResponse)
async def virtual_dice(request: VirtualDiceRequest):
    """Virtual dice fallback - generates a random roll."""
    dice_type = request.dice_type.lower()
    if dice_type not in DICE_MAX:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid dice type: {dice_type}. Valid types: {list(DICE_MAX.keys())}",
        )

    max_value = DICE_MAX[dice_type]
    roll_value = random.randint(1, max_value)

    return VirtualDiceResponse(
        success=True,
        dice_type=dice_type,
        roll_value=roll_value,
    )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=5000)
