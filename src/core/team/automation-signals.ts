// CLI shutdown signals distinguish user stops from OS shutdown/logoff.
export function automationSignals(d: {
  signals: {
    on(event: string, listener: () => void): unknown;
    off(event: string, listener: () => void): unknown;
  };
  clear(): void;
  abort(): void;
}) {
  let preserve = false;
  const stop = () => {
    preserve = false;
    d.clear();
    d.abort();
  };
  const suspend = () => {
    preserve = true;
    d.abort();
  };
  d.signals.on("SIGINT", stop);
  d.signals.on("SIGTERM", suspend);
  d.signals.on("SIGHUP", suspend);
  return () => {
    if (!preserve) d.clear();
    d.signals.off("SIGINT", stop);
    d.signals.off("SIGTERM", suspend);
    d.signals.off("SIGHUP", suspend);
  };
}
