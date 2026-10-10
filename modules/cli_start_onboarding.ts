type StartOnboardingCommand = 'key' | 'bot' | null;

/**
 * Select the setup editor that should handle an otherwise-normal start
 * command (`start` or its `unlock` alias).
 * Key setup takes precedence because runtime launches require a usable account
 * key, not just password metadata. A vault with a valid account and no bot
 * definitions proceeds to the bot editor.
 */
export function selectStartOnboardingCommand(hasKeySetup: boolean, botCount: number): StartOnboardingCommand {
    if (!hasKeySetup) return 'key';
    if (botCount === 0) return 'bot';
    return null;
}
