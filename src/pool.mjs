// Не больше limit задач одновременно; следующая берётся, как только освободилось место
export const runPool = async (items, limit, worker) => {
    const queue = [...items];
    await Promise.all(
        Array.from({ length: Math.min(limit, queue.length) }, async () => {
            while (queue.length) await worker(queue.shift());
        }),
    );
};
