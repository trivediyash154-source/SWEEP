import { describe, expect, it } from 'vitest';
import { DEFAULT_COSTS, estimateCost } from './costModel';

const plan = { serviceM: 12_000, transitM: 3_000, vehicleSeconds: 2 * 3600 };

describe('cost model', () => {
  it('reports nothing it has no inputs for', () => {
    expect(estimateCost(plan, DEFAULT_COSTS)).toEqual({ fuelL: null, fuelCost: null, labourCost: null, totalCost: null, co2Kg: null });
  });

  it('computes fuel, cost, labour and CO₂ from the given assumptions only', () => {
    const e = estimateCost(plan, { fuelServiceLPer100km: 40, fuelTransitLPer100km: 25, fuelPricePerL: 90, crewPerVehicle: 2, wagePerHour: 150, co2KgPerL: 2.68 });
    // 12 km × 0.40 L/km + 3 km × 0.25 L/km = 4.8 + 0.75 = 5.55 L
    expect(e.fuelL).toBeCloseTo(5.55, 12);
    expect(e.fuelCost).toBeCloseTo(499.5, 9);
    // 2 vehicle-hours × 2 crew × ₹150
    expect(e.labourCost).toBeCloseTo(600, 12);
    expect(e.totalCost).toBeCloseTo(1099.5, 9);
    expect(e.co2Kg).toBeCloseTo(5.55 * 2.68, 12);
  });

  it('gives CO₂ without a price, and labour without fuel', () => {
    const e = estimateCost(plan, { ...DEFAULT_COSTS, fuelServiceLPer100km: 40, fuelTransitLPer100km: 25, crewPerVehicle: 1, wagePerHour: 100 });
    expect(e.co2Kg).not.toBeNull();
    expect(e.fuelCost).toBeNull();
    expect(e.labourCost).toBeCloseTo(200, 12);
    expect(e.totalCost).toBeNull();
  });
});
