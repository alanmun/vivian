/**
 * NanoClaw Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout.
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 */

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  secrets?: Record<string, string>;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface CodexEvent {
  type?: string;
  thread_id?: string;
  message?: string;
  item?: {
    type?: string;
    text?: string;
    content?: Array<{ type?: string; text?: string }>;
  };
}

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try {
      fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
    } catch {
      // ignore
    }
    return true;
  }
  return false;
}

function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs
      .readdirSync(IPC_INPUT_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];

    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(
          `Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`,
        );
        try {
          fs.unlinkSync(filePath);
        } catch {
          // ignore
        }
      }
    }

    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }

      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }

      setTimeout(poll, IPC_POLL_MS);
    };

    poll();
  });
}

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function ensureCodexConfig(
  codexHome: string,
  mcpServerPath: string,
  containerInput: ContainerInput,
): void {
  fs.mkdirSync(codexHome, { recursive: true });

  const configPath = path.join(codexHome, 'config.toml');
  const config = [
    'model = "gpt-5-codex"',
    'approval_policy = "never"',
    'sandbox_mode = "workspace-write"',
    '',
    '[mcp_servers.nanoclaw]',
    `command = ${tomlString('node')}`,
    `args = [${tomlString(mcpServerPath)}]`,
    'required = true',
    '',
    '[mcp_servers.nanoclaw.env]',
    `NANOCLAW_CHAT_JID = ${tomlString(containerInput.chatJid)}`,
    `NANOCLAW_GROUP_FOLDER = ${tomlString(containerInput.groupFolder)}`,
    `NANOCLAW_IS_MAIN = ${tomlString(containerInput.isMain ? '1' : '0')}`,
    '',
  ].join('\n');

  fs.writeFileSync(configPath, config);
  log(`Wrote Codex config: ${configPath}`);
}

function loadGlobalContext(containerInput: ContainerInput): string {
  const context: string[] = [];

  const localSoulPath = '/workspace/group/SOUL.md';
  if (fs.existsSync(localSoulPath)) {
    context.push('[SOUL]', fs.readFileSync(localSoulPath, 'utf-8'));
  }

  // Backward-compatible fallback for existing installs still using CLAUDE.md.
  const localClaudePath = '/workspace/group/CLAUDE.md';
  if (!fs.existsSync(localSoulPath) && fs.existsSync(localClaudePath)) {
    context.push('[LOCAL CONTEXT]', fs.readFileSync(localClaudePath, 'utf-8'));
  }

  if (!containerInput.isMain) {
    const globalSoulPath = '/workspace/global/SOUL.md';
    if (fs.existsSync(globalSoulPath)) {
      context.push(
        '[GLOBAL PROJECT CONTEXT]',
        fs.readFileSync(globalSoulPath, 'utf-8'),
      );
    } else {
      const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
      if (fs.existsSync(globalClaudeMdPath)) {
        context.push(
          '[GLOBAL PROJECT CONTEXT]',
          fs.readFileSync(globalClaudeMdPath, 'utf-8'),
        );
      }
    }
  } else {
    // Main has project root mounted read-only; load global soul from there.
    const projectGlobalSoul = '/workspace/project/groups/global/SOUL.md';
    if (fs.existsSync(projectGlobalSoul)) {
      context.push(
        '[GLOBAL PROJECT CONTEXT]',
        fs.readFileSync(projectGlobalSoul, 'utf-8'),
      );
    } else {
      const projectGlobalClaude = '/workspace/project/groups/global/CLAUDE.md';
      if (fs.existsSync(projectGlobalClaude)) {
        context.push(
          '[GLOBAL PROJECT CONTEXT]',
          fs.readFileSync(projectGlobalClaude, 'utf-8'),
        );
      }
    }
  }

  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (!fs.statSync(fullPath).isDirectory()) continue;

      const extraSoulPath = path.join(fullPath, 'SOUL.md');
      const extraClaudePath = path.join(fullPath, 'CLAUDE.md');
      if (fs.existsSync(extraSoulPath)) {
        context.push(
          `[EXTRA CONTEXT: ${entry}]`,
          fs.readFileSync(extraSoulPath, 'utf-8'),
        );
      } else if (fs.existsSync(extraClaudePath)) {
        context.push(
          `[EXTRA CONTEXT: ${entry}]`,
          fs.readFileSync(extraClaudePath, 'utf-8'),
        );
      }
    }
  }

  return context.join('\n\n');
}

function buildPrompt(
  prompt: string,
  containerInput: ContainerInput,
  globalContext: string,
): string {
  const chunks: string[] = [];

  if (containerInput.isScheduledTask) {
    chunks.push(
      '[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]',
    );
  }

  if (globalContext) {
    chunks.push(globalContext);
  }

  chunks.push(prompt);

  return chunks.join('\n\n');
}

function extractAgentMessageText(item: CodexEvent['item']): string | null {
  if (!item) return null;

  if (typeof item.text === 'string' && item.text.trim().length > 0) {
    return item.text;
  }

  if (Array.isArray(item.content)) {
    const text = item.content
      .map((part) => (typeof part.text === 'string' ? part.text : ''))
      .join('')
      .trim();
    if (text.length > 0) {
      return text;
    }
  }

  return null;
}

interface RunTurnResult {
  newSessionId?: string;
  resultText: string | null;
  queuedMessages: string[];
  closedDuringQuery: boolean;
}

