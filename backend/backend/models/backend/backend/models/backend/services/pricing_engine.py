from decimal import Decimal
from backend.models.schemas import PriceCalculationRequest, PriceCalculationResponse
import hashlib


class PricingEngine:
    @staticmethod
    def calculate(req: PriceCalculationRequest) -> PriceCalculationResponse:
        base_labour = req.labour_hours * req.hourly_rate
        total_cost = (req.material_cost + base_labour + req.travel_cost) * req.difficulty_multiplier

        margin_factor = (Decimal("100") - req.target_margin_pct) / Decimal("100")
        recommended_price = total_cost / margin_factor

        if recommended_price > 0:
            actual_margin = ((recommended_price - total_cost) / recommended_price) * Decimal("100")
        else:
            actual_margin = Decimal("0")

        raw_hash_data = f"{total_cost}-{recommended_price}-{datetime.utcnow()}"
        signature_hash = hashlib.sha256(raw_hash_data.encode()).hexdigest()

        return PriceCalculationResponse(
            total_cost=total_cost.quantize(Decimal("0.01")),
            recommended_price=recommended_price.quantize(Decimal("0.01")),
            gross_margin_pct=actual_margin.quantize(Decimal("0.01")),
            binding_signature_hash=signature_hash
                            )
      
