/**
 * Runs jobs one at a time, in the order given, so no write can land between another write's
 * preparation and its transaction. A job that fails doesn't stop the ones after it.
 */
export function writeQueue(): <T>(job: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(job: () => Promise<T>): Promise<T> => {
    const result = tail.then(job);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
}
