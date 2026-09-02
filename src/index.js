import express from 'express';
import http from 'http';
import pino from 'pino';
import { WebSocketServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';

import { loadConfig, validateConfig } from './config/index.js';
import { setupRoutes } from './routes/index.js';
import { OsApi } from './lib/osApi.js';
import { ToolExecutor } from './lib/toolExecutor.js';
import { ScreeningAgent } from './lib/screening.js';
import { PostCallAnalyst } from './lib/analysis.js';
import { SessionManager } from './lib/sessionManager.js';
import { CallTranscript } from './lib/transcript.js';
import { CallSession } from './lib/callSession.js';
import { PlivoStream } from './audio/plivoStream.js';
import { gracefulShutdown } from './utils/shutdown.js';

const config = loadConfig();
const logger = pino({
  level: config.logging.level,
  transport: process.env.NODE_ENV === 'production' ? undefined : { target: 'pino-pretty' }
});

const problems = validateConfig(config);
if (problems.length) {
  for (const problem of problems) logger.error(problem);
  if (process.env.ALLOW_INCOMPLETE_CONFIG !== 'true') {
    logger.error('Refusing to start. Fix the above, or set ALLOW_INCOMPLETE_CONFIG=true to start anyway.');
    process.exit(1);
  }
  logger.warn('Starting with an incomplete configuration - calls will fail.');
}

const api = new OsApi(config, logger);
const tools = new ToolExecutor(config, logger, api);
const agent = new ScreeningAgent(config, logger, tools);
const analyst = new PostCallAnalyst(config, logger, api);
const sessions = new SessionManager();
const calls = new Map();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
setupRoutes(app, { config, logger, calls, api });

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  if (!request.url?.startsWith('/pratibha/stream')) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
});

wss.on('connection', (ws, request) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const id = url.searchParams.get('callUUID') || uuidv4();

  if (calls.has(id)) {
    logger.warn({ id }, 'Duplicate stream for a call already in progress');
    ws.close();
    return;
  }

  const plivo = new PlivoStream(ws, logger);
  const session = sessions.create(id, { callUUID: url.searchParams.get('callUUID') });
  session.transcript = new CallTranscript(id, id, logger);

  const call = new CallSession({ plivo, session, agent, api, config, logger, analyst });
  calls.set(id, call);

  // Plivo sends `start` before any audio, and it carries the caller's details.
  // Everything the call needs to know about itself arrives there, so setup waits
  // for it rather than guessing from the query string.
  plivo.once('start', (start) => {
    session.callerNumber = start.from ?? session.callerNumber;
    call.begin(start).catch((err) => {
      logger.error({ id, err }, 'Call setup failed');
      call.finalise('technical_failure');
    });
  });

  const cleanup = () => {
    call.finalise(session.outcome).finally(() => {
      calls.delete(id);
      sessions.delete(id);
    });
  };

  ws.on('close', cleanup);
  ws.on('error', (err) => {
    logger.error({ id, err: err.message }, 'Plivo socket error');
    cleanup();
  });
});

server.listen(config.port, () => {
  logger.info({
    port: config.port,
    number: config.plivo.number,
    mockMode: config.mockMode,
    tts: config.tts.provider,
    operatingHours: config.operatingHours.label,
    maxConcurrentCalls: config.maxConcurrentCalls
  }, 'Pratibha agent listening (inbound only)');
});

gracefulShutdown(server, wss, calls, logger);
