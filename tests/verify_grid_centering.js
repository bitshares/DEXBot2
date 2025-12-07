
const Grid = require('../modules/order/grid');

// Mock config
const config = {
    marketPrice: 100,
    minPrice: 90,
    maxPrice: 110,
    incrementPercent: 2,
    targetSpreadPercent: 5,
    weightDistribution: { buy: 1, sell: 1 }
};

console.log('--- Verifying Grid Centering ---');
const { orders } = Grid.createOrderGrid(config);

const sellOrders = orders.filter(o => o.type === 'sell' || (o.type === 'spread' && o.price > config.marketPrice));
const buyOrders = orders.filter(o => o.type === 'buy' || (o.type === 'spread' && o.price < config.marketPrice));

// Sort by price
sellOrders.sort((a, b) => a.price - b.price);
buyOrders.sort((a, b) => b.price - a.price);

const lowestSell = sellOrders[0]?.price;
const highestBuy = buyOrders[0]?.price;

console.log(`Market Price: ${config.marketPrice}`);
console.log(`Lowest Sell:  ${lowestSell}`);
console.log(`Highest Buy:  ${highestBuy}`);

if (!lowestSell || !highestBuy) {
    console.error('Failed to generate full grid.');
    process.exit(1);
}

// Geometric mean check
const geomCenter = Math.sqrt(lowestSell * highestBuy);
console.log(`Geometric Mean (First Levels): ${geomCenter}`);

// Relax tolerance for (1+x)(1-x) discrepancy
const tolerance = 0.05;
const diff = Math.abs(geomCenter - config.marketPrice);

console.log(`Difference from Market Price: ${diff}`);

// Check symmetry of first step
const sellStep = lowestSell / config.marketPrice;
const buyStep = highestBuy / config.marketPrice;
console.log(`Sell Step Ratio: ${sellStep.toFixed(5)} (+${((sellStep - 1) * 100).toFixed(3)}%)`);
console.log(`Buy Step Ratio:  ${buyStep.toFixed(5)} (${((buyStep - 1) * 100).toFixed(3)}%)`);

if (diff < tolerance) {
    console.log('SUCCESS: Market price is centered within tolerance.');
} else {
    console.error('FAILURE: Grid is not centered.');
    process.exit(1);
}

// Check spread order spread-ness
const spreads = orders.filter(o => o.type === 'spread');
console.log(`Spread Orders Count: ${spreads.length}`);
spreads.forEach(o => console.log(`Spread Order: ${o.price}`));
