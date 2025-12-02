// Combined entry point that exposes the OrderManager and supporting utilities.
const { OrderManager } = require('./manager');
// Runner may contain I/O and larger logic; require lazily to avoid loading it
// during small unit tests. Expose a lazy accessor instead.
const utils = require('./utils');
const constants = require('./constants');
const logger = require('./logger');
const order_grid = require('./order_grid');

module.exports = {
  OrderManager,
  // Lazy-load the calculation runner so tests can require this module without triggering heavy I/O.
  runOrderManagerCalculation: (...args) => require('./runner').runOrderManagerCalculation(...args),
  utils,
  constants,
  logger,
  order_grid,
};

