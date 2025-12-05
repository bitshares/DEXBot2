const OrderGridGenerator = require('../modules/order/grid');
const { DEFAULT_CONFIG } = require('../modules/order/constants');

function printGridSample() {
  const config = {
    marketPrice: 2000,
    minPrice: 1500,
    maxPrice: 2600,
    incrementPercent: 2,
    targetSpreadPercent: 5,
    weightDistribution: DEFAULT_CONFIG.weightDistribution
  };

  const { orders, initialSpreadCount } = OrderGridGenerator.createOrderGrid(config);

  const sell = orders.filter(o => o.type === 'sell').map(o => o.price);
  const buy = orders.filter(o => o.type === 'buy').map(o => o.price);

  console.log('--- SELL LEVELS (top -> market) ---');
  for (let i = 0; i < Math.min(20, sell.length - 1); i++) {
    const a = sell[i];
    const b = sell[i+1];
    const pct = ((a - b) / a) * 100;
    console.log(`${a.toFixed(4)} -> ${b.toFixed(4)} : ${pct.toFixed(6)}%`);
  }

  console.log('\n--- BUY LEVELS (market -> down) ---');
  for (let i = 0; i < Math.min(20, buy.length - 1); i++) {
    const a = buy[i];
    const b = buy[i+1];
    const pct = ((a - b) / a) * 100;
    console.log(`${a.toFixed(4)} -> ${b.toFixed(4)} : ${pct.toFixed(6)}%`);
  }
}

printGridSample();
