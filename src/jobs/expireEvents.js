import { logger } from '../logger.js';
import { expireFinishedEvents } from '../events/lifecycle.js';

/**
 * RF19 y RF5: cada minuto expira los eventos que terminaron (incluidos los Parches en Vivo) para que
 * salgan del mapa. Publica event.expired.
 */
export function startExpiryJob({ intervalMs = 60_000 } = {}) {
  let stopped = false;
  let timer;

  const tick = async () => {
    if (stopped) return;
    try {
      const count = await expireFinishedEvents();
      if (count > 0) logger.info({ count }, 'eventos expirados');
    } catch (err) {
      logger.error(err, 'fallo expirando eventos, se reintenta en el siguiente tick');
    } finally {
      if (!stopped) timer = setTimeout(tick, intervalMs);
    }
  };

  timer = setTimeout(tick, intervalMs);
  return {
    stop: () => {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
