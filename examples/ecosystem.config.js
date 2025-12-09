/**
 * PM2 Ecosystem Configuration (Example)
 *
 * This is an example template for running DEXBot2 bots with PM2.
 * For production use, run: node dexbot.js pm2 or npm run pm2:unlock-start
 *
 * The pm2.js script automatically generates a working ecosystem.config.js
 * in the profiles/ folder with proper paths and bot configurations.
 *
 * Manual usage (if needed):
 *   pm2 start examples/ecosystem.config.js
 *   pm2 stop examples/ecosystem.config.js
 *   pm2 reload examples/ecosystem.config.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.dirname(path.dirname(__filename)); // Project root
const PROFILES_DIR = path.join(ROOT, 'profiles');
const BOTS_JSON = path.join(PROFILES_DIR, 'bots.json');
const LOGS_DIR = path.join(PROFILES_DIR, 'logs');

let apps = [];

// Ensure logs directory exists
if (!fs.existsSync(LOGS_DIR)) {
    try {
        fs.mkdirSync(LOGS_DIR, { recursive: true });
    } catch (e) {
        // Ignore if already exists
    }
}

// Load bots from profiles/bots.json
if (fs.existsSync(BOTS_JSON)) {
    try {
        const content = fs.readFileSync(BOTS_JSON, 'utf8');
        // Support JSON with comments
        const cleaned = content
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .split('\n')
            .map(line => line.replace(/\/\/.*$/, ''))
            .join('\n');
        const config = JSON.parse(cleaned);
        const bots = config.bots || [];

        apps = bots
            .filter(bot => bot.active !== false)
            .map(bot => ({
                name: bot.name,
                script: path.join(ROOT, 'bot.js'),
                args: bot.name,
                cwd: ROOT,
                max_memory_restart: '250M',
                watch: false,
                autorestart: true,
                error_file: path.join(LOGS_DIR, `${bot.name}-error.log`),
                out_file: path.join(LOGS_DIR, `${bot.name}.log`),
                log_date_format: 'YY-MM-DD HH:mm:ss.SSS',
                merge_logs: false,
                combine_logs: true,
                max_restarts: 13,
                min_uptime: 86400000,
                restart_delay: 3000
            }));
    } catch (err) {
        console.error('Error loading bots config:', err.message);
    }
}

module.exports = { apps };
