// 极简并发限制器（零依赖，FIFO）
export function createLimiter(limit = 1) {
  const max = Math.max(1, Math.floor(Number(limit)) || 1);
  let active = 0;
  const queue = [];

  function pump() {
    while (active < max && queue.length) {
      const job = queue.shift();
      active += 1;
      Promise.resolve()
        .then(job.fn)
        .then(
          (value) => job.resolve(value),
          (error) => job.reject(error),
        )
        .finally(() => {
          active -= 1;
          pump();
        });
    }
  }

  return {
    run(fn) {
      if (typeof fn !== 'function') return Promise.reject(new TypeError('limiter.run 需要函数'));
      return new Promise((resolve, reject) => {
        queue.push({ fn, resolve, reject });
        pump();
      });
    },
    get active() {
      return active;
    },
    get pending() {
      return queue.length;
    },
    get max() {
      return max;
    },
  };
}

/** 可中断 sleep */
export function sleep(ms, signal) {
  const delay = Math.max(0, Math.floor(Number(ms) || 0));
  if (signal?.aborted) {
    return Promise.reject(abortError(signal.reason));
  }
  if (delay === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, delay);
    const onAbort = () => {
      cleanup();
      reject(abortError(signal.reason));
    };
    function cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    }
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

export function abortError(reason) {
  const err = new Error(
    typeof reason === 'string' ? reason : reason?.message || '操作已取消',
  );
  err.name = 'AbortError';
  return err;
}
