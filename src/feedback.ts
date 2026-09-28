import * as dgram from "dgram";

// Listens for what MagicQ sends back (OSC transmit, or CREP "tx" text) so the
// server can report console state instead of being send-only.
// Enable with MAGICQ_FEEDBACK_PORT and point MagicQ's OSC tx port/IP at it.

export type OscArg = number | string | boolean | null;

export interface FeedbackMessage {
  address: string;
  args: OscArg[];
  from: string;
  at: string;
}

const MAX_LOG = 500;
const latest = new Map<string, FeedbackMessage>();
const log: FeedbackMessage[] = [];
let listening: { port: number } | null = null;
let listenError: string | null = null;

function readString(buf: Buffer, offset: number): [string, number] {
  let end = offset;
  while (end < buf.length && buf[end] !== 0) end++;
  const s = buf.toString("ascii", offset, end);
  return [s, Math.ceil((end + 1) / 4) * 4];
}

// Minimal OSC 1.0 decoder: messages and (nested) bundles, i/f/s/T/F/N args.
function decodeOsc(buf: Buffer): { address: string; args: OscArg[] }[] {
  const [address, afterAddr] = readString(buf, 0);

  if (address === "#bundle") {
    const out: { address: string; args: OscArg[] }[] = [];
    let off = afterAddr + 8; // skip time tag
    while (off + 4 <= buf.length) {
      const size = buf.readInt32BE(off);
      off += 4;
      out.push(...decodeOsc(buf.subarray(off, off + size)));
      off += size;
    }
    return out;
  }

  if (!address.startsWith("/")) throw new Error("not OSC");
  const args: OscArg[] = [];
  if (afterAddr >= buf.length) return [{ address, args }];

  let [tags, off] = readString(buf, afterAddr);
  for (const t of tags.replace(/^,/, "")) {
    switch (t) {
      case "i": args.push(buf.readInt32BE(off)); off += 4; break;
      case "f": args.push(Math.round(buf.readFloatBE(off) * 10000) / 10000); off += 4; break;
      case "s": { const [s, next] = readString(buf, off); args.push(s); off = next; break; }
      case "T": args.push(true); break;
      case "F": args.push(false); break;
      case "N": args.push(null); break;
      default: return [{ address, args }]; // unknown tag — stop, keep what we have
    }
  }
  return [{ address, args }];
}

function record(address: string, args: OscArg[], from: string): void {
  const msg: FeedbackMessage = { address, args, from, at: new Date().toISOString() };
  latest.set(address, msg);
  log.push(msg);
  if (log.length > MAX_LOG) log.shift();
}

export function startFeedbackListener(port: number): void {
  const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
  sock.on("message", (buf, rinfo) => {
    const from = `${rinfo.address}:${rinfo.port}`;
    try {
      for (const m of decodeOsc(buf)) record(m.address, m.args, from);
    } catch {
      // Not OSC — MagicQ's CREP tx sends plain ASCII lines.
      record("(crep)", [buf.toString("ascii").replace(/\0+$/, "").trim()], from);
    }
  });
  sock.on("error", (err) => {
    listenError = err.message;
    listening = null;
    sock.close();
  });
  sock.bind(port, () => {
    listening = { port };
  });
}

export function feedbackStatus(): string {
  if (listening) return `listening on UDP ${listening.port}, ${latest.size} address(es) seen, ${log.length} message(s) logged`;
  if (listenError) return `listener failed: ${listenError}`;
  return "listener disabled (set MAGICQ_FEEDBACK_PORT to enable)";
}

export function getLatest(filter?: string): FeedbackMessage[] {
  const f = filter?.toLowerCase();
  return [...latest.values()]
    .filter((m) => !f || m.address.toLowerCase().includes(f))
    .sort((a, b) => a.address.localeCompare(b.address, undefined, { numeric: true }));
}

export function getRecent(limit: number, filter?: string): FeedbackMessage[] {
  const f = filter?.toLowerCase();
  return log.filter((m) => !f || m.address.toLowerCase().includes(f)).slice(-limit);
}
