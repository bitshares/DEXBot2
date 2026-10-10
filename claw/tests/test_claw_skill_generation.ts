'use strict';

const assert = require('assert');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

async function testClawSkillMarkdown() {
  const { buildRuntimeSkillMarkdown, writeRuntimeSkillMarkdown } = require('../modules/claw_skill_md');

  const repoRoot = path.join(os.tmpdir(), 'repo root');
  const profileRoot = path.join(os.tmpdir(), 'profile root');
  const markdown = buildRuntimeSkillMarkdown('openclaw', { repoRoot, profileRoot });
  const hermesMarkdown = buildRuntimeSkillMarkdown('hermes', { repoRoot, profileRoot });
  const openfangMarkdown = buildRuntimeSkillMarkdown('openfang', { repoRoot, profileRoot });
  const nanoMarkdown = buildRuntimeSkillMarkdown('nanobot', { repoRoot, profileRoot });
  const picoMarkdown = buildRuntimeSkillMarkdown('picoclaw', { repoRoot, profileRoot });
  const nanoclawMarkdown = buildRuntimeSkillMarkdown('nanoclaw', { repoRoot, profileRoot });
  const outputPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'claw-skill-md-')), 'SKILL.md');
  const written = await writeRuntimeSkillMarkdown(outputPath, 'openclaw', { repoRoot, profileRoot });
  const fileText = await fs.readFile(outputPath, 'utf8');

  assert.strictEqual(written, fileText);
  assert.ok(markdown.startsWith('---\nname: bitshares-claw'));
  assert.ok(markdown.includes('## OpenClaw Setup'));
  assert.ok(markdown.includes(`openclaw plugins install -l ${repoRoot}`));
  assert.ok(markdown.includes(`Repo root: \`${repoRoot}\``));
  assert.ok(markdown.includes(`Default profile root: \`${profileRoot}\``));
  assert.ok(markdown.includes('claw_manifest'));
  assert.ok(markdown.includes('claw_honest_context'));
  assert.ok(hermesMarkdown.includes('## Hermes Setup'));
  assert.ok(hermesMarkdown.includes('~/.hermes/config.yaml'));
  assert.ok(hermesMarkdown.includes('~/.hermes/skills/bitshares-claw/SKILL.md'));
  assert.ok(hermesMarkdown.includes('claw_manifest'));
  assert.ok(hermesMarkdown.includes('The shared Claw MCP server registers raw tool ids such as `claw_manifest`'));
  assert.strictEqual(hermesMarkdown.includes('mcp_claw_claw_manifest'), false);
  assert.ok(openfangMarkdown.includes('## OpenFang Setup'));
  assert.ok(openfangMarkdown.includes('scripts/claw_bridge'));
  assert.ok(openfangMarkdown.includes('bitshares-claw'));
  assert.ok(nanoMarkdown.includes('## NanoBot Setup'));
  assert.ok(nanoMarkdown.includes('The stdio transport uses newline-delimited JSON-RPC messages on `stdin` and `stdout`.'));
  assert.ok(picoMarkdown.includes('## PicoClaw Setup'));
  assert.ok(picoMarkdown.includes('The stdio transport uses newline-delimited JSON-RPC messages on `stdin` and `stdout`.'));
  assert.ok(nanoclawMarkdown.includes('## NanoClaw Setup'));
  assert.ok(nanoclawMarkdown.includes('bitshares-claw'));
  assert.ok(nanoclawMarkdown.includes('scripts/claw_bridge'));
}

async function testRuntimeSkillToml() {
  const { buildRuntimeSkillToml, writeRuntimeSkillMarkdown } = require('../modules/claw_skill_md');

  for (const runtimeName of ['zeroclaw', 'nullclaw']) {
    const repoRoot = path.join(os.tmpdir(), `${runtimeName}-repo`);
    const profileRoot = path.join(os.tmpdir(), `${runtimeName}-profile`);
    const toml = buildRuntimeSkillToml(
      { runtime: runtimeName, displayName: runtimeName.charAt(0).toUpperCase() + runtimeName.slice(1) },
      repoRoot,
      profileRoot
    );

    assert.ok(toml.includes('[skill]'));
    assert.ok(toml.includes('name = "bitshares-claw"'));
    const displayName = runtimeName.charAt(0).toUpperCase() + runtimeName.slice(1);
    assert.ok(toml.includes(`${displayName} bridge to the AI-Bot / DEXBot2 BitShares layer`));
    assert.ok(toml.includes('claw_bridge.js'));
    assert.ok(toml.includes('--profile-root'));
    assert.ok(toml.includes('[[tools]]'));

    const outputPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), `${runtimeName}-skill-`)), 'SKILL.toml');
    const written = await writeRuntimeSkillMarkdown(outputPath, runtimeName, { repoRoot, profileRoot });
    const fileText = await fs.readFile(outputPath, 'utf8');
    assert.strictEqual(written, fileText);
  }
}

async function testRuntimeSkillMarkdownGeneratesTomlForTomlRuntimes() {
  const { buildRuntimeSkillMarkdown } = require('../modules/claw_skill_md');

  // TOML-based runtimes should generate TOML content, not throw
  const zeroclaw = buildRuntimeSkillMarkdown('zeroclaw', { repoRoot: '/tmp' });
  assert.ok(zeroclaw.includes('[skill]'), 'zeroclaw should generate TOML');
  assert.ok(zeroclaw.includes('bitshares-claw'));

  const nullclaw = buildRuntimeSkillMarkdown('nullclaw', { repoRoot: '/tmp' });
  assert.ok(nullclaw.includes('[skill]'), 'nullclaw should generate TOML');
  assert.ok(nullclaw.includes('bitshares-claw'));
}

async function main() {
  await testClawSkillMarkdown();
  await testRuntimeSkillToml();
  await testRuntimeSkillMarkdownGeneratesTomlForTomlRuntimes();
  console.log('claw skill generation tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
