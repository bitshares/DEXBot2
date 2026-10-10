
import { getStorage } from '../../modules/storage/index.js';
import { path } from '../../modules/path_api.js';
import { PATHS } from '../../modules/paths.js';
import { getClawToolCatalog } from './claw_catalog.js';
import { getSupportedClawRuntime } from './claw_runtime_matrix.js';
import { buildSkillTomlLines, createTool, normalizeRepoRoot, normalizeProfileRoot, shellQuote } from './skill_utils.js';
const storage = getStorage();

function normalizeClawRepoRoot(repoRoot: string) {
  return normalizeRepoRoot(repoRoot);
}

// Generated docs must reference scripts that actually exist. Claw tooling
// ships compiled to dist/claw/scripts/ (npm run build); generated skill
// files always reference the node + .js form so they work without any
// TypeScript loader installed.
function resolveScriptInvocation(repoRoot: string, name: string) {
  return { command: 'node', script: path.join(repoRoot, 'dist', 'claw', 'scripts', `${name}.js`) };
}

function buildBridgeInvocation(repoRoot: string, profileRoot: string, command: string, extraArgs: any[] = []) {
  const { command: runner, script } = resolveScriptInvocation(repoRoot, 'claw_bridge');
  return [runner, script, command, '--profile-root', profileRoot, ...extraArgs]
    .map((part, index) => (index === 0 ? String(part) : shellQuote(part)))
    .join(' ');
}

function buildToolSummary(runtimeName: string) {
  const tools = getClawToolCatalog().filter((tool: any) => tool.runtimes.includes(runtimeName));
  const byRisk = tools.reduce((groups: Record<string, any>, tool: any) => {
    const risk = tool.risk || 'read';
    if (!groups[risk]) {
      groups[risk] = [];
    }
    groups[risk].push(`\`${tool.toolName}\``);
    return groups;
  }, {});

  const orderedRisks = ['read', 'plan', 'execute'];
  return orderedRisks
    .filter((risk) => Array.isArray(byRisk[risk]) && byRisk[risk].length > 0)
    .map((risk) => `- ${risk}: ${byRisk[risk].join(', ')}`)
    .join('\n');
}

