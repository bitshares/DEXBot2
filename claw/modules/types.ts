export interface Logger {
    log: (message: string, level?: string) => void;
    warn: (message: string) => void;
    error: (message: string) => void;
    debug?: (message: string) => void;
    info?: (message: string) => void;
}

export interface RuntimeContextOptions {
    accountName?: string;
    config?: Record<string, any>;
    dataDir?: string;
    logger?: Logger;
    name?: string;
    profileRoot?: string;
    readyFilePath?: string;
    socketPath?: string;
    stateDir?: string;
}

export interface CredentialClientOptions {
    socketPath?: string;
    readyFilePath?: string;
    pollIntervalMs?: number;
}

export interface StateStoreOptions {
    dataDir?: string;
    stateDir?: string;
    filePath?: string;
    defaultValue?: any;
}

export interface BitsharesClientOptions {
    accountName?: string;
    socketPath?: string;
    readyFilePath?: string;
}

export interface BroadcastOptions {
    accountName?: string;
}

export interface CreditRuntimeAdapterOptions {
    stateDir?: string;
    accountName?: string;
}

export interface ClawInfrastructureOptions {
    runtime?: RuntimeContextOptions;
    stateStore?: StateStoreOptions;
    stateDefaultValue?: any;
    stateFilePath?: string;
    credential?: CredentialClientOptions;
    bitshares?: BitsharesClientOptions;
    market?: Record<string, any>;
    creditRuntime?: CreditRuntimeAdapterOptions;
}

export interface ClawBridgeOptions {
    runtimeName?: string;
    runtime?: { name?: string };
    accountName?: string;
    accountRef?: string;
    botRef?: string;
    identifier?: string;
    botId?: string;
    botName?: string;
    pair?: string;
    forceReload?: boolean;
    baseSymbol?: string;
    quoteSymbol?: string;
    assetA?: string;
    assetB?: string;
    limit?: number;
    batchSize?: number;
    discoverPairs?: string[];
    maxPages?: number;
    prefix?: string;
    startSymbol?: string;
    mpaAsset?: string;
    resourceUrl?: string;
    modality?: string;
    queries?: any[];
    categoryId?: string;
    categoryName?: string;
    category?: string;
    summary?: string;
    itemId?: string;
    updates?: Record<string, any>;
    messages?: any[];
    context?: string | Record<string, any>;
    query?: string;
    privateKey?: string;
    patch?: Record<string, any>;
}

export interface BotSettings {
    active?: boolean;
    coreOrders?: { sell?: number; buy?: number };
    edgeOrders?: number | { sell?: number; buy?: number };
    assetA?: string;
    assetAId?: string;
    assetB?: string;
    assetBId?: string;
    botFunds?: { sell?: number | string; buy?: number | string };
    dryRun?: boolean;
    gridPrice?: number | string | null;
    incrementPercent?: number;
    maxPrice?: number | string;
    minPrice?: number | string;
    name?: string;
    preferredAccount?: string;
    startPrice?: number | string;
    strategy?: string;
    targetSpreadPercent?: number;
    weightDistribution?: { sell?: number; buy?: number };
    botIndex?: number;
    botKey?: string;
}

export interface ProfileOptions {
    profileRoot?: string;
    logger?: Logger;
    manifestFile?: string;
    botsFile?: string;
    generalSettingsFile?: string;
    marketProfilesFile?: string;
    forceReload?: boolean;
    writeTrigger?: boolean;
    trigger?: boolean;
    triggerPayload?: any;
    triggerReason?: string;
    reasoning?: string[];
    allowUnknownKeys?: boolean;
    selectedBot?: any;
    botIdentifier?: string;
    botRef?: string;
    botKey?: string;
    name?: string;
    orderSnapshot?: any;
    gridPriceSnapshot?: any;
}

export interface ShortPositionOptions {
    accountName?: string;
    mpaAsset?: string;
    debtAmount?: number;
    collateralAmount?: number;
    sellPriceInBts?: number;
    targetCollateralRatio?: number | null;
    expiration?: string;
    fillOrKill?: boolean;
    privateKey?: string;
    amountToCover?: number;
    buyPriceInBts?: number;
    amountToRepay?: number;
    releaseCollateralDelta?: number;
}

export interface PositionManagerOptions {
    statePath?: string;
}

export interface ClawProfileBundle {
    profileRoot?: string;
    profilesDir?: string;
    botsFile?: string;
    generalSettingsFile?: string;
    marketProfilesFile?: string;
    manifestFile?: string;
    bots?: BotSettings[];
    activeBots?: BotSettings[];
    botsByKey?: Record<string, BotSettings>;
    botsByName?: Record<string, BotSettings>;
    botsConfig?: any;
    marketProfiles?: any;
    amaProfiles?: any;
    generalSettings?: any;
    manifest?: any;
    orderFiles?: string[];
    ordersDir?: string;
    files?: {
        marketProfiles?: string;
        amaProfiles?: string;
        bots?: string;
        generalSettings?: string;
        manifest?: string;
        ordersDir?: string;
    };
    needsMarketAdapter?: boolean;
}
