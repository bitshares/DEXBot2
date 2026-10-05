/**
 * modules/chain_keys.ts - Authentication and Key Management
 *
 * Secure storage and management of BitShares private keys.
 * Provides authentication, key storage, and transaction signing capabilities.
 *
 * Features:
 * - Master password authentication with derived vault-key verification
 * - AES-256-GCM encryption with random salt and IV
 * - Private key retrieval for transaction signing
 * - Interactive CLI for key management (add/modify/remove)
 * - Daemon readiness checking
 *
 * Storage: profiles/keys.json (gitignored, never committed)
 *
 * Supported key formats:
 * - WIF (Wallet Import Format): 51-52 character Base58Check encoded
 * - PVT_K1_* style keys used by some Graphene chains
 * - Raw 64-character hexadecimal private keys
 *
 * Security: Master password never stored; only a derived vault key is kept in memory.
 * All newly written private keys use the v2 vault format.
 *
 * ===============================================================================
 * EXPORTS (24 functions + 1 error class)
 * ===============================================================================
 *
 * AUTHENTICATION (3 functions)
 *   1. authenticate() - Authenticate and return a derived vault secret (async)
 *      Prompts user for password, verifies vault metadata
 *      Throws MasterPasswordError on failure, MasterPasswordCancelledError on Escape
 *   2. unlockWithPassword(password, accountsData) - Derive the vault secret from a password
 *      Throws MasterPasswordError if the password is incorrect
 *   3. isMasterPasswordFailure(err) - Check if an error is a master-password failure or cancellation
 *
 * KEY MANAGEMENT (4 functions)
 *   4. getPrivateKey(accountName, vaultSecret) - Get private key for account
 *      Returns decrypted private key string
 *      Throws Error if account not found
 *   5. resolvePrivateKey(accountName, vaultSecret, chainClient) - Resolve a signing key,
 *      following on-chain authority structures when no direct key is stored (async)
 *   6. main() - Interactive CLI for key management (async)
 *      Add/modify/remove keys from storage
 *      Re-encrypts entire key store
 *   7. validatePrivateKey(key) - Validate private key format
 *
 * CRYPTO HELPERS (7 functions)
 *   8. encrypt(text, secret) - AES-256-GCM encryption
 *   9. decrypt(encryptedHex, secret) - AES-256-GCM decryption
 *  10. deriveVaultKey(password, vaultSalt) - Derive the vault key (scrypt)
 *  11. createVaultSecret(vaultKey, extra) - Build a serializable vault-secret object
 *  12. createSessionSecret(vaultKey, sessionSalt) - Derive a session-only signing key (HKDF)
 *  13. isVaultSecret(value) - Type guard for vault-secret objects
 *  14. isDaemonSigningToken(value) - Type guard for daemon signing-token objects
 *
 * STORAGE (4 functions)
 *  15. loadAccounts() - Load accounts from keys.json
 *  16. hasKeySetup() - Check whether the vault has a valid account entry
 *  17. saveAccounts(data) - Save accounts to keys.json
 *  18. checkKeysFileSecurity() - Verify keys.json permissions and ownership
 *
 * DAEMON (6 functions)
 *  19. createDaemonSigningToken(accountName, options) - Build a credential-daemon signing token
 *  20. isDaemonReady(options) - Check if credential daemon is ready
 *  21. isDaemonResponsive(options, timeout) - Check if daemon is responsive
 *  22. waitForDaemon(maxWaitMs, options) - Wait for daemon to become ready (async)
 *  23. probeAccountInDaemon(accountName, timeout, options) - Probe daemon for account (async)
 *  24. pingDaemon(accountName, timeout, options) - Lightweight daemon health check (async)
 *
 * ERROR HANDLING (1 error class)
 *  - MasterPasswordError - Thrown when authentication fails
 *
 * ===============================================================================
 *
 * KEY STORAGE STRUCTURE (profiles/keys.json):
 * {
 *   "vaultVersion": 2,
 *   "vaultSalt": "hex-salt",
 *   "vaultVerifier": "hex-hmac",
 *   "accounts": {
 *     "accountName": "v2:recordSalt:iv:authTag:ciphertext"
 *   }
 * }
 *
 * ENCRYPTION PROCESS:
 * 1. Generate random vault salt (16 bytes) and derive a vault key with scrypt
 * 2. Derive a per-record key from the vault key with HKDF and a record salt
 * 3. Encrypt private key with AES-256-GCM and a 12-byte IV
 * 4. Store: v2:recordSalt:iv:authTag:ciphertext
 *
 * ===============================================================================
 */


import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);

import { path } from './path_api.js';
import { readInput, readPassword, sleep } from './order/utils/system.js';
import { TIMING, CREDENTIAL_PROMPTS, UPDATER } from './constants.js';
import { PATHS } from './paths.js';
import { CLI_COLORS } from './cli_colors.js';
import { formatStartupNotice } from './cli_start_output.js';
import { displayWidth, padDisplay } from './utils/text_width.js';

import { getStorage } from './storage/index.js';
import { sendSocketJsonRequest } from './socket_json_client.js';
import { resolvePrivateKey as resolveAuthKey } from './authority_resolver.js';
import { Config } from './config.js';
import * as base58check from './utils/base58check.js';
import {
    randomBytes,
    hkdfSync,
    scryptSync,
    createHmac,
    timingSafeEqual,
    createCipheriv,
    createDecipheriv,
} from './crypto/sync.js';

let _net: typeof import('node:net') | null | undefined;
function getNet(): typeof import('node:net') {
    if (_net === undefined) {
        try {
            _net = require('net');
        } catch {
            _net = null;
        }
    }
    if (!_net) {
        throw new Error('Unix socket IPC not available in this environment');
    }
    return _net;
}
import {
    getCredentialReadyFilePath,
    getCredentialSocketPath,
    assertPrivatePathSecurity,
} from './credential_runtime.js';
import { getErrorMessage, getErrorCode } from './utils/errors.js';
import { hasProcess } from './env.js';
const storage = getStorage();
const { ensureDir } = storage;