function buildRuntimeSetup(runtime: any, repoRoot: string, profileRoot: string) {
  const { command, script: mcpScriptPath } = resolveScriptInvocation(repoRoot, 'claw_mcp_server');
  // command is 'node'; split so the config blocks can set the
  // executable and args correctly for the built layout.
  const runnerParts = command.split(' ');
  const mcpExec = runnerParts[0];
  const mcpArgs = `[${[...runnerParts.slice(1), mcpScriptPath, '--profile-root', profileRoot].map((part: any) => JSON.stringify(part)).join(', ')}]`;

  switch (runtime.runtime) {
    case 'hermes':
      return [
        '## Hermes Setup',
        '',
        'Hermes works best with the shared Claw MCP server plus an optional local `SKILL.md` for workflow guidance.',
        '',
        'Add the Claw MCP server to `~/.hermes/config.yaml`:',
        '',
        '```yaml',
        'mcp_servers:',
        '  claw:',
        `    command: "${mcpExec}"`,
        `    args: ${mcpArgs}`,
        '```',
        '',
        'Optionally write the generated `SKILL.md` into Hermes\' local skill tree, for example:',
        '',
        '```text',
        '~/.hermes/skills/bitshares-claw/SKILL.md',
        '```',
        '',
        'If you prefer a shared read-only skill directory, add that parent directory under `skills.external_dirs` in `~/.hermes/config.yaml`.',
        'Use the MCP server for live tools and keep this skill focused on workflow guidance rather than embedding execution logic.',
        '',
        `Set \`DEXBOT_PROFILE_ROOT=${profileRoot}\` if you want a default profile root outside MCP server args.`
      ].join('\n');

    case 'nanobot':
      return [
        '## NanoBot Setup',
        '',
        'Add the Claw MCP server to NanoBot `config.json`:',
        '',
        '```json',
        '{',
        '  "tools": {',
        '    "mcpServers": {',
        '      "claw": {',
        `        "command": "${mcpExec}",`,
        `        "args": ${mcpArgs}`,
        '      }',
        '    }',
        '  }',
        '}',
        '```',
        '',
        'The stdio transport uses newline-delimited JSON-RPC messages on `stdin` and `stdout`.',
        '',
        `Set \`DEXBOT_PROFILE_ROOT=${profileRoot}\` if you want a default profile root outside tool args.`
      ].join('\n');

    case 'picoclaw':
      return [
        '## PicoClaw Setup',
        '',
        'Add the Claw MCP server to PicoClaw `config.json`:',
        '',
        '```json',
        '{',
        '  "tools": {',
        '    "mcp": {',
        '      "enabled": true,',
        '      "servers": {',
        '        "claw": {',
        '          "enabled": true,',
        '          "type": "stdio",',
        `          "command": "${mcpExec}",`,
        `          "args": ${mcpArgs}`,
        '        }',
        '      }',
        '    }',
        '  }',
        '}',
        '```',
        '',
        'The stdio transport uses newline-delimited JSON-RPC messages on `stdin` and `stdout`.',
        '',
        `Set \`DEXBOT_PROFILE_ROOT=${profileRoot}\` if you want a default profile root outside tool args.`,
        '',
        'On a fresh PicoClaw install, make sure `agents.defaults.workspace` is configured before expecting workspace skills to appear.',
        'Running `picoclaw onboard` or writing an explicit workspace path in `config.json` is sufficient.'
      ].join('\n');

    case 'nanoclaw':
      return [
        '## NanoClaw Setup',
        '',
        'NanoClaw already ships its own `claw` skill, so keep this bridge skill named `bitshares-claw` to avoid a collision.',
        '',
        'Write the generated `SKILL.md` into NanoClaw\'s workspace skill tree, for example:',
        '',
        '```text',
        '.claude/skills/bitshares-claw/SKILL.md',
        '```',
        '',
        'Use the local JSON bridge in `scripts/claw_bridge --runtime nanoclaw` when you want the NanoClaw runtime to talk to DEXBot2.',
        '',
        `Set \`DEXBOT_PROFILE_ROOT=${profileRoot}\` if you want a default profile root outside tool args.`
      ].join('\n');

    case 'openfang':
      return [
        '## OpenFang Setup',
        '',
        'OpenFang uses the same shared Claw bridge surface through a local CLI wrapper.',
        '',
        'Write the generated `SKILL.md` into OpenFang\'s workspace skill tree, for example:',
        '',
        '```text',
        '~/.openfang/skills/bitshares-claw/SKILL.md',
        '```',
        '',
        'Use the local JSON bridge in `scripts/claw_bridge --runtime openfang` when you want the OpenFang runtime to talk to DEXBot2.',
        '',
        `Set \`DEXBOT_PROFILE_ROOT=${profileRoot}\` if you want a default profile root outside tool args.`
      ].join('\n');

    case 'openclaw':
      return [
        '## OpenClaw Setup',
        '',
        'Install the native plugin from this repository:',
        '',
        '```bash',
        'npm run build',
        `openclaw plugins install -l ${repoRoot}`,
        'openclaw plugins enable bitshares-claw',
        '```',
        '',
        'The plugin registers the same native BitShares tools directly inside OpenClaw.',
        '',
        'If you also want this skill visible in the OpenClaw workspace, write this file to:',
        '',
        '```text',
        '~/.openclaw/workspace/skills/bitshares-claw/SKILL.md',
        '```',
        '',
        `Set \`DEXBOT_PROFILE_ROOT=${profileRoot}\` for the plugin process if you want a default profile root.`
      ].join('\n');

    case 'memu':
      return [
        '## memU Setup',
        '',
        'memU provides 24/7 proactive memory for AI agents. It requires Python 3.13+ and the `memu-py` package.',
        '',
        '```bash',
        'pip install memu-py',
        'export OPENAI_API_KEY=your_api_key',
        '```',
        '',
        'Start the memU MCP server:',
        '',
        '```bash',
        `node ${path.join(repoRoot, 'dist', 'claw', 'scripts', 'memu_mcp_server.js').replace(/\\/g, '/')} --memu-dir ${PATHS.CLAW.MEMU_DIR.replace(/\\/g, '/')}`,
        '```',
        '',
        'Or use the npm script:',
        '',
        '```bash',
        'npm run memu:mcp',
        '```',
        '',
        'The hand-written skill file lives at `skills/memu-memory/SKILL.md` in this repository.',
        '',
        'memU memory operations are independent of the BitShares trading bridge. Use memU tools for memory, preferences, and context capture, and the Claw bridge tools for on-chain operations.',
        '',
        `Set \`DEXBOT_PROFILE_ROOT=${profileRoot}\` if you want a default profile root outside tool args.`
      ].join('\n');

    default:
      return [
        '## Setup',
        '',
        `Use the native ${runtime.nativeIntegration} path for ${runtime.runtime}.`,
        '',
        `Preferred bridge command: \`${command} ${mcpScriptPath} --profile-root ${profileRoot}\``
      ].join('\n');
  }
}

