import { Router } from 'express';
import { streamXml, closedXml, busyXml, blockedXml, isWithinOperatingHours } from '../lib/plivoXml.js';
import { checkBlockedNumber } from '../db/index.js';
import { verifyV3Signature, publicUrlOf } from '../utils/plivoSignature.js';

export function setupRoutes(app, { config, logger, calls }) {
  const router = Router();

  const authentic = (req) => {
    if (!config.plivo.verifySignature) return true;
    return verifyV3Signature({
      method: req.method,
      url: publicUrlOf(req, config.publicBaseUrl),
      nonce: req.get('X-Plivo-Signature-V3-Nonce'),
      params: req.body ?? {},
      authToken: config.plivo.authToken,
      header: req.get('X-Plivo-Signature-V3')
    });
  };

  /**
   * The answer URL. Everything that should stop a call before a single word is
   * spoken is decided here, where refusing is cheap and clean.
   */
  router.post('/pratibha/answer', async (req, res) => {
    if (!authentic(req)) {
      logger.warn({ from: req.body?.From }, 'Rejected webhook with a bad signature');
      return res.status(403).type('text/plain').send('invalid signature');
    }

    const callUUID = req.body?.CallUUID;
    const from = req.body?.From;

    // A number blocked in the admin panel is refused first, at the line,
    // before any stream exists. A failed check answers normally: a database
    // hiccup must not silence real candidates.
    try {
      if (from && (await checkBlockedNumber(from))) {
        logger.info({ callUUID, from }, 'Blocked number refused');
        return res.type('text/xml').send(blockedXml());
      }
    } catch (err) {
      logger.error({ err: err.message, callUUID }, 'Blocked-number check failed; answering normally');
    }

    if (!isWithinOperatingHours(config.operatingHours)) {
      logger.info({ callUUID, from }, 'Call outside operating hours');
      return res.type('text/xml').send(closedXml(config));
    }

    if (calls.size >= config.maxConcurrentCalls) {
      logger.warn({ callUUID, active: calls.size }, 'At concurrency limit');
      return res.type('text/xml').send(busyXml(config));
    }

    logger.info({ callUUID, from }, 'Answering call');
    res.type('text/xml').send(streamXml(config, callUUID, from));
  });

  router.post('/pratibha/stream-status', (req, res) => {
    logger.info({ body: req.body }, 'Stream status');
    res.sendStatus(204);
  });

  router.post('/pratibha/hangup', (req, res) => {
    logger.info({ callUUID: req.body?.CallUUID, duration: req.body?.Duration }, 'Hangup');
    res.sendStatus(204);
  });

  router.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      service: 'pratibha-agent',
      activeCalls: calls.size,
      maxConcurrentCalls: config.maxConcurrentCalls,
      withinOperatingHours: isWithinOperatingHours(config.operatingHours),
      timestamp: new Date().toISOString()
    });
  });

  app.use('/', router);
}
