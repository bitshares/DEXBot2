/**
 * modules/general_settings.ts - General Application Settings
 * 
 * Centralized management for application-wide settings stored in profiles/general.settings.json.
 * Provides read/write operations with fallback handling.
 */


import { getStorage } from './storage/index.js';
import { PATHS } from './paths.js';
import { writeJsonFileAtomic } from './bots_file_lock.js';
import { getErrorMessage } from './utils/errors.js';
import type { UnknownRecord } from './types.js';
const storage = getStorage();

const SETTINGS_FILE = PATHS.PROFILES.GENERAL_SETTINGS_JSON;

/**
 * The on-disk general settings document. Open-ended (dynamic top-level
 * sections) but `NODES` is typed because several callers read it directly.
 */
interface GeneralSettingsDocument {
    NODES?: {
        enabled?: boolean;
        list?: string[];
        healthCheck?: {
            enabled?: boolean;
            intervalMs?: number;
            timeoutMs?: number;
            maxPingMs?: number;
            blacklistThreshold?: number;
            [key: string]: unknown;
        };
        selection?: {
            strategy?: string;
            preferredNode?: string | null;
            [key: string]: unknown;
        };
        [key: string]: unknown;
    };
    [key: string]: unknown;
}

/**
 * Read general application settings from file.
 * Returns fallback if file missing, empty, or parse fails.
 * 
 * @param {Object} [options={}] - Read options
 * @param {*} [options.fallback=null] - Fallback value if file missing or invalid
 * @param {Function} [options.onError=null] - Optional error callback (err, filePath)
 * @returns {Object|*} Parsed settings object or fallback value
 */
function readGeneralSettings({ fallback = null, onError = null }: { fallback?: GeneralSettingsDocument | null; onError?: ((err: unknown, filePath: string) => void) | null } = {}): GeneralSettingsDocument | null {
    if (!storage.exists(SETTINGS_FILE)) return fallback;

    try {
        const raw = storage.readFile(SETTINGS_FILE);
        if (!raw || !raw.trim()) return fallback;
        return JSON.parse(raw) as GeneralSettingsDocument;
    } catch (err) {
        if (typeof onError === 'function') {
            onError(err, SETTINGS_FILE);
        } else {
            console.warn(`Failed to parse ${SETTINGS_FILE}: ${getErrorMessage(err)}. Using defaults.`);
        }
        return fallback;
    }
}

/**
 * Write general application settings to file.
 * Creates profiles directory if it doesn't exist.
 * Formats output as pretty-printed JSON.
 * 
 * @param {Object} settings - Settings object to write
 * @throws {Error} If write operation fails
 */
function writeGeneralSettings(settings: UnknownRecord): void {
    // Atomic write: see writeJsonFileAtomic in bots_file_lock.ts. A plain
    // writeFileSync could leave a truncated file on crash and break the
    // next process that reads general.settings.json.
    writeJsonFileAtomic(SETTINGS_FILE, settings);
}

export { SETTINGS_FILE, readGeneralSettings, writeGeneralSettings }