function buildRuntimeWorkflow(runtime: any) {
  const baseLines = [
    '- Start with `claw_manifest`, `claw_runtime`, `claw_profile_context`, `claw_market_snapshot`, `claw_account_snapshot`, or `claw_open_orders`.',
    '- For MPA and short workflows, use `claw_build_open_short_plan`, `claw_build_take_profit_plan`, or `claw_build_close_short_plan` before executing trades.',
    '- Use `claw_honest_context`, `claw_honest_pair`, and `claw_honest_price` when the task involves HONEST assets or discovery.'
  ];

  if (runtime.runtime === 'hermes') {
    baseLines.push('- The shared Claw MCP server registers raw tool ids such as `claw_manifest`; if Hermes shows a namespaced label in its UI, follow the label shown there.');
  }

  return baseLines.join('\n');
}

function buildRuntimeSkillToml(runtime: any, repoRoot: string, profileRoot: string) {
  const tools = getClawToolCatalog()
    .filter((tool: any) => Array.isArray(tool.runtimes) && tool.runtimes.includes(runtime.runtime))
    .map((tool: any) => createTool(
      tool.toolName,
      tool.description,
      buildBridgeInvocation(
        repoRoot,
        profileRoot,
        tool.command,
        tool.extraArgs
      ),
      tool.args
    ));

  return buildSkillTomlLines(
    'bitshares-claw',
    `${runtime.displayName || runtime.runtime} bridge to the AI-Bot / DEXBot2 BitShares layer`,
    ['bitshares', 'bridge', 'local', runtime.runtime],
    tools
  );
}

function buildRuntimeSkillMarkdown(runtimeName: string, options: Record<string, any> = {}) {
  const runtime = getSupportedClawRuntime(runtimeName);
  if (!runtime) {
    throw new Error(`Unsupported runtime: ${runtimeName}`);
  }

  if (runtime.skillFile === 'SKILL.toml') {
    const repoRoot = normalizeClawRepoRoot(options.repoRoot);
    const profileRoot = normalizeProfileRoot(options, repoRoot);
    return buildRuntimeSkillToml(runtime, repoRoot, profileRoot);
  }

  const repoRoot = normalizeClawRepoRoot(options.repoRoot);
  const profileRoot = normalizeProfileRoot(options, repoRoot);

  return [
    '---',
    'name: bitshares-claw',
    `description: Use native DEXBot2 Claw BitShares tools in ${runtime.displayName || runtime.runtime} for market snapshots, HONEST context, MPA planning, and explicit order execution.`,
    '---',
    '',
    '# BitShares Claw',
    '',
    `Use the native Claw integration for ${runtime.displayName || runtime.runtime} when the user asks about BitShares automation, DEXBot2 profiles, HONEST assets, MPA borrowing, order management, or BTS-backed short workflows.`,
    '',
    '## Safety Rules',
    '',
    '- Prefer `read` and `plan` tools before `execute` tools.',
    '- Treat all order placement, cancellation, debt adjustment, and settlement tools as approval-required actions.',
    '- Keep signing and credentials inside DEXBot2; do not ask for raw private keys.',
    '',
    '## Native Tools',
    '',
    buildToolSummary(runtime.runtime),
    '',
    buildRuntimeSetup(runtime, repoRoot, profileRoot),
    '',
    '## Workflow',
    '',
    buildRuntimeWorkflow(runtime),
    '',
    '## Repository Paths',
    '',
    `- Repo root: \`${repoRoot}\``,
    `- Default profile root: \`${profileRoot}\``
  ].join('\n');
}

function writeRuntimeSkillMarkdown(outputPath: string, runtimeName: string, options: Record<string, any> = {}) {
  const content = buildRuntimeSkillMarkdown(runtimeName, options);
  storage.ensureDir(path.dirname(outputPath));
  storage.writeFile(outputPath, content, 'utf8');
  return content;
}

export { buildRuntimeSkillMarkdown, buildRuntimeSkillToml, writeRuntimeSkillMarkdown }

