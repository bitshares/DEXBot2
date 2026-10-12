'use strict';

import { NATIVE_CLIENT } from '../../constants.js';

const { CHAIN, OPERATIONS } = NATIVE_CLIENT;

const GRAPHENE_BLOCKCHAIN_PRECISION = CHAIN.PRECISION;
const GRAPHENE_ADDRESS_PREFIX = CHAIN.ADDRESS_PREFIX;
const GRAPHENE_CHAIN_ID = CHAIN.CHAIN_ID;

const OP_LIMIT_ORDER_CREATE = OPERATIONS.LIMIT_ORDER_CREATE;
const OP_LIMIT_ORDER_CANCEL = OPERATIONS.LIMIT_ORDER_CANCEL;
const OP_FILL_ORDER = OPERATIONS.FILL_ORDER;

const RESERVED_SPACES = {
    relative_protocol_ids: 0,
    protocol_ids: 1,
    implementation_ids: 2,
};

const OBJECT_TYPE = {
    null: 0,
    base: 1,
    account: 2,
    asset: 3,
    force_settlement: 4,
    committee_member: 5,
    witness: 6,
    limit_order: 7,
    call_order: 8,
    custom: 9,
    proposal: 10,
    operation_history: 11,
    withdraw_permission: 12,
    vesting_balance: 13,
    worker: 14,
    balance: 15,
    htlc: 16,
    custom_authority: 17,
    ticket: 18,
    liquidity_pool: 19,
    samet_fund: 20,
    credit_offer: 21,
    credit_deal: 22,
};

export { GRAPHENE_BLOCKCHAIN_PRECISION, GRAPHENE_ADDRESS_PREFIX, GRAPHENE_CHAIN_ID, OP_LIMIT_ORDER_CREATE, OP_LIMIT_ORDER_CANCEL, OP_FILL_ORDER, RESERVED_SPACES, OBJECT_TYPE }