const VAULT_VERSION = 2;
const VAULT_SALT_BYTES = 16;
const VAULT_RECORD_SALT_BYTES = 16;
const VAULT_IV_BYTES = 12;
const VAULT_KEY_BYTES = 32;
// Test-only override: allow tests to lower the scrypt cost so they don't burn
// ~0.5-1s of CPU per derivation with the production N=2^17. Production keeps the
// strong default; only DEXBOT_VAULT_SCRYPT_N (or a small N) lowers it.
const _vaultScryptNOverride = (() => {
    try {
        if (!hasProcess()) return undefined;
        const raw = process.env?.DEXBOT_VAULT_SCRYPT_N;
        if (!raw) return undefined;
        const n = Number(raw);
        return Number.isInteger(n) && n >= 2 && n <= 2 ** 20 ? n : undefined;
    } catch {
        return undefined;
    }
})();
const VAULT_SCRYPT_PARAMS = Object.freeze({
    N: _vaultScryptNOverride ?? 2 ** 17,
    r: 8,
    p: 1,
    // 128 * N * r bytes plus headroom for Node/OpenSSL overhead.
    maxmem: 256 * 1024 * 1024,
});
const VAULT_RECORD_INFO = Buffer.from('dexbot2:v2:record-key', 'utf8');
const VAULT_SESSION_INFO = Buffer.from('dexbot2:v2:session-key', 'utf8');
const VAULT_VERIFIER_LABEL = 'dexbot2:v2:verifier';
const VAULT_SECRET_KIND = 'dexbot-vault-secret';
const VAULT_SESSION_SECRET_KIND = 'dexbot-session-secret';
const VAULT_DAEMON_SIGNING_TOKEN_KIND = 'dexbot-daemon-signing-token';

interface AccountsData {
    vaultVersion: number;
    vaultSalt: string;
    vaultVerifier: string;
    accounts: Record<string, Record<string, unknown>>;
}

interface DaemonPathOptions {
    socketPath?: string;
    readyFilePath?: string;
    runtimeDir?: string;
}

interface DaemonSigningOptions extends DaemonPathOptions {
    sessionId?: string | null;
    botHmacSecret?: string | null;
}


// Profiles key file (ignored) only
const PROFILES_KEYS_FILE = Config.DEXBOT_KEYS_FILE
    ? path.resolve(Config.DEXBOT_KEYS_FILE)
    : PATHS.PROFILES.KEYS_JSON();
const BITSHARES_ONBOARDING_FILE = path.join(PATHS.PROJECT_ROOT, 'docs', 'BITSHARES_ONBOARDING.md');
const BITSHARES_ONBOARDING_DOC_PATH = 'docs/BITSHARES_ONBOARDING.md';
// Derive the web link from the canonical repository metadata so a repo/branch
// change only has to be made in modules/constants.ts.
const BITSHARES_ONBOARDING_REMOTE_URL = `${UPDATER.REPOSITORY_URL.replace(/\.git$/, '')}/blob/${
    UPDATER.BRANCH === 'auto' ? 'main' : UPDATER.BRANCH
}/${BITSHARES_ONBOARDING_DOC_PATH}`;

/**
 * Pick the onboarding link to show: the copy shipped with this installation
 * when present, otherwise the hosted document. Exported for testing.
 */
export function resolveOnboardingUrl(
    localExists: boolean = storage.exists(BITSHARES_ONBOARDING_FILE),
    localHref: string = pathToFileURL(BITSHARES_ONBOARDING_FILE).href,
): string {
    return localExists ? localHref : BITSHARES_ONBOARDING_REMOTE_URL;
}

function printEmptyVaultOnboardingNotice() {
    const message = `New to DEXBot2 and BitShares? Check out:\n${resolveOnboardingUrl()}`;
    console.log(formatStartupNotice(message, {
        isTTY: hasProcess() && Boolean(process.stdout?.isTTY),
        noColor: Boolean(Config.NO_COLOR),
    }));
}

/**
 * Ensures that the profiles/keys directory exists.
 * @private
 */
function ensureProfilesKeysDirectory() {
    const dir = path.dirname(PROFILES_KEYS_FILE);
    ensureDir(dir);
}

function toBuffer(value: unknown, encoding: BufferEncoding = 'hex'): Buffer | null {
    if (Buffer.isBuffer(value)) {
        return Buffer.from(value);
    }
    if (typeof value === 'string' && value.length > 0) {
        return Buffer.from(value, encoding);
    }
    return null;
}

function isVaultSecret(value: unknown) {
    return !!(value && typeof value === 'object' && (value as { kind?: unknown }).kind === VAULT_SECRET_KIND);
}

function resolveVaultKey(secret: unknown): Buffer | null {
    if (!secret) return null;
    if (Buffer.isBuffer(secret)) {
        return Buffer.from(secret);
    }
    const rec = secret as { vaultKeyHex?: unknown; vaultKey?: unknown };
    if ((isVaultSecret(secret) || typeof secret === 'object') && typeof rec.vaultKeyHex === 'string') {
        return toBuffer(rec.vaultKeyHex);
    }
    if (typeof secret === 'object' && Buffer.isBuffer(rec.vaultKey)) {
        return Buffer.from(rec.vaultKey);
    }
    return null;
}

function createVaultSecret(vaultKey: unknown, extra: Record<string, unknown> = {}): VaultSecret {
    const keyBuffer = resolveVaultKey(vaultKey);
    if (!keyBuffer) {
        throw new Error('Vault secret requires a derived key');
    }
    return {
        kind: VAULT_SECRET_KIND,
        version: typeof extra.version === 'number' ? extra.version : VAULT_VERSION,
        vaultKeyHex: keyBuffer.toString('hex'),
    };
}

function createSessionSecret(vaultKey: unknown, sessionSalt: unknown = randomBytes(VAULT_SALT_BYTES)) {
    const keyBuffer = resolveVaultKey(vaultKey);
    const saltBuffer = toBuffer(sessionSalt);
    if (!keyBuffer || !saltBuffer) {
        throw new Error('Vault secret and session salt are required');
    }

    const sessionKey = Buffer.from(
        hkdfSync('sha256', keyBuffer, saltBuffer, VAULT_SESSION_INFO, VAULT_KEY_BYTES)
    );

    return {
        kind: VAULT_SESSION_SECRET_KIND,
        version: VAULT_VERSION,
        sessionSaltHex: saltBuffer.toString('hex'),
        vaultKeyHex: sessionKey.toString('hex'),
    };
}

