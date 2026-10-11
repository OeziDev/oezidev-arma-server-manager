import { LineSplitter, type StreamingProcess, type TailHandle } from './types.js';

/**
 * Uzun süren bir süreci takip eder; beklenmedik şekilde biterse artan beklemelerle
 * yeniden başlatır (ilk seferde `args`, sonra `resumeArgs`). Satırlar 200 ms'de bir toplu iletilir.
 */
export function followWithRestart(
  spawn: (args: string[]) => StreamingProcess,
  args: string[],
  resumeArgs: string[],
  onLines: (lines: string[]) => void,
): TailHandle {
  let stopped = false;
  let current: StreamingProcess | null = null;
  let buffered: string[] = [];
  let flushTimer: NodeJS.Timeout | null = null;
  let delay = 2000;

  const flush = () => {
    flushTimer = null;
    const lines = buffered;
    buffered = [];
    if (lines.length && !stopped) onLines(lines);
  };

  const run = async (a: string[]) => {
    while (!stopped) {
      const splitter = new LineSplitter();
      const startedAt = Date.now();
      const proc = spawn(a);
      current = proc;
      proc.onData((chunk, stream) => {
        if (stream === 'stderr') return;
        buffered.push(...splitter.push(chunk));
        if (!flushTimer) flushTimer = setTimeout(flush, 200);
      });
      await proc.wait();
      buffered.push(...splitter.flush());
      if (stopped) return;
      // Uzun süre çalıştıysa beklemeyi sıfırla
      delay = Date.now() - startedAt > 60_000 ? 2000 : Math.min(delay * 2, 60_000);
      await new Promise((r) => setTimeout(r, delay));
      a = resumeArgs;
    }
  };
  void run(args);
  return {
    stop: () => {
      stopped = true;
      if (flushTimer) clearTimeout(flushTimer);
      void current?.kill();
    },
  };
}
