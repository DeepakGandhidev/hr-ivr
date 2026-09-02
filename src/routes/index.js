import { Router } from 'express';
import { streamXml, closedXml, busyXml, isWithinOperatingHours } from '../lib/plivoXml.js';
import { verifyV3Signature, publicUrlOf } from '../utils/plivoSignature.js';

export function setupRoutes(app, { config, logger, calls, api }) {
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
  router.post('/pratibha/answer', (req, res) => {
    if (!authentic(req)) {
      logger.warn({ from: req.body?.From }, 'Rejected webhook with a bad signature');
      return res.status(403).type('text/plain').send('invalid signature');
    }

    const callUUID = req.body?.CallUUID;
    const from = req.body?.From;

    if (!isWithinOperatingHours(config.operatingHours)) {
      logger.info({ callUUID, from }, 'Call outside operating hours');
      // 5 - CallLogUnmatched records this so "shortlisted, never called" can be
      // told apart from "called, but we were shut".
      api.logUnmatched({
        caller_number: from,
        received_at: new Date().toISOString(),
        reason: 'outside_hours'
      }).catch(() => {});
      return res.type('text/xml').send(closedXml(config));
    }

    if (calls.size >= config.maxConcurrentCalls) {
      logger.warn({ callUUID, active: calls.size }, 'At concurrency limit');
      return res.type('text/xml').send(busyXml(config));
    }

    logger.info({ callUUID, from }, 'Answering call');
    res.type('text/xml').send(streamXml(config, callUUID));
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
