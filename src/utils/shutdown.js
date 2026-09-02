/**
 * A screening call in progress is a candidate mid-sentence. Stop taking new
 * ones, let the live ones finish, then exit.
 */
export function gracefulShutdown(server, wss, calls, logger) {
  let shuttingDown = false;

  const handle = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal, active: calls.size }, 'Shutting down, draining calls');

    server.close();
    wss.close();

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