function createDaemonSigningToken(accountName: string, options: DaemonSigningOptions = {}) {
    if (!accountName || typeof accountName !== 'string') {
        throw new Error('accountName is required for daemon signing');
    }

    return {
        kind: VAULT_DAEMON_SIGNING_TOKEN_KIND,
        accountName,
        socketPath: options.socketPath || getCredentialSocketPath(options),
        sessionId: options.sessionId || null,
        botHmacSecret: options.botHmacSecret || null,
    };
}

function isDaemonSigningToken(value: unknown) {
    if (!value || typeof value !== 'object') return false;
    const rec = value as { kind?: unknown; accountName?: unknown };
    return rec.kind === VAULT_DAEMON_SIGNING_TOKEN_KIND && typeof rec.accountName === 'string';
}

function deriveVaultKey(password: string, vaultSalt: unknown) {
    const saltBuffer = toBuffer(vaultSalt) || randomBytes(VAULT_SALT_BYTES);
    return scryptSync(password, saltBuffer, VAULT_KEY_BYTES, VAULT_SCRYPT_PARAMS);
}

function deriveRecordKey(vaultKey: unknown, recordSalt: unknown) {
    const keyBuffer = resolveVaultKey(vaultKey);
    const saltBuffer = toBuffer(recordSalt);
    if (!keyBuffer || !saltBuffer) {
        throw new Error('Vault key and record salt are required');
    }
    return Buffer.from(hkdfSync('sha256', keyBuffer, saltBuffer, VAULT_RECORD_INFO, VAULT_KEY_BYTES));
}

function createVaultVerifier(vaultKey: unknown) {
    const keyBuffer = resolveVaultKey(vaultKey);
    if (!keyBuffer) {
        throw new Error('Vault key is required');
    }
    return createHmac('sha256', keyBuffer).update(VAULT_VERIFIER_LABEL).digest('hex');
}

function timingSafeEqualHex(leftHex: unknown, rightHex: unknown) {
    if (typeof leftHex !== 'string' || typeof rightHex !== 'string' || leftHex.length !== rightHex.length) {
        return false;
    }
    const left = Buffer.from(leftHex, 'hex');
    const right = Buffer.from(rightHex, 'hex');
    if (left.length !== right.length) {
        return false;
    }
    return timingSafeEqual(left, right);
}

function normalizeAccountsData(data: unknown = {}): AccountsData {
    const source = (data && typeof data === 'object') ? data as Record<string, unknown> : {};
    const accountsSource = (source.accounts && typeof source.accounts === 'object')
        ? source.accounts as Record<string, Record<string, unknown>>
        : {};

    return {
        vaultVersion: Number(source.vaultVersion) || 0,
        vaultSalt: typeof source.vaultSalt === 'string' ? source.vaultSalt : '',
        vaultVerifier: typeof source.vaultVerifier === 'string' ? source.vaultVerifier : '',
        accounts: accountsSource,
    };
}

function hasModernVault(accountsData: Partial<AccountsData>) {
    return !!(
        accountsData
        && accountsData.vaultVersion === VAULT_VERSION
        && typeof accountsData.vaultSalt === 'string'
        && accountsData.vaultSalt.length > 0
        && typeof accountsData.vaultVerifier === 'string'
        && accountsData.vaultVerifier.length > 0
    );
}

function deriveModernSecretFromPassword(password: string, accountsData: AccountsData) {
    if (!hasModernVault(accountsData)) {
        throw new Error('Vault metadata missing');
    }
    const vaultSalt = toBuffer(accountsData.vaultSalt);
    const vaultKey = deriveVaultKey(password, vaultSalt);
    return createVaultSecret(vaultKey);
}

function verifyModernPassword(password: string, accountsData: AccountsData) {
    if (!hasModernVault(accountsData)) {
        return false;
    }
    const secret = deriveModernSecretFromPassword(password, accountsData);
    return timingSafeEqualHex(createVaultVerifier(secret), accountsData.vaultVerifier);
}

/**
 * Encrypt text using the v2 AES-256-GCM vault format.
 * @param {string} text - Plain text to encrypt
 * @param {Object|Buffer} secret - Derived vault secret
 * @returns {string} Encrypted data as hex string
 */
