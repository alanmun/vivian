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
const AUDIT_DIR = '/workspace/audit';

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function localDateParts(): { date: string; time: string } {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const mi = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  const ms = String(now.getMilliseconds()).padStart(3, '0');
  return {
    date: `${yyyy}-${mm}-${dd}`,
    time: `${hh}:${mi}:${ss}.${ms}`,
  };
}

function indentBlock(value: string): string {
  if (!value) return '    (empty)';
  return value
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
}

function appendAudit(title: string, body?: string): void {
  try {
    fs.mkdirSync(AUDIT_DIR, { recursive: true });
    const { date, time } = localDateParts();
    const filePath = path.join(AUDIT_DIR, `${date}.log`);
    const chunk = [
      `[${time}] ${title}`,
      ...(body ? [indentBlock(body)] : []),
      '',
    ].join('\n');
    fs.appendFileSync(filePath, chunk, 'utf-8');
  } catch (err) {
    log(
      `Audit write failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
  appendAudit(
    `CONTAINER_OUTPUT status=${output.status}`,
    JSON.stringify(output, null, 2),
  );
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
  codexEnv: Record<string, string>,
): void {
  fs.mkdirSync(codexHome, { recursive: true });

  const agentsDir = path.join(codexHome, 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });

  const writeAgentRoleConfig = (role: string): string => {
    const roleConfigPath = path.join(agentsDir, `${role}.toml`);
    const roleConfig = [
      'model = "gpt-5.3-codex"',
      'model_reasoning_effort = "medium"',
      '',
    ].join('\n');
    fs.writeFileSync(roleConfigPath, roleConfig);
    return roleConfigPath;
  };

  const explorerConfigPath = writeAgentRoleConfig('explorer');
  const reviewerConfigPath = writeAgentRoleConfig('reviewer');
  const workerConfigPath = writeAgentRoleConfig('worker');
  const monitorConfigPath = writeAgentRoleConfig('monitor');

  const configPath = path.join(codexHome, 'config.toml');
  const configLines = [
    'model = "gpt-5.4"',
    'model_reasoning_effort = "high"',
    'personality = "friendly"',
    'approval_policy = "never"',
    'sandbox_mode = "workspace-write"',
    '',
    '[features]',
    'multi_agent = true',
    '',
    '[agents.explorer]',
    `config_file = ${tomlString(explorerConfigPath)}`,
    '',
    '[agents.reviewer]',
    `config_file = ${tomlString(reviewerConfigPath)}`,
    '',
    '[agents.worker]',
    `config_file = ${tomlString(workerConfigPath)}`,
    '',
    '[agents.monitor]',
    `config_file = ${tomlString(monitorConfigPath)}`,
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
  ];

  const enableGwsMcp = codexEnv.NANOCLAW_ENABLE_GWS_MCP !== '0';
  if (enableGwsMcp) {
    const gwsServices = codexEnv.GWS_MCP_SERVICES || 'gmail,calendar,drive';
    configLines.push(
      '[mcp_servers.gws]',
      `command = ${tomlString('gws')}`,
      `args = [${tomlString('mcp')}, ${tomlString('-s')}, ${tomlString(gwsServices)}]`,
      'required = false',
      '',
    );

    const gwsEnv = [
      ['GOOGLE_WORKSPACE_CLI_ACCOUNT', codexEnv.GOOGLE_WORKSPACE_CLI_ACCOUNT],
      [
        'GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE',
        codexEnv.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE,
      ],
      [
        'GOOGLE_WORKSPACE_CLI_CLIENT_ID',
        codexEnv.GOOGLE_WORKSPACE_CLI_CLIENT_ID,
      ],
      [
        'GOOGLE_WORKSPACE_CLI_CLIENT_SECRET',
        codexEnv.GOOGLE_WORKSPACE_CLI_CLIENT_SECRET,
      ],
      ['GOOGLE_WORKSPACE_CLI_TOKEN', codexEnv.GOOGLE_WORKSPACE_CLI_TOKEN],
    ].filter(([, value]) => typeof value === 'string' && value.trim() !== '');

    if (gwsEnv.length > 0) {
      configLines.push('[mcp_servers.gws.env]');
      for (const [key, value] of gwsEnv) {
        configLines.push(`${key} = ${tomlString(value as string)}`);
      }
      configLines.push('');
    }

    log(`Configured gws MCP server (services: ${gwsServices})`);
  }

  const config = configLines.join('\n');

  fs.writeFileSync(configPath, config);
  log(`Wrote Codex config: ${configPath}`);
}

function loadGlobalContext(containerInput: ContainerInput): string {
  const context: string[] = [];

  const groupSoulPath = '/workspace/group/SOUL.md';
  const baseSoulPath = '/workspace/default/SOUL.md';

  let baseSoulText: string | null = null;
  if (fs.existsSync(baseSoulPath)) {
    baseSoulText = fs.readFileSync(baseSoulPath, 'utf-8');
    context.push('[BASE SOUL]', baseSoulText);
  }

  let groupSoulText: string | null = null;
  if (fs.existsSync(groupSoulPath)) {
    groupSoulText = fs.readFileSync(groupSoulPath, 'utf-8');
    if (groupSoulText.trim() !== baseSoulText?.trim()) {
      context.push('[GROUP CONTEXT]', groupSoulText);
    }
  }

  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (!fs.statSync(fullPath).isDirectory()) continue;

      const extraSoulPath = path.join(fullPath, 'SOUL.md');
      if (fs.existsSync(extraSoulPath)) {
        context.push(
          `[EXTRA CONTEXT: ${entry}]`,
          fs.readFileSync(extraSoulPath, 'utf-8'),
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
  const useYoloMode = process.env.NANOCLAW_CODEX_YOLO !== '0';
  const args = [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '-C',
    '/workspace/group',
  ];

  if (useYoloMode) {
    args.push('--dangerously-bypass-approvals-and-sandbox');
  } else {
    args.push('--sandbox', 'workspace-write');
  }

  if (sessionId) {
    args.push('resume', sessionId, '-');
  } else {
    args.push('-');
  }

  log(
    `Running: codex ${args.join(' ')} (${useYoloMode ? 'yolo' : 'sandboxed'})`,
  );
  appendAudit(
    `TURN_START session=${sessionId || 'new'} mode=${useYoloMode ? 'yolo' : 'sandboxed'}`,
    `PROMPT_SENT_TO_CODEX\n${prompt}`,
  );

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
      appendAudit(
        `CODEX_EVENT ${event.type || 'unknown'}`,
        JSON.stringify(event, null, 2),
      );

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
          appendAudit('CODEX_STDOUT_RAW', line);
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed) appendAudit('CODEX_STDERR', trimmed);
      }
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
          appendAudit('CODEX_STDOUT_RAW_TRAILING', trailing);
        }
      }

      if (!finalResult && latestAgentMessage) {
        finalResult = latestAgentMessage;
      }

      appendAudit(
        `TURN_END session=${newSessionId || 'unknown'} exit_code=${code}`,
        finalResult
          ? `ASSISTANT_OUTPUT\n${finalResult}`
          : 'ASSISTANT_OUTPUT\n(no assistant text emitted)',
      );

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
  appendAudit('USER_INPUT_RECEIVED', prompt);
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
    appendAudit(
      `RUNNER_START group=${containerInput.groupFolder} chat=${containerInput.chatJid}`,
      JSON.stringify(
        {
          sessionId: containerInput.sessionId || null,
          isMain: containerInput.isMain,
          isScheduledTask: containerInput.isScheduledTask === true,
        },
        null,
        2,
      ),
    );
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

  codexEnv.CODEX_HOME = '/home/node/.codex';

  const mcpServerPath = '/app/dist/ipc-mcp-stdio.js';
  ensureCodexConfig(
    codexEnv.CODEX_HOME,
    mcpServerPath,
    containerInput,
    codexEnv,
  );

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
    appendAudit(
      `IPC_PENDING_MESSAGES count=${pending.length}`,
      pending.join('\n\n'),
    );
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
        appendAudit(
          `IPC_QUEUED_MESSAGES count=${queryResult.queuedMessages.length}`,
          prompt,
        );
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
      appendAudit('IPC_NEXT_MESSAGE', nextMessage);
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
