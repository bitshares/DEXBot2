'use strict';
/**
 * Tests for position_health.ts
 *
 * Validates the 3-zone CR classification and two-layer action system.
 */

const assert = require('assert');
const {
  CR_ZONES,
  classifyCrZone,
  checkTrendAlignment,
  assessPosition,
  classifyPriceRangeRatio,
  computePriceRangeRatioPlan,
  computeOrderWeightBias,
  crWeight,
  trendWeight,
} = require('../modules/position_health');

// --- classifyCrZone ---

function testCrZoneBoundaries() {
  console.log('  classifyCrZone boundaries...');

  // Red low: below 1.7
  assert.strictEqual(classifyCrZone(1.0).zone, 'red_low');
  assert.strictEqual(classifyCrZone(1.4).zone, 'red_low');
  assert.strictEqual(classifyCrZone(1.69).zone, 'red_low');

  // Green: 1.7 – 3.0 (acceptable range)
  assert.strictEqual(classifyCrZone(1.7).zone, 'green');
  assert.strictEqual(classifyCrZone(1.85).zone, 'green');
  assert.strictEqual(classifyCrZone(2.0).zone, 'green');
  assert.strictEqual(classifyCrZone(2.25).zone, 'green');
  assert.strictEqual(classifyCrZone(2.5).zone, 'green');
  assert.strictEqual(classifyCrZone(2.75).zone, 'green');
  assert.strictEqual(classifyCrZone(2.99).zone, 'green');

  // Red high: above 3.0
  assert.strictEqual(classifyCrZone(3.0).zone, 'red_high');
  assert.strictEqual(classifyCrZone(5.0).zone, 'red_high');
  assert.strictEqual(classifyCrZone(100).zone, 'red_high');

  // Edge: invalid
  assert.strictEqual(classifyCrZone(null).zone, 'unknown');
  assert.strictEqual(classifyCrZone(0).zone, 'unknown');
  assert.strictEqual(classifyCrZone(-1).zone, 'unknown');
  assert.strictEqual(classifyCrZone(NaN).zone, 'unknown');
  assert.strictEqual(classifyCrZone(Infinity).zone, 'unknown');

  console.log('    PASS');
}

function testCrZoneStatuses() {
  console.log('  classifyCrZone statuses...');

  assert.strictEqual(classifyCrZone(3.5).status, 'over_collateralized');
  assert.strictEqual(classifyCrZone(2.7).status, 'safe');
  assert.strictEqual(classifyCrZone(2.2).status, 'safe');
  assert.strictEqual(classifyCrZone(2.0).status, 'safe');
  assert.strictEqual(classifyCrZone(1.8).status, 'safe');
  assert.strictEqual(classifyCrZone(1.5).status, 'not_acceptable');
  assert.strictEqual(classifyCrZone(null).status, 'no_data');

  console.log('    PASS');
}

// --- checkTrendAlignment ---

function testTrendAlignment() {
  console.log('  checkTrendAlignment...');

  assert.strictEqual(checkTrendAlignment('short', 'DOWN'), 'aligned');
  assert.strictEqual(checkTrendAlignment('short', 'UP'), 'opposed');
  assert.strictEqual(checkTrendAlignment('short', 'NEUTRAL'), 'neutral');
  assert.strictEqual(checkTrendAlignment('long', 'UP'), 'aligned');
  assert.strictEqual(checkTrendAlignment('long', 'DOWN'), 'opposed');
  assert.strictEqual(checkTrendAlignment('long', 'NEUTRAL'), 'neutral');

  console.log('    PASS');
}

// --- assessPosition: two-layer actions ---

function makePosition(cr: any, debtAmount: any = 100) {
  return {
    id: 'test_pos',
    status: 'debt_open',
    onChain: {
      btsPerMpa: 50,
      collateralAmount: cr && debtAmount ? cr * debtAmount * 50 : 0,
      collateralRatio: cr,
      debtAmount
    },
  };
}

