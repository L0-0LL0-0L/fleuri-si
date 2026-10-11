/** Pages that use real chain assets and must work independently of the virtual Garden store. */
const EXACT = ["/identity", "/launchpad", "/verify", "/pollen", "/botanist", "/launch-config", "/staking"];
const PREFIX = ["/passport/", "/t/"];

export function isOnchainPath(path: string): boolean {
  const p = path.length > 1 ? path.replace(/\/+$/, "") : path;
  return EXACT.includes(p) || PREFIX.some((x) => p.startsWith(x));
}