function encrypt(text: string, secret: unknown) {
    const vaultKey = resolveVaultKey(secret);
    if (!vaultKey) {
        throw new Error('A derived vault secret is required to encrypt v2 key data');
    }

    const salt = randomBytes(VAULT_RECORD_SALT_BYTES);
    const key = deriveRecordKey(vaultKey, salt);
    const iv = randomBytes(VAULT_IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag();
    return 'v2:' + salt.toString('hex') + ':' + iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted;
}

/**
 * Decrypt text encrypted with the encrypt() function.
 * @param {string} encrypted - Colon-separated encrypted data
 * @param {Object|Buffer} secret - Derived vault secret
 * @returns {string} Decrypted plain text
 * @throws {Error} If decryption fails (wrong password or corrupted data)
 */
function decrypt(encrypted: unknown, secret: unknown) {
    const parts = String(encrypted || '').split(':');
    if (parts.length !== 5 || parts[0] !== 'v2') {
        throw new Error('Unsupported encrypted payload version');
    }

    const salt = toBuffer(parts[1]);
    const iv = toBuffer(parts[2]);
    const authTag = toBuffer(parts[3]);
    const encryptedText = parts[4];
    if (!salt || !iv || !authTag || typeof encryptedText !== 'string') {
        throw new Error('Invalid encrypted payload');
    }

    const vaultKey = resolveVaultKey(secret);
    if (!vaultKey) {
        throw new Error('A derived vault secret is required to decrypt v2 key data');
    }
    const key = deriveRecordKey(vaultKey, salt);

    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}


/**
 * Validate a private key format.
 * Supports WIF (Base58Check), PVT_K1_* style, and 64-char hex.
 * @param {string} key - Private key to validate
 * @returns {Object} { valid: boolean, reason?: string }
 */
function validatePrivateKey(key: unknown) {
    if (!key || typeof key !== 'string') return { valid: false, reason: 'Empty key' };
    const k = key.trim();

    // Strict WIF validation using base58check decode (verifies checksum & structure)
    try {
        // Base58Check decode throws if checksum or characters are invalid.
        const payload = base58check.decode(k);
        // WIFs for Bitcoin-style keys use 0x80 version byte and payload lengths 33 or 34
        // Uncompressed WIF payload: [0x80 | 32-byte privkey]
        // Compressed WIF payload: [0x80 | 32-byte privkey | 0x01]
        if (payload && payload.length >= 33) {
            // version is first byte
            const version = payload[0];
            if (version === 0x80) {
                // valid WIF format
                // payload length 33 (no compression byte) => uncompressed, 34 => compressed
                if (payload.length === 33 || payload.length === 34) {
                    return { valid: true };
                }
            }
        }
    } catch (err) {
        // Not a valid base58check WIF; continue to other formats
    }

    // PVT-style private key used by some Graphene-based chains (e.g. PVT_K1_<data>)
    // Strip prefix and base58check-decode to verify checksum and payload length.
    // This catches typos before the key is encrypted to disk.
    if (/^PVT_(?:K1_)?[A-Za-z0-9_-]+$/.test(k)) {
        try {
            const stripped = k.replace(/^PVT_(?:K1_)?/, '');
            const payload = base58check.decode(stripped);
            if (payload && payload.length === 32) {
                return { valid: true };
            }
            // Graphene PVT_K1_ keys are 32 bytes of key material
            return { valid: false, reason: `PVT_K1_ key decoded to ${payload.length} bytes, expected 32` };
        } catch (err) {
            return { valid: false, reason: `PVT_K1_ key has invalid base58check encoding: ${getErrorMessage(err)}` };
        }
    }

    // Hex private key (64 hex chars) - accept optionally
    if (/^[0-9a-fA-F]{64}$/.test(k)) {
        return { valid: true };
    }

    return { valid: false, reason: 'Unrecognized key format' };
}

/**
 * Load stored accounts from profiles/keys.json.
 * Returns empty structure if file doesn't exist or is corrupted.
 * @returns {Object} { vaultVersion: number, vaultSalt: string, vaultVerifier: string, accounts: Object }
 */
function loadAccounts() {
    try {
        return normalizeAccountsData(storage.readJSON(PROFILES_KEYS_FILE));
    } catch (error) {
        if (getErrorCode(error) !== 'ENOENT' && !(error instanceof SyntaxError)) {
            console.error('Error loading accounts file, resetting to default:', getErrorMessage(error));
        }
        return normalizeAccountsData();
    }
}

/**
 * Report whether the key vault has a usable account entry.
 * Password metadata alone is not sufficient: cancelling key setup can leave
 * a valid-looking vault with no account key to use at runtime.
 */
function hasKeySetup(accountsData: AccountsData = loadAccounts()) {
    if (!hasModernVault(accountsData)) return false;

    // A vault created by cancelling key setup can contain only password
    // metadata (salt/verifier) and no usable account key. Treat that as
    // incomplete onboarding so `dexbot start` returns to the key manager.
    return Object.entries(accountsData.accounts || {}).some(([accountName, account]) => {
        if (!accountName.trim() || !account || typeof account.encryptedKey !== 'string') return false;
        const parts = account.encryptedKey.split(':');
        return parts.length === 5
            && parts[0] === 'v2'
            && parts.slice(1).every((part: string) => part.length > 0 && part.length % 2 === 0 && /^[0-9a-f]+$/i.test(part));
    });
}

function setupModernVault(accountsData: AccountsData, password: string) {
    const vaultSalt = randomBytes(VAULT_SALT_BYTES);
    const vaultKey = deriveVaultKey(password, vaultSalt);
    accountsData.vaultVersion = VAULT_VERSION;
    accountsData.vaultSalt = vaultSalt.toString('hex');
    accountsData.vaultVerifier = createVaultVerifier(vaultKey);
    return createVaultSecret(vaultKey);
}

/**
 * Check that the keys file has restrictive permissions (0o600) and is owned by
 * the current user.  Returns silently if the file doesn't exist yet (it will be
 * created correctly by saveAccounts).
 *
 * Fails closed on any violation (world-readable mode, symlink, wrong owner).
 * Should be called early in every entry point that may read or write keys.json.
 */
function checkKeysFileSecurity() {
    if (!storage.exists(PROFILES_KEYS_FILE)) return;
    assertPrivatePathSecurity(PROFILES_KEYS_FILE, { expectedType: 'file', requiredMode: 0o600 });
}

/**
 * Unlock the key vault with a master password.
 * Uses modern scrypt v2 vault format with HMAC verification.
 * @param {string} password - Master password
 * @param {unknown} [accountsData=loadAccounts()] - Accounts data object
 * @returns {unknown} Derived vault secret
 * @throws {MasterPasswordError} If password is incorrect
 * @throws {Error} If vault format is unsupported
 */
function unlockWithPassword(password: string, accountsData: AccountsData = loadAccounts()) {
    if (!hasModernVault(accountsData)) {
        if (Object.keys(accountsData.accounts || {}).length > 0) {
            throw new Error(`Unsupported key vault format. Recreate ${PATHS.PROFILES.KEYS_JSON()} with the current key manager.`);
        }
        throw new Error('No master password set, run `dexbot key`.');
    }

    if (!verifyModernPassword(password, accountsData)) {
        throw new MasterPasswordError('Incorrect master password.');
    }
    return deriveModernSecretFromPassword(password, accountsData);
}

function verifyCurrentPassword(password: string, accountsData: AccountsData) {
    return hasModernVault(accountsData) && verifyModernPassword(password, accountsData);
}

class MasterPasswordError extends Error {
    static code = 'MASTER_PASSWORD_FAILED';
    code: string;
    constructor(message: string) {
        super(message);
        this.name = 'MasterPasswordError';
        this.code = MasterPasswordError.code;
    }
}

/**
 * Thrown when the user cancels an interactive master-password prompt (Escape).
 * Kept distinct from MasterPasswordError so cancellation is never reported as a
 * wrong-password failure, while still aborting callers that cannot continue.
 */
class MasterPasswordCancelledError extends Error {
    static code = 'MASTER_PASSWORD_CANCELLED';
    code: string;
    constructor(message = 'Master password entry cancelled.') {
        super(message);
        this.name = 'MasterPasswordCancelledError';
        this.code = MasterPasswordCancelledError.code;
    }
}

/**
 * Check if an error should abort an authentication-dependent flow.
 * Covers both wrong-password failures and user cancellation.
 * @param {Error} err - Error to check
 * @returns {boolean} True if the error indicates authentication could not complete
 */
function isMasterPasswordFailure(err: unknown) {
    return !!(
        err &&
        (err instanceof MasterPasswordError ||
            err instanceof MasterPasswordCancelledError ||
            getErrorCode(err) === MasterPasswordError.code ||
            getErrorCode(err) === MasterPasswordCancelledError.code)
    );
}

const MASTER_PASSWORD_MAX_ATTEMPTS = CREDENTIAL_PROMPTS.MAX_MASTER_PASSWORD_ATTEMPTS;
let masterPasswordAttempts = 0;

/**
 * Prompts the user for the master password with retry tracking.
 * @returns {Promise<string>} The entered password.
 * @throws {MasterPasswordError} If max attempts are reached.
 * @private
 */
async function _promptPassword() {
    if (masterPasswordAttempts >= MASTER_PASSWORD_MAX_ATTEMPTS) {
        throw new MasterPasswordError(`Incorrect master password after ${MASTER_PASSWORD_MAX_ATTEMPTS} attempts.`);
    }
    masterPasswordAttempts += 1;
    // Use readPassword instead of readlineSync to support Delete key and consistent masking
    return await readPassword('Enter master password: ');
}

type VaultSecret = { kind: string; version: number; vaultKeyHex: string };

/**
 * Authenticate and return a derived vault secret.
 * Prompts user interactively with limited retry attempts.
 * @returns {Promise<VaultSecret>} The verified vault secret
 * @throws {MasterPasswordCancelledError} If the user cancels with Escape
 * @throws {Error} If no master password is set
 * @throws {MasterPasswordError} If max attempts exceeded
 */
async function authenticate(): Promise<VaultSecret> {
    const accountsData = loadAccounts();
    if (!hasModernVault(accountsData)) {
        if (Object.keys(accountsData.accounts || {}).length > 0) {
            throw new Error(`Unsupported key vault format. Recreate ${PATHS.PROFILES.KEYS_JSON()} with the current key manager.`);
        }
        throw new Error('No master password set, run `dexbot key`.');
    }
    try {
        while (true) {
            // Enforce the attempt limit at the top of the loop as well as inside
            // _promptPassword. _promptPassword also checks the limit so that
            // any other future caller (or a refactor that removes the check
            // here) cannot accidentally produce an infinite prompt loop. This
            // explicit check is the authoritative exit path.
            if (masterPasswordAttempts >= MASTER_PASSWORD_MAX_ATTEMPTS) {
                throw new MasterPasswordError(`Incorrect master password after ${MASTER_PASSWORD_MAX_ATTEMPTS} attempts.`);
            }
            const enteredPassword = await _promptPassword();
            if (enteredPassword === '\x1b') {
                masterPasswordAttempts = 0;
                throw new MasterPasswordCancelledError();
            }
            try {
                const secret = unlockWithPassword(enteredPassword, accountsData);
                masterPasswordAttempts = 0;
                return secret;
            } catch (error) {
                if (!(error instanceof MasterPasswordError)) {
                    throw error;
                }
            }

            console.log('Master password not correct. Please try again.');
        }
    } catch (err) {
        if (err instanceof MasterPasswordError || err instanceof MasterPasswordCancelledError) {
            masterPasswordAttempts = 0;
        }
        throw err;
    }
}

/**
 * Retrieve and decrypt a stored private key.
 * @param {string} accountName - Name of the account
 * @param {Object|Buffer} vaultSecret - Derived vault secret
 * @returns {string} Decrypted private key
 * @throws {Error} If account not found
 */
function getPrivateKey(accountName: string, vaultSecret: unknown) {
    const accountsData = loadAccounts();
    const account = accountsData.accounts[accountName];
    if (!account) {
        throw new Error(`Account '${accountName}' not found.`);
    }

    return decrypt(account.encryptedKey, vaultSecret);
}

/**
 * Resolve a signing key for an account, following on-chain authority structures
 * (account_auths, key_auths) when no direct key is stored.
 *
 * @param {string} accountName - Target account to sign for
 * @param {Object|Buffer} vaultSecret - Derived vault secret
 * @param {object} chainClient - Native chain client with db.get_full_accounts
 * @returns {Promise<string>} Private key WIF string
 * @throws {Error} If no key can be found through direct lookup or authority resolution
 */
async function resolvePrivateKey(accountName: string, vaultSecret: unknown, chainClient: unknown) {
    const pubKeyCache = new Map<string, string>();

    const tryGetKey = async (name: string) => {
        try {
            return getPrivateKey(name, vaultSecret);
        } catch (e) {
            return null;
        }
    };

    const listNames = () => {
        try {
            const data = loadAccounts();
            return data && data.accounts ? Object.keys(data.accounts) : [];
        } catch (e) {
            return [];
        }
    };

    return resolveAuthKey(accountName, chainClient as Parameters<typeof resolveAuthKey>[1], tryGetKey, listNames, 0, pubKeyCache);
}
/**
 * Display stored account names to console.
 * @param {Object} accounts - Accounts object from loadAccounts()
 * @returns {Array<string>} Array of account names
 */
function listKeyNames(accounts: Record<string, unknown>) {
    const names = accounts ? Object.keys(accounts) : [];
    if (names.length === 0) {
        console.log('  (no accounts stored yet)');
        return [];
    }

    const indexWidth = Math.max(1, ...names.map((_, index: number) => String(index + 1).length));
    const accountWidth = Math.max('Account'.length, ...names.map((name) => displayWidth(name)));
    const header = `#`.padEnd(indexWidth) + '  ' + padDisplay('Account', accountWidth);
    console.log(`  ${CLI_COLORS.yellowBold}${header}${CLI_COLORS.reset}`);
    return names.map((name, index) => {
        const rowIndex = String(index + 1);
        console.log(
            `  ${CLI_COLORS.gray}${rowIndex.padEnd(indexWidth)}${CLI_COLORS.reset}  ` +
            `${CLI_COLORS.greenBold}${padDisplay(name, accountWidth)}${CLI_COLORS.reset}`
        );
        return name;
    });
}

/**
 * Prompts the user to select an account name from the stored keys.
 * @param {Object} accounts - The accounts object.
 * @param {string} promptText - The prompt message to display.
 * @returns {Promise<string|null>} The selected account name, or null if cancelled/invalid.
 */
async function selectKeyName(accounts: Record<string, unknown>, promptText: string) {
    const names = Object.keys(accounts);
    if (!names.length) {
        console.log('No accounts available to select.');
        return null;
    }
    names.forEach((name, index) => console.log(`  ${index + 1}. ${name}`));
    const raw = (await readInput(`${promptText} [1-${names.length}]: `)).trim();
    if (raw === '\x1b') return null;

    const idx = Number(raw) - 1;
    if (Number.isNaN(idx) || idx < 0 || idx >= names.length) {
        if (raw !== '') console.log('Invalid selection.');
        return null;
    }
    return names[idx];
}

/**
 * Interactively changes the master password and re-encrypts all stored keys.
 * @param {Object} accountsData - The loaded accounts data object.
 * @param {Object|Buffer|null} currentSecret - The current derived secret.
 * @returns {Promise<Object|Buffer|null>} The new vault secret, or the old one if unchanged/failed.
 * @throws {MasterPasswordCancelledError} If the user cancels with Escape
 */
async function changeMasterPassword(accountsData: AccountsData, currentSecret: unknown) {
    if (!hasModernVault(accountsData)) {
        console.log('No master password is set yet.');
        return currentSecret;
    }

    const oldPassword = await readPassword('Enter current master password: ');
    if (oldPassword === '\x1b') throw new MasterPasswordCancelledError();

    if (!verifyCurrentPassword(oldPassword, accountsData)) {
        console.log('Incorrect master password!');
        return currentSecret;
    }

    const oldSecret = deriveModernSecretFromPassword(oldPassword, accountsData);

    const newPassword = await readPassword('Enter new master password:     ');
    if (newPassword === '\x1b') throw new MasterPasswordCancelledError();

    const confirmPassword = await readPassword('Confirm new master password:   ');
    if (confirmPassword === '\x1b') throw new MasterPasswordCancelledError();

    if (newPassword !== confirmPassword) {
        console.log('Passwords do not match!');
        return currentSecret;
    }
    if (!newPassword) {
        console.log('New master password cannot be empty.');
        return currentSecret;
    }

    const decryptedKeys: Record<string, string> = {};
    try {
        for (const [name, account] of Object.entries(accountsData.accounts)) {
            decryptedKeys[name] = decrypt(account.encryptedKey, oldSecret);
        }
    } catch (error) {
        // Clear any partially-decrypted keys before returning
        for (const key of Object.keys(decryptedKeys)) delete decryptedKeys[key];
        console.log('Failed to decrypt stored keys with the current master password:', getErrorMessage(error));
        return currentSecret;
    }

    const newSecret = setupModernVault(accountsData, newPassword);
    for (const [name, account] of Object.entries(accountsData.accounts)) {
        account.encryptedKey = encrypt(decryptedKeys[name], newSecret);
        delete decryptedKeys[name];
    }
    // V8 strings are immutable and cannot be zeroed; deleting the references
    // allows GC to collect them.  The real protection is that the window
    // between decrypt and re-encrypt is now minimized to the loop body.
    saveAccounts(accountsData);
    console.log('Master password updated successfully.');
    return newSecret;
}

/**
 * Save accounts data to profiles/keys.json atomically with restrictive permissions.
 * Writes to a temp file in the same directory, fsyncs, then renames over the target.
 * The file is always created with mode 0o600 so that even if the calling process
 * inherited a permissive umask (e.g. 0o022), the key material is never world-readable.
 *
 * @param {Object} data - Accounts data to save
 */
function saveAccounts(data: AccountsData) {
    // Always save sensitive data to the live path (ignored by git)
    ensureProfilesKeysDirectory();

    const serialized: { vaultVersion?: number; vaultSalt?: string; vaultVerifier?: string; accounts: Record<string, Record<string, unknown>> } = {
        vaultVersion: data && Number(data.vaultVersion) ? Number(data.vaultVersion) : 0,
        vaultSalt: data && typeof data.vaultSalt === 'string' ? data.vaultSalt : '',
        vaultVerifier: data && typeof data.vaultVerifier === 'string' ? data.vaultVerifier : '',
        accounts: data && data.accounts && typeof data.accounts === 'object' ? data.accounts : {},
    };

    if (!serialized.vaultSalt) {
        delete serialized.vaultSalt;
    }
    if (!serialized.vaultVerifier) {
        delete serialized.vaultVerifier;
    }
    if (!hasModernVault(serialized)) {
        delete (serialized as { vaultVersion?: number }).vaultVersion;
    }

    // Atomic write via unified StorageAdapter: tmp file with 0o600 + fsync,
    // then rename over target.
    storage.writeJSON(PROFILES_KEYS_FILE, serialized, { mode: 0o600, fsync: true });
}

/**
 * Prompt for, validate, and encrypt a private key for the keymanager's add
 * and modify flows. Centralized so key validation and vault encryption cannot
 * drift between the two paths.
 * @param secret - Vault secret used for encryption
 * @returns The encrypted key, or null when cancelled (ESC) or invalid
 *          (the reason has already been printed)
 */
async function promptEncryptedPrivateKey(secret: unknown): Promise<string | null> {
    const privateKeyRaw = await readPassword('Enter private key:  ');
    if (privateKeyRaw === '\x1b') return null;

    const privateKey = privateKeyRaw.replace(/\s+/g, '');

    const validation = validatePrivateKey(privateKey);
    if (!validation.valid) {
        console.log(`Invalid private key: ${validation.reason}`);
        console.log('Accepted formats: WIF (51/52 chars), PVT_* keys, or 64-hex');
        return null;
    }

    return encrypt(privateKey, secret);
}

/**
 * Launch the interactive key management CLI.
 * Provides menu for: add/modify/remove keys, test decryption,
 * change master password.
 */
async function main(): Promise<boolean> {
    const ESC = '\x1b';
    console.log('Chain Key Manager');
    console.log('========================');

    let accountsData = loadAccounts();
    let vaultSecret: VaultSecret | null = null;
    let vaultReady = false;

    // Check if master password is set
    if (!hasModernVault(accountsData)) {
        console.log(`${CLI_COLORS.boldRed}No master password set. Please set one:${CLI_COLORS.reset}`);
        const password1 = await readPassword('Enter master password:   ');
        if (password1 === ESC) return false;
        const password2 = await readPassword('Confirm master password: ');
        if (password2 === ESC) return false;
        if (password1 !== password2) {
            console.log('Passwords do not match!');
            return false;
        }
        vaultSecret = setupModernVault(accountsData, password1);
        saveAccounts(accountsData);
        vaultReady = true;
        console.log('Master password set successfully.');
        console.log('');
    } else {
        try {
            vaultSecret = await authenticate();
            accountsData = loadAccounts();
            vaultReady = true;
            console.log('Authenticated successfully.');
            console.log('');
        } catch (err) {
            if (err instanceof MasterPasswordCancelledError) {
                return false;
            }
            if (err instanceof MasterPasswordError) {
                console.log(getErrorMessage(err));
                return false;
            }
            throw err;
        }
    }

    if (Object.keys(accountsData.accounts || {}).length === 0) {
        printEmptyVaultOnboardingNotice();
    }

     while (true) {
         console.log('\nMenu:');
         console.log('1. Add key');
         console.log('2. Modify key');
         console.log('3. Remove key');
         console.log('4. List keys');
         console.log('5. Test decryption');
         console.log('6. Change master password');
         console.log('7. Exit (or press Enter)');

         const choiceRaw = await readInput('Choose an option: ');
         console.log('');

         if (choiceRaw === ESC || choiceRaw.trim() === '') {
             break;
         }

         const choice = choiceRaw.trim();

        if (choice === '1') {
            const accountNameRaw = await readInput('Enter account name: ');
            if (accountNameRaw === ESC) continue;
            const accountName = accountNameRaw.trim();
            if (!accountName) {
                continue;
            }

            const encryptedKey = await promptEncryptedPrivateKey(vaultSecret);
            if (!encryptedKey) continue;

            accountsData.accounts[accountName] = { encryptedKey };
            saveAccounts(accountsData);
            console.log(`Account '${accountName}' added successfully.`);
        } else if (choice === '2') {
            const accountName = await selectKeyName(accountsData.accounts, 'Select key to modify');
            if (!accountName) continue;
            
            const encryptedKey = await promptEncryptedPrivateKey(vaultSecret);
            if (!encryptedKey) continue;

            accountsData.accounts[accountName] = { ...accountsData.accounts[accountName], encryptedKey };
            saveAccounts(accountsData);
            console.log(`Account '${accountName}' updated successfully.`);
        } else if (choice === '3') {
            const accountName = await selectKeyName(accountsData.accounts, 'Select key to remove');
            if (!accountName) continue;
            
            const confirmRaw = await readInput(`Remove '${accountName}'? (y/n): `);
            if (confirmRaw === ESC) continue;
            const confirm = confirmRaw.trim().toLowerCase();

            if (confirm === 'y') {
                delete accountsData.accounts[accountName];
                saveAccounts(accountsData);
                console.log(`Account '${accountName}' removed successfully.`);
            } else {
                console.log('Cancelled.');
            }
        } else if (choice === '4') {
            listKeyNames(accountsData.accounts);
        } else if (choice === '5') {
            const accountName = await selectKeyName(accountsData.accounts, 'Select key to test');
            if (!accountName) continue;
            
            try {
                const decryptedKey = decrypt(accountsData.accounts[accountName].encryptedKey, vaultSecret);
                console.log(`First 5 characters: ${decryptedKey.substring(0, 5)}`);
            } catch (error) {
                console.log('Decryption failed - wrong master password or corrupted data');
            }
        } else if (choice === '6') {
            try {
                vaultSecret = (await changeMasterPassword(accountsData, vaultSecret)) as VaultSecret;
            } catch (err) {
                if (err instanceof MasterPasswordCancelledError) {
                    console.log('Cancelled.');
                    continue;
                }
                throw err;
            }
        } else if (choice === '7') {
            break;
        } else {
            console.log('Invalid choice.');
        }
    }

    console.log('Keymanager closed!');
    return vaultReady;
}

/**
 * Check if dexbot-cred daemon is ready and responsive
 * @param {Object} [options={}] - Optional socket/ready-file path overrides
 * @returns {boolean} True if daemon socket is responsive
 */
function isDaemonReady(options: DaemonPathOptions = {}) {
    try {
        return storage.exists(getCredentialReadyFilePath(options)) && storage.exists(getCredentialSocketPath(options));
    } catch {
        return false;
    }
}

/**
 * Check if dexbot-cred daemon is actually responsive by opening a socket
 * connection and waiting for any reply. This catches stale socket/ready
 * files left behind by a crashed daemon.
 * @param {Object} options - Optional socket/ready-file path overrides
 * @param {number} timeout - Probe timeout in milliseconds (default 2000)
 * @returns {Promise<boolean>} True if the daemon accepts connections and replies
 */
function isDaemonResponsive(options: DaemonPathOptions = {}, timeout: number = 2000) {
    return new Promise<boolean>((resolve) => {
        if (!isDaemonReady(options)) {
            return resolve(false);
        }

        let net;
        try {
            net = getNet();
        } catch {
            return resolve(false);
        }
        const socketPath = getCredentialSocketPath(options);
        const socket = net.createConnection(socketPath);
        let settled = false;
        let responseBuffer = '';

        const timer = setTimeout(() => {
            if (!settled) {
                settled = true;
                socket.destroy();
                resolve(false);
            }
        }, timeout);

        socket.on('connect', () => {
            // Send a minimal request that forces the daemon to reply.
            // Missing fields trigger an error response, which is enough
            // to prove the daemon is alive and processing.
            socket.write('{}\n');
        });

        socket.on('data', (data: Buffer) => {
            responseBuffer += data.toString();
            if (!settled && responseBuffer.trim().length > 0) {
                settled = true;
                clearTimeout(timer);
                socket.end();
                resolve(true);
            }
        });

        socket.on('error', () => {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                resolve(false);
            }
        });

        socket.on('end', () => {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                resolve(false);
            }
        });
    });
}