function testAssessRedLow() {
  console.log('  assessPosition red_low (two-layer)...');

  const result = assessPosition(makePosition(1.5));
  assert.strictEqual(result.collateral.zone, 'red_low');
  assert.strictEqual(result.actions.length, 2);
  assert.strictEqual(result.actions[0].action, 'reduce_debt');
  assert.strictEqual(result.actions[0].priority, 'immediate');
  assert.strictEqual(result.actions[1].action, 'add_collateral');
  assert.strictEqual(result.actions[1].priority, 'fallback');

  console.log('    PASS');
}

function testAssessGreen() {
  console.log('  assessPosition green (acceptable range, no actions)...');

  const result = assessPosition(makePosition(1.85));
  assert.strictEqual(result.collateral.zone, 'green');
  assert.strictEqual(result.actions.length, 0);
  const result2 = assessPosition(makePosition(2.0));
  assert.strictEqual(result2.collateral.zone, 'green');
  assert.strictEqual(result2.actions.length, 0);
  const result3 = assessPosition(makePosition(2.7));
  assert.strictEqual(result3.collateral.zone, 'green');
  assert.strictEqual(result3.actions.length, 0);

  console.log('    PASS');
}

function testAssessRedHigh() {
  console.log('  assessPosition red_high (two-layer)...');

  const result = assessPosition(makePosition(3.5));
  assert.strictEqual(result.collateral.zone, 'red_high');
  assert.strictEqual(result.actions.length, 2);
  assert.strictEqual(result.actions[0].action, 'increase_debt');
  assert.strictEqual(result.actions[0].priority, 'immediate');
  assert.strictEqual(result.actions[1].action, 'withdraw_collateral');
  assert.strictEqual(result.actions[1].priority, 'fallback');

  console.log('    PASS');
}

function testAssessNoDebt() {
  console.log('  assessPosition no debt (no CR actions)...');

  const result = assessPosition(makePosition(1.5, 0));
  assert.strictEqual(result.hasDebt, false);
  assert.strictEqual(result.actions.length, 0);

  console.log('    PASS');
}

// --- assessPosition: trend actions ---

function testAssessTrendOpposed() {
  console.log('  assessPosition trend opposed adds review action...');

  const trend = { trend: 'UP', confidence: 70, premium: 1.5 };
  const result = assessPosition(makePosition(2.2), trend);
  assert.strictEqual(result.trend.alignment, 'opposed');
  const reviewAction = result.actions.find((a: any) => a.action === 'review_direction');
  assert.ok(reviewAction, 'should have review_direction action');
  assert.strictEqual(reviewAction.priority, 'evaluate');

  console.log('    PASS');
}

function testAssessTrendAligned() {
  console.log('  assessPosition trend aligned no extra action...');

  const trend = { trend: 'DOWN', confidence: 80, premium: -1.0 };
  const result = assessPosition(makePosition(2.0), trend);
  assert.strictEqual(result.trend.alignment, 'aligned');
  assert.strictEqual(result.actions.length, 0);

  console.log('    PASS');
}

function testAssessTrendLowConfidence() {
  console.log('  assessPosition trend opposed but low confidence...');

  const trend = { trend: 'UP', confidence: 30, premium: 0.5 };
  const result = assessPosition(makePosition(2.0), trend);
  assert.strictEqual(result.trend.alignment, 'opposed');
  assert.strictEqual(result.actions.length, 0, 'low confidence should not trigger review');

  console.log('    PASS');
}

// --- collateral calculations ---

// --- CR_ZONES constant ---

function testCrZonesConstant() {
  console.log('  CR_ZONES constant values...');

  assert.strictEqual(CR_ZONES.RED_HIGH, 3.0);
  assert.strictEqual(CR_ZONES.RED_LOW, 1.7);

  // Deep frozen
  assert.throws(() => { CR_ZONES.RED_HIGH = 999; }, TypeError);

  console.log('    PASS');
}

// --- Weight factor ---

function testTrendWeight() {
  console.log('  trendWeight...');

  assert.strictEqual(trendWeight('UP', 90), 1.0);
  assert.strictEqual(trendWeight('DOWN', 80), 1.0);
  assert.strictEqual(trendWeight('UP', 70), 0.7);
  assert.strictEqual(trendWeight('DOWN', 60), 0.7);
  assert.strictEqual(trendWeight('UP', 50), 0.4);
  assert.strictEqual(trendWeight('DOWN', 40), 0.4);
  assert.strictEqual(trendWeight('UP', 30), 0.2);
  assert.strictEqual(trendWeight('DOWN', 0), 0.2);
  // NEUTRAL always 0.4 regardless of confidence
  assert.strictEqual(trendWeight('NEUTRAL', 100), 0.4);
  assert.strictEqual(trendWeight('NEUTRAL', 0), 0.4);

  console.log('    PASS');
}

