import { log } from "@orbik/core";

/**
 * Creates a periodic pass that runs until it is stopped.
 *
 * Every loop the scheduler process runs has the same shape: run one pass at once, wait, run the
 * next, and keep going whatever a pass throws. The failure is logged and the loop carries on,
 * because each pass reconsiders everything that is due, so one failure delays the thing that
 * failed rather than everything behind it.
 *
 * The wait is slept in short slices so a stop is not delayed by a long interval, and `stop`
 * resolves once the pass in progress has finished, never in the middle of one.
 *
 * @param {object} options
 * @param {string} options.name the prefix of the loop's log lines: `<name>.started`,
 *   `<name>.tick_failed` and `<name>.stopped`
 * @param {number|(() => number)} options.intervalMs how long to wait after a pass before the next
 *   one; a function is asked again after every pass
 * @param {() => Promise<unknown>} options.tick one pass
 * @param {(level: string, message: string, context?: object) => void} [options.logger]
 * @param {object} [options.startedContext] what the `started` line reports; defaults to the interval
 * @returns {{start: () => Promise<void>, stop: () => Promise<void>}} `start` resolves only once the
 *   loop has been stopped
 */
export function createLoop({ name, intervalMs, tick, logger = log, startedContext }) {
  let running = false;
  let loop = null;

  return {
    /** Starts passes until {@link stop} is called. */
    async start() {
      if (running) return;
      running = true;
      logger("info", `${name}.started`, startedContext ?? { intervalMs });

      loop = (async () => {
        while (running) {
          try {
            await tick();
          } catch (error) {
            logger("error", `${name}.tick_failed`, { message: error.message });
          }
          await sleep(typeof intervalMs === "function" ? intervalMs() : intervalMs, () => running);
        }
      })();
      await loop;
    },

    /** Stops the loop and waits for the pass in progress to finish. */
    async stop() {
      running = false;
      await loop?.catch(() => {});
      logger("info", `${name}.stopped`, {});
    },
  };
}

/** Sleeps in short slices so shutdown is not delayed by a long interval. */
async function sleep(ms, keepRunning) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && keepRunning()) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(250, Math.max(1, deadline - Date.now()))));
  }
}