/**
 * Wait for dexbot-cred daemon to be ready
 * @param {number} maxWaitMs - Maximum time to wait in milliseconds (default 60000)
 * @param {Object} [options] - Optional socket/ready-file path overrides
 * @returns {Promise<void>} Resolves when daemon is ready
 * @throws {Error} If daemon doesn't start within timeout
 */
async function waitForDaemon(maxWaitMs: number = TIMING.DAEMON_STARTUP_TIMEOUT_MS, options: DaemonPathOptions = {}) {
    const startTime = Date.now();
    const checkInterval = TIMING.CHECK_INTERVAL_MS; // Check every 100ms

    while (Date.now() - startTime < maxWaitMs) {
        if (isDaemonReady(options)) {
            return;
        }
        await sleep(checkInterval);
    }

    throw new Error(`Daemon did not start within ${maxWaitMs}ms`);
}

/**
 * Send a single-line JSON request to the credential daemon and return
 * the parsed response via extractResult.
 * @param {string} requestType - The "type" field sent to the daemon
 * @param {string} accountName - Account name included in the request
 * @param {number} timeout - Timeout in milliseconds (default 5000)
 * @param {Object} options - Optional socket path overrides
 * @param {string} label - Human label for error messages (e.g. 'request', 'ping', 'probe')
 * @param {function} extractResult - Callback: (response) => resolved value; throw to reject
 * @returns {Promise<*>} Resolved value from extractResult
 */
