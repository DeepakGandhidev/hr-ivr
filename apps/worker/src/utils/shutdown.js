/**
 * A screening call in progress is a candidate mid-sentence. Stop taking new
 * ones, let the live ones finish, then exit.
 */
export function gracefulShutdown(server, wss, calls, logger, poller = null) {
  let shuttingDown = false;

  const handle = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal, active: calls.size }, 'Shutting down, draining calls');

    server.close();
    wss.close();

    // Stop pulling new mail before draining calls. Ingestion holds long-lived
    // IMAP IDLE sockets, and closing them here means the mail server sees a
    // clean logout rather than a dropped connection it will hold open.
    if (poller) {
      await Promise.resolve(poller.stop()).catch((err) =>
        logger.error({ err: err.message }, 'Failed to stop ingestion poller')
      );
    }

    const deadline = Date.now() + 10 * 60 * 1000;
    while (calls.size > 0 && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 1000));
    }

    if (calls.size > 0) logger.warn({ active: calls.size }, 'Shutdown deadline reached, dropping calls');
    process.exit(0);
  };

  process.on('SIGTERM', () => handle('SIGTERM'));
  process.on('SIGINT', () => handle('SIGINT'));
}
