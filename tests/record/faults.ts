import type { DBCore, Middleware } from 'dexie';

/**
 * Storage that fails while writing its Nth row (counting every row written through it), with the
 * given error. Used to show that a failed save leaves nothing behind, and that a full disk is told
 * apart from other failures.
 */
export function failAtRow(n: number, error: () => Error = () => new Error('injected failure')): Middleware<DBCore> {
  let rows = 0;
  return {
    stack: 'dbcore',
    name: 'failAtRow',
    create: down => ({
      ...down,
      table: name => {
        const table = down.table(name);
        return {
          ...table,
          mutate: req => {
            const count = req.type === 'add' || req.type === 'put' ? req.values.length : 0;
            if (rows < n && rows + count >= n) {
              rows += count;
              throw error();
            }
            rows += count;
            return table.mutate(req);
          },
        };
      },
    }),
  };
}
