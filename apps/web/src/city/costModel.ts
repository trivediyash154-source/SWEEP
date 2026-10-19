/**
 * Operating-cost estimate for a coverage plan. Every number here is an input the
 * user supplies; nothing is measured. Outputs exist only for the inputs given:
 * no fuel rate → no fuel, cost or CO₂ figure; no wage → no labour cost.
 */

export interface CostAssumptions {
  /** Fuel use while servicing (L per 100 km). */
  fuelServiceLPer100km: number | null;
  /** Fuel use while driving between streets (L per 100 km). */
  fuelTransitLPer100km: number | null;
  /** Fuel price (₹ per L). */
  fuelPricePerL: number | null;
  /** Crew members per vehicle. */
  crewPerVehicle: number | null;
  /** Wage per crew member (₹ per hour). */
  wagePerHour: number | null;
  /** Tailpipe CO₂ per litre of fuel (kg). 2.68 kg/L is the commonly used combustion factor for diesel. */
  co2KgPerL: number;
}

export const DEFAULT_COSTS: CostAssumptions = {
  fuelServiceLPer100km: null,
  fuelTransitLPer100km: null,
  fuelPricePerL: null,
  crewPerVehicle: null,
  wagePerHour: null,
  co2KgPerL: 2.68,
};

export interface CostInput {
  serviceM: number;
  /** Deadhead and repeat traversals. */
  transitM: number;
  /** Sum of vehicle working seconds (not the makespan). */
  vehicleSeconds: number;
}

export interface CostEstimate {
  fuelL: number | null;
  fuelCost: number | null;
  labourCost: number | null;
  totalCost: number | null;
  co2Kg: number | null;
}

export function estimateCost(x: CostInput, a: CostAssumptions): CostEstimate {
  const fuelL = a.fuelServiceLPer100km !== null && a.fuelTransitLPer100km !== null ? (x.serviceM / 1000) * (a.fuelServiceLPer100km / 100) + (x.transitM / 1000) * (a.fuelTransitLPer100km / 100) : null;
  const fuelCost = fuelL !== null && a.fuelPricePerL !== null ? fuelL * a.fuelPricePerL : null;
  const labourCost = a.crewPerVehicle !== null && a.wagePerHour !== null ? (x.vehicleSeconds / 3600) * a.crewPerVehicle * a.wagePerHour : null;
  const totalCost = fuelCost !== null && labourCost !== null ? fuelCost + labourCost : null;
  const co2Kg = fuelL !== null ? fuelL * a.co2KgPerL : null;
  return { fuelL, fuelCost, labourCost, totalCost, co2Kg };
}