function sendDaemonRequest(requestType: string, accountName: string | null, timeout: number = TIMING.DAEMON_PING_TIMEOUT_MS, options: DaemonPathOptions = {}, label: string = 'request', extractResult: ((response: Record<string, unknown>) => unknown) | null = null): Promise<unknown> {
    return sendSocketJsonRequest({
        socketPath: getCredentialSocketPath(options),
        timeoutMs: timeout,
        writePayload: (socket: { write(data: string): unknown }) => {
            socket.write(JSON.stringify({ type: requestType, accountName }) + '\n');
        },
        buildError: (kind: string, detail: unknown) => {
            switch (kind) {
                case 'timeout':
                    return new Error(`Daemon ${label} timeout`);
                case 'connection':
                    return new Error(`Daemon connection failed: ${getErrorMessage(detail)}`);
                case 'invalid':
                    return new Error(`Invalid daemon ${label} response`);
                default:
                    return new Error(`Daemon ${label} closed connection unexpectedly`);
            }
        },
        handleResponse: (parsed: unknown, resolve: (value: unknown) => void, reject: (err: unknown) => void) => {
            const p = parsed as Record<string, unknown>;
            try {
                if (extractResult) {
                    resolve(extractResult(p));
                } else if (p.success) {
                    resolve(p);
                } else {
                    reject(new Error((p.error as string) || `Daemon ${label} failed`));
                }
            } catch (handlerErr) {
                reject(handlerErr);
            }
        },
    });
}