async function runCodexTurn(
  prompt: string,
  sessionId: string | undefined,
  codexEnv: Record<string, string>,
): Promise<RunTurnResult> {
  const args = [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--sandbox',
    'workspace-write',
    '-C',
    '/workspace/group',
  ];

  if (sessionId) {
    args.push('resume', sessionId, '-');
  } else {
    args.push('-');
  }

  log(`Running: codex ${args.join(' ')}`);

  const child = spawn('codex', args, {
    cwd: '/workspace/group',
    env: codexEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  child.stdin.write(prompt);
  child.stdin.end();

  return new Promise((resolve, reject) => {
    let stdoutBuffer = '';
    let stderr = '';
    let newSessionId = sessionId;
    let latestAgentMessage: string | null = null;
    let finalResult: string | null = null;
    let closedDuringQuery = false;
    const queuedMessages: string[] = [];

    const pollTimer = setInterval(() => {
      if (shouldClose()) {
        closedDuringQuery = true;
        log('Close sentinel detected during codex turn, terminating process');
        child.kill('SIGTERM');
      }

      const pending = drainIpcInput();
      if (pending.length > 0) {
        queuedMessages.push(...pending);
      }
    }, IPC_POLL_MS);

    const handleEvent = (event: CodexEvent): void => {
      if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
        newSessionId = event.thread_id;
      }

      if (
        event.type === 'item.completed' &&
        event.item &&
        (event.item.type === 'agent_message' || event.item.type === 'message')
      ) {
        const text = extractAgentMessageText(event.item);
        if (text) {
          latestAgentMessage = text;
        }
      }

      if (event.type === 'turn.completed') {
        finalResult = latestAgentMessage;
      }
    };

    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk.toString();
      while (true) {
        const newline = stdoutBuffer.indexOf('\n');
        if (newline === -1) break;

        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);

        if (!line) continue;
        try {
          const event = JSON.parse(line) as CodexEvent;
          handleEvent(event);
        } catch {
          // Ignore non-JSON log lines.
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      clearInterval(pollTimer);
      reject(err);
    });

    child.on('close', (code) => {
      clearInterval(pollTimer);

      const trailing = stdoutBuffer.trim();
      if (trailing) {
        try {
          const event = JSON.parse(trailing) as CodexEvent;
          handleEvent(event);
        } catch {
          // Ignore trailing non-JSON output.
        }
      }

      if (!finalResult && latestAgentMessage) {
        finalResult = latestAgentMessage;
      }

      if (code !== 0 && !closedDuringQuery) {
        const tail = stderr.trim().slice(-500);
        reject(
          new Error(
            tail
              ? `Codex exited with code ${code}: ${tail}`
              : `Codex exited with code ${code}`,
          ),
        );
        return;
      }

      resolve({
        newSessionId,
        resultText: finalResult,
        queuedMessages,
        closedDuringQuery,
      });
    });
  });
}

interface QueryResult {
  newSessionId?: string;
  closedDuringQuery: boolean;
  queuedMessages: string[];
}

async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  containerInput: ContainerInput,
  codexEnv: Record<string, string>,
  globalContext: string,
): Promise<QueryResult> {
  const fullPrompt = buildPrompt(prompt, containerInput, globalContext);
  const turn = await runCodexTurn(fullPrompt, sessionId, codexEnv);

  if (turn.resultText) {
    writeOutput({
      status: 'success',
      result: turn.resultText,
      newSessionId: turn.newSessionId,
    });
  }

  return {
    newSessionId: turn.newSessionId,
    closedDuringQuery: turn.closedDuringQuery,
    queuedMessages: turn.queuedMessages,
  };
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);

    try {
      fs.unlinkSync('/tmp/input.json');
    } catch {
      // ignore
    }

    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
    return;
  }

  const codexEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') {
      codexEnv[key] = value;
    }
  }
  for (const [key, value] of Object.entries(containerInput.secrets || {})) {
    codexEnv[key] = value;
  }

  if (!codexEnv.CODEX_API_KEY && codexEnv.OPENAI_API_KEY) {
    codexEnv.CODEX_API_KEY = codexEnv.OPENAI_API_KEY;
  }

  // Backwards-compatible fallback for existing local shim setups.
  if (!codexEnv.CODEX_API_KEY && codexEnv.ANTHROPIC_API_KEY) {
    codexEnv.CODEX_API_KEY = codexEnv.ANTHROPIC_API_KEY;
  }
  if (!codexEnv.CODEX_API_KEY && codexEnv.ANTHROPIC_AUTH_TOKEN) {
    codexEnv.CODEX_API_KEY = codexEnv.ANTHROPIC_AUTH_TOKEN;
  }
  if (!codexEnv.OPENAI_BASE_URL && codexEnv.ANTHROPIC_BASE_URL) {
    codexEnv.OPENAI_BASE_URL = codexEnv.ANTHROPIC_BASE_URL;
  }

  codexEnv.CODEX_HOME = '/home/node/.codex';

  const mcpServerPath = '/app/dist/ipc-mcp-stdio.js';
  ensureCodexConfig(codexEnv.CODEX_HOME, mcpServerPath, containerInput);

  const globalContext = loadGlobalContext(containerInput);

  let sessionId = containerInput.sessionId;
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  try {
    fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
  } catch {
    // ignore
  }

  let prompt = containerInput.prompt;

  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }

  try {
    while (true) {
      log(`Starting codex turn (session: ${sessionId || 'new'})`);

      const queryResult = await runQuery(
        prompt,
        sessionId,
        containerInput,
        codexEnv,
        globalContext,
      );

      if (queryResult.newSessionId) {
        sessionId = queryResult.newSessionId;
      }

      if (queryResult.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        break;
      }

      writeOutput({ status: 'success', result: null, newSessionId: sessionId });

      if (queryResult.queuedMessages.length > 0) {
        prompt = queryResult.queuedMessages.join('\n');
        log(`Processing ${queryResult.queuedMessages.length} queued IPC message(s)`);
        continue;
      }

      log('Turn ended, waiting for next IPC message...');
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars), starting new query`);
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMessage,
    });
    process.exit(1);
  }
}

main();
