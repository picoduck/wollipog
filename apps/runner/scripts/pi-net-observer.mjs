// Preloaded into each probed Pi process with NODE_OPTIONS=--import. It records every outbound
// Node socket, DNS lookup and UDP send to PI_PROBE_NET_LOG and refuses any that is not loopback.
// This is an OBSERVER for the PI_OFFLINE measurement and a second line of defense, not network
// isolation: non-Node children are invisible to it. Isolation comes from the network namespace the
// suite verifies before every probe (see pi-probe-support.ts).
import dgram from "node:dgram";
import dns from "node:dns";
import { appendFileSync } from "node:fs";
import net from "node:net";

const log = process.env.PI_PROBE_NET_LOG;
const record = (entry) => { if (log) appendFileSync(log, JSON.stringify({ pid: process.pid, ...entry }) + "\n"); };
const loopback = (host) => host === "localhost" || host === "::1" || /^127\./.test(String(host));
const refused = (target) => Object.assign(new Error(`probe network observer refused ${target}`), { code: "ECONNREFUSED" });

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const options = first !== null && typeof first === "object" ? first : { port: args[0], host: args[1] };
  if (options.path) return connect.apply(this, args);
  const host = String(options.host ?? "localhost");
  const allowed = loopback(host);
  record({ kind: "connect", host, port: String(options.port), allowed });
  if (!allowed) { process.nextTick(() => this.destroy(refused(`${host}:${options.port}`))); return this; }
  return connect.apply(this, args);
};

const lookup = dns.lookup;
dns.lookup = function (host, ...rest) {
  const allowed = loopback(host);
  record({ kind: "dns", host: String(host), allowed });
  if (!allowed) { const callback = rest.at(-1); process.nextTick(() => callback(refused(`dns ${host}`))); return {}; }
  return lookup.call(this, host, ...rest);
};
const promisesLookup = dns.promises.lookup;
dns.promises.lookup = async function (host, ...rest) {
  const allowed = loopback(host);
  record({ kind: "dns", host: String(host), allowed });
  if (!allowed) throw refused(`dns ${host}`);
  return promisesLookup.call(this, host, ...rest);
};

dgram.Socket.prototype.send = function () {
  record({ kind: "udp", allowed: false });
  throw refused("udp");
};
record({ kind: "observer_loaded" });