/**
 * Lightweight daemon health check.  Does NOT create a session or write
 * an audit log entry — used by the credential daemon watchdog and
 * pre-write probes where only liveness matters.
 * @param {string} accountName - Ignored for ping; included for API consistency
 * @param {number} timeout - Timeout in milliseconds (default 5000)
 * @param {Object} options - Optional socket path overrides
 * @returns {Promise<boolean>} Resolves with true if daemon responds
 */
function pingDaemon(accountName: string | null, timeout: number = TIMING.DAEMON_PING_TIMEOUT_MS, options: DaemonPathOptions = {}): Promise<boolean> {
    return sendDaemonRequest('ping', accountName, timeout, options, 'ping', (response) => {
        if (response.success && response.pong) return true;
        throw new Error((response.error as string) || 'Daemon ping failed');
    }) as Promise<boolean>;
}

/**
 * Verifies the account exists in the daemon's session cache.
 * @param {string} accountName - Name of the account to probe
 * @param {number} timeout - Timeout in milliseconds (default 5000)
 * @param {Object} options - Optional socket path overrides
 * @returns {Promise<string|null>} Resolves with sessionId if account is available, rejects otherwise
 */
function probeAccountInDaemon(accountName: string | null, timeout: number = TIMING.DAEMON_PING_TIMEOUT_MS, options: DaemonPathOptions = {}): Promise<string | null> {
    return sendDaemonRequest('probe-account', accountName, timeout, options, 'probe', (response) => {
        if (response.success) return (response.sessionId as string) || null;
        throw new Error((response.error as string) || 'Daemon probe failed');
    }) as Promise<string | null>;
}

export { validatePrivateKey, loadAccounts, hasKeySetup, saveAccounts, checkKeysFileSecurity, encrypt, decrypt, deriveVaultKey, createDaemonSigningToken, createSessionSecret, createVaultSecret, isVaultSecret, isDaemonSigningToken, unlockWithPassword, main, authenticate, getPrivateKey, resolvePrivateKey, isMasterPasswordFailure, MasterPasswordError, isDaemonReady, isDaemonResponsive, waitForDaemon, probeAccountInDaemon, pingDaemon }
