'use strict';

const assert = require('assert');

const { normalizeBotDraft } = require('../modules/account_bots');

function testNormalizeBotDraftSeedsDefaults() {
  const draft = normalizeBotDraft({
    name: 'test-bot',
    debtPolicy: {
      lending: [
        { asset: 'HONEST.USD',
                    collateralAsset: 'BTS', type: 'creditOffer', maxFeeRatePerDay: 0.001, maxCollateralRatio: 2.5 },
      ],
    },
  });
  assert.ok(draft.weightDistribution, 'defaults should still seed nested objects');
  assert.ok(draft.botFunds, 'defaults should still seed nested objects');
  assert.ok(draft.activeOrders, 'defaults should still seed nested objects');
  assert.strictEqual(draft.debtPolicy.lending[0].maxFeeRatePerDay, 0.001, 'debtPolicy should survive normalization');
}

function testNormalizeBotDraftPassesThroughUnknownFields() {
  const draft = normalizeBotDraft({
    name: 'test-bot',
    gridPriceOffsetPct: 0.35,
    gridPriceOffsetClampToBounds: true,
  });
  assert.strictEqual(draft.gridPriceOffsetPct, 0.35);
  assert.strictEqual(draft.gridPriceOffsetClampToBounds, true);
}

function main() {
  testNormalizeBotDraftSeedsDefaults();
  testNormalizeBotDraftPassesThroughUnknownFields();
  console.log('account bots draft tests passed');
}

main();
