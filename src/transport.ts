import * as dgram from "dgram";
import * as net from "net";

export type TransportMode = "udp" | "tcp" | "osc";

export interface MagicQConfig {
  ip: string;
  port: number;
  mode: TransportMode;
  commandDelayMs: number;
  // Local address to send from. MagicQ PC ignores CREP whose source IP equals
  // its own, so on the same machine give MagicQ one IP and send from another.
  localIp?: string;
  // MagicQ OSC receive port (Setup → Network → OSC rx port) for the OSC tools.
  oscPort: number;
}

export function getConfig(): MagicQConfig {
  return {
    ip: process.env.MAGICQ_IP ?? "255.255.255.255",
    port: parseInt(process.env.MAGICQ_PORT ?? "6553", 10),
    mode: (process.env.MAGICQ_TRANSPORT ?? "udp") as TransportMode,
    commandDelayMs: parseInt(process.env.MAGICQ_CMD_DELAY_MS ?? "75", 10),
    localIp: process.env.MAGICQ_LOCAL_IP || undefined,
    oscPort: parseInt(process.env.MAGICQ_OSC_PORT ?? "8000", 10),
  };
}

function sendUdp(cmd: string | Buffer, config: MagicQConfig): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = dgram.createSocket("udp4");
    const buf = typeof cmd === "string" ? Buffer.from(cmd, "ascii") : cmd;
    client.bind({ port: 0, address: config.localIp }, () => {
      client.setBroadcast(true);
      client.send(buf, config.port, config.ip, (err) => {
        client.close();
        err ? reject(err) : resolve();
      });
    });
    client.on("error", (err) => {
      client.close();
      reject(err);
    });
  });
}

// OSC string: ASCII, null-terminated, padded to a multiple of 4 bytes.
function oscString(s: string): Buffer {
  const buf = Buffer.alloc(Math.ceil((Buffer.byteLength(s, "ascii") + 1) / 4) * 4);
  buf.write(s, "ascii");
  return buf;
}

export type OscValue = number | string | boolean;

// Encode an OSC 1.0 message. Integers go out as int32 ("i"), other numbers as
// float32 ("f"), booleans as T/F, strings as "s".
export function oscMessage(address: string, args: OscValue[] = []): Buffer {
  let tags = ",";
  const data: Buffer[] = [];
  for (const a of args) {
    if (typeof a === "boolean") {
      tags += a ? "T" : "F";
    } else if (typeof a === "string") {
      tags += "s";
      data.push(oscString(a));
    } else {
      const b = Buffer.alloc(4);
      if (Number.isInteger(a)) {
        tags += "i";
        b.writeInt32BE(a);
      } else {
        tags += "f";
        b.writeFloatBE(a);
      }
      data.push(b);
    }
  }
  return Buffer.concat([oscString(address), oscString(tags), ...data]);
}

// Send an OSC message to MagicQ's OSC receive port (MAGICQ_OSC_PORT).
export function sendOscMessage(address: string, args: OscValue[], config: MagicQConfig): Promise<void> {
  return sendUdp(oscMessage(address, args), { ...config, port: config.oscPort });
}

// Wrap a CREP command in an OSC "/rpc" message. MagicQ PC ignores raw CREP
// sent from the same machine, but accepts it via OSC (default port 8000).
function sendOsc(cmd: string, config: MagicQConfig): Promise<void> {
  return sendUdp(oscMessage("/rpc", [cmd]), config);
}

function sendTcp(cmd: string, config: MagicQConfig): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    const buf = Buffer.from(cmd, "ascii");
    socket.connect(config.port, config.ip, () => {
      socket.write(buf, (err) => {
        socket.destroy();
        err ? reject(err) : resolve();
      });
    });
    socket.on("error", (err) => {
      socket.destroy();
      reject(err);
    });
  });
}

export async function sendCommand(cmd: string, config: MagicQConfig): Promise<void> {
  if (config.mode === "tcp") {
    await sendTcp(cmd, config);
  } else if (config.mode === "osc") {
    await sendOsc(cmd, config);
  } else {
    await sendUdp(cmd, config);
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Send multiple commands sequentially with a delay between each.
export async function sendCommands(cmds: string[], config: MagicQConfig): Promise<void> {
  for (let i = 0; i < cmds.length; i++) {
    await sendCommand(cmds[i], config);
    if (i < cmds.length - 1) {
      await delay(config.commandDelayMs);
    }
  }
}
