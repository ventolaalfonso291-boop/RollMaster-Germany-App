from datetime import datetime
from decimal import Decimal
from pydantic import BaseModel, Field


class Customer(BaseModel):
    id: str
    name: str
    phone: str | None = None
    email: str | None = None
    address: str | None = None
    country_edition: str = "DE"


class MeasurementRequest(BaseModel):
    job_id: str
    element: str  # es. Rollladen, Markise, Zanzariera
    width_mm: int = Field(ge=0)
    height_mm: int = Field(ge=0)
    motor_side: str | None = "left"
    notes: str | None = None


class JobCreate(BaseModel):
    customer_id: str
    category: str  # Rollladen, Markise, Jalousie, Zanzariere
    problem_description: str
    address: str
    technician_id: str | None = None
    estimated_hours: Decimal = Field(default=Decimal("1.0"), ge=0)
    workers_needed: int = Field(default=1, ge=1)
    requires_elevator: bool = False


class PriceCalculationRequest(BaseModel):
    material_cost: Decimal = Field(ge=0)
    labour_hours: Decimal = Field(ge=0)
    hourly_rate: Decimal = Field(ge=0)
    travel_cost: Decimal = Field(default=Decimal("0"), ge=0)
    difficulty_multiplier: Decimal = Field(default=Decimal("1.0"), ge=1.0)
    target_margin_pct: Decimal = Field(default=Decimal("30"), gt=0, lt=100)


class PriceCalculationResponse(BaseModel):
    total_cost: Decimal
    recommended_price: Decimal
    gross_margin_pct: Decimal
    binding_signature_hash: str | None = None
  
