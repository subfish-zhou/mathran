/**
 * `mathran serve` — start the local-only workstation server (PRD §3a).
 *
 * Binds 127.0.0.1 by default (never 0.0.0.0) and prints the URL so the user can
 * open it in a browser. The heavy lifting lives in `src/server/serve.ts`.
 */

export interface ServeCommandOptions {
  host?: string;
  port?: string | number;
  workspace?: string;
}

/** CLI action handler. Returns a process exit code (resolves when killed). */
export async function runServe(opts: ServeCommandOptions = {}): Promise<number> {
  const { startServer } = await import("../../server/serve.js");
  const port =
    opts.port !== undefined && opts.port !== "" ? Number(opts.port) : undefined;
  if (port !== undefined && (!Number.isFinite(port) || port < 0 || port > 65535)) {
    console.error(`mathran serve: invalid port "${opts.port}"`);
    return 2;
  }

  try {
    const server = await startServer({
      host: opts.host,
      port,
      workspace: opts.workspace,
    });
    console.log(`mathran serve — listening on ${server.url}`);
    console.log(`  workspace: ${server.workspace}`);
    console.log(`  open ${server.url} in your browser (Ctrl-C to stop)`);

    await new Promise<void>((resolve) => {
      const shutdown = () => {
        void server.close().finally(() => resolve());
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    });
    return 0;
  } catch (err: any) {
    console.error(`mathran serve: ${err?.message ?? err}`);
    if (process.env.MATHRAN_DEBUG) console.error(err?.stack);
    return 1;
  }
}
