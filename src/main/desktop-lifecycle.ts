import { resolve } from "node:path";

/** The database filename is the durable identity shared by app and daemon. */
export function desktopDataPath(
  args: readonly string[],
  fallback: string,
): string {
  const index = args.indexOf("--data");
  if (index < 0) return resolve(fallback);
  const value = args[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error("--data requires a database path");
  return resolve(value);
}
export function desktopRestartArgs(
  args: readonly string[],
  data: string,
): string[] {
  return [
    ...args.filter(
      (value, index) => value !== "--data" && args[index - 1] !== "--data",
    ),
    "--data",
    resolve(data),
  ];
}
export function desktopDaemonArgs(
  packaged: boolean,
  appPath: string,
  data: string,
): string[] {
  return [
    ...(packaged ? [] : [appPath]),
    "--team-daemon",
    "--data",
    resolve(data),
  ];
}