function testCrWeight() {
  console.log('  crWeight...');

  assert.strictEqual(crWeight('red_high'), 1.5);
  assert.strictEqual(crWeight('green'), 1.0);
  assert.strictEqual(crWeight('red_low'), 0.0);
  assert.strictEqual(crWeight('unknown'), 1.0);

  console.log('    PASS');
}

function testComputeOrderWeightBias() {
  console.log('  computeOrderWeightBias...');

  const down = computeOrderWeightBias('DOWN', 80);
  assert.strictEqual(down.profile, 'mountain_valley');
  assert.strictEqual(down.buyBias, 1.0);
  assert.strictEqual(down.sellBias, -1.0);

  const up = computeOrderWeightBias('UP', 60);
  assert.strictEqual(up.profile, 'mountain_valley');
  assert.strictEqual(up.buyBias, -0.7);
  assert.strictEqual(up.sellBias, 0.7);

  const neutral = computeOrderWeightBias('NEUTRAL', 90);
  assert.strictEqual(neutral.profile, 'balanced');
  assert.strictEqual(neutral.buyBias, 0);
  assert.strictEqual(neutral.sellBias, 0);
  assert.strictEqual(neutral.strength, 0);

  console.log('    PASS');
}

function testClassifyPriceRangeRatio() {
  console.log('  classifyPriceRangeRatio...');

  assert.strictEqual(classifyPriceRangeRatio(1.8), 'very_competitive');
  assert.strictEqual(classifyPriceRangeRatio(2.0), 'competitive');
  assert.strictEqual(classifyPriceRangeRatio(2.7), 'competitive');
  assert.strictEqual(classifyPriceRangeRatio(3.0), 'conservative');
  assert.strictEqual(classifyPriceRangeRatio(4.0), 'very_conservative');

  console.log('    PASS');
}

function testComputePriceRangeRatioPlan() {
  console.log('  computePriceRangeRatioPlan...');

  const widen = computePriceRangeRatioPlan(
    {
      minPrice: '3x',
      maxPrice: '3x'
    },
    {
      rangeContext: {
        observedMaxPrice: 145,
        observedMinPrice: 70
      },
      referencePrice: 100
    }
  );

  assert.strictEqual(widen.currentRatio, 3);
  assert.strictEqual(widen.observedRatio, 1.45);
  assert.strictEqual(widen.recommendedRatio, 1.6);
  assert.strictEqual(widen.classification, 'very_competitive');
  assert.strictEqual(widen.reason, 'historical_range_supports_tighter_bounds');
  assert.strictEqual(widen.shouldUpdate, true);

  const keep = computePriceRangeRatioPlan(
    {
      minPrice: '2x',
      maxPrice: '2x'
    },
    {
      rangeContext: {
        observedMaxPrice: 195,
        observedMinPrice: 55
      },
      referencePrice: 100
    }
  );

  assert.strictEqual(keep.currentRatio, 2);
  assert.strictEqual(keep.recommendedRatio, 2.15);
  assert.strictEqual(keep.classification, 'competitive');
  assert.strictEqual(keep.shouldUpdate, false);

  console.log('    PASS');
}

// --- Run all ---

function main() {
  console.log('position_health tests\n');

  testCrZonesConstant();
  testCrZoneBoundaries();
  testCrZoneStatuses();
  testTrendAlignment();
  testAssessRedLow();
  testAssessGreen();
  testAssessRedHigh();
  testAssessNoDebt();
  testAssessTrendOpposed();
  testAssessTrendAligned();
  testAssessTrendLowConfidence();
  testTrendWeight();
  testCrWeight();
  testComputeOrderWeightBias();
  testClassifyPriceRangeRatio();
  testComputePriceRangeRatioPlan();

  console.log('\n=== All 21 tests passed ===');
}

main();
