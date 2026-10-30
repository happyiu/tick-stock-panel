from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from enum import StrEnum

from pydantic import BaseModel, ConfigDict

from app.services.wave_core.domain import Interval


class PivotType(StrEnum):
    HIGH = "high"
    LOW = "low"


class PivotState(StrEnum):
    CONFIRMED = "confirmed"
    TENTATIVE = "tentative"


class PivotEvent(BaseModel):
    model_config = ConfigDict(frozen=True)

    interval: Interval
    degree: int
    timestamp: datetime
    price: Decimal
    type: PivotType
    state: PivotState
    confirmed_at: datetime | None = None
