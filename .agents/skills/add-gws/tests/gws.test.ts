import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('add-gws skill package', () => {
  const skillDir = path.resolve(__dirname, '..');

  it('has valid manifest metadata', () => {
    const manifestPath = path.join(skillDir, 'manifest.yaml');
    expect(fs.existsSync(manifestPath)).toBe(true);

    const content = fs.readFileSync(manifestPath, 'utf-8');
    expect(content).toContain('skill: gws');
    expect(content).toContain('version: 1.0.0');
    expect(content).toContain('container/Dockerfile');
  });

  it('includes gws docker install change', () => {
    const dockerfile = path.join(skillDir, 'modify', 'container', 'Dockerfile');
    expect(fs.existsSync(dockerfile)).toBe(true);

    const content = fs.readFileSync(dockerfile, 'utf-8');
    expect(content).toContain('@googleworkspace/cli');
  });

  it('includes container-runner gws mount + env passthrough', () => {
    const runner = path.join(skillDir, 'modify', 'src', 'container-runner.ts');
    expect(fs.existsSync(runner)).toBe(true);

    const content = fs.readFileSync(runner, 'utf-8');
    expect(content).toContain('/home/node/.config/gws');
    expect(content).toContain('GOOGLE_WORKSPACE_CLI_ACCOUNT');
    expect(content).toContain('GWS_MCP_SERVICES');
  });

  it('includes agent-runner gws MCP server wiring', () => {
    const agentRunner = path.join(
      skillDir,
      'modify',
      'container',
      'agent-runner',
      'src',
      'index.ts',
    );
    expect(fs.existsSync(agentRunner)).toBe(true);

    const content = fs.readFileSync(agentRunner, 'utf-8');
    expect(content).toContain('[mcp_servers.gws]');
    expect(content).toContain('Configured gws MCP server');
  });

  it('documents env vars in .env.example snapshot', () => {
    const envExample = path.join(skillDir, 'modify', '.env.example');
    expect(fs.existsSync(envExample)).toBe(true);

    const content = fs.readFileSync(envExample, 'utf-8');
    expect(content).toContain('GOOGLE_WORKSPACE_CLI_ACCOUNT');
    expect(content).toContain('NANOCLAW_ENABLE_GWS_MCP');
  });
});
