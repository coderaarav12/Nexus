import os from 'node:os';
import fs from 'node:fs';

let lastCpuTimes: { idle: number; total: number } | null = null;

export function cpuUsagePercent(): number {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const c of cpus) {
    idle += c.times.idle;
    total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
  }
  if (lastCpuTimes) {
    const id = idle - lastCpuTimes.idle;
    const t = total - lastCpuTimes.total;
    lastCpuTimes = { idle, total };
    if (t > 0) return Math.max(0, Math.min(100, (1 - id / t) * 100));
    return 0;
  }
  lastCpuTimes = { idle, total };
  return 0;
}

export function ramInfo() {
  return { total: os.totalmem(), free: os.freemem(), used: os.totalmem() - os.freemem() };
}

export function diskInfo(dir: string) {
  try {
    const s = fs.statfsSync(dir);
    return { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
  } catch {
    return { total: 0, free: 0 };
  }
}

export function cpuTempC(): number | null {
  try {
    const raw = fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8').trim();
    const c = Number(raw) / 1000;
    return Number.isFinite(c) ? c : null;
  } catch {
    return null;
  }
}

export interface LanAddress {
  address: string;
  family: string;
  netmask: string;
}

export function lanAddresses(): LanAddress[] {
  const out: LanAddress[] = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces ?? []) {
      if (i.family === 'IPv4' && !i.internal) {
        out.push({ address: i.address, family: i.family, netmask: i.netmask });
      }
    }
  }
  return out;
}

export function isLanAddress(ip: string | undefined): boolean {
  if (!ip) return false;
  const addrs = lanAddresses();
  for (const a of addrs) {
    const parts = ip.split('.');
    const server = a.address.split('.');
    if (parts.length === 4 && server.length === 4 && parts.slice(0, 3).join('.') === server.slice(0, 3).join('.')) {
      return true;
    }
  }
  return false;
}

let lastNet: { rx: number; tx: number; at: number } | null = null;

export function loadAverages(): { one: number; five: number; fifteen: number } {
  const [one, five, fifteen] = os.loadavg();
  return { one, five, fifteen };
}

export function cpuPerCore(): { count: number; usage: number[] } {
  const cpus = os.cpus();
  const per = cpus.map((c) => {
    const idle = c.times.idle;
    const total = c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
    return { idle, total };
  });
  if (!lastCpuTimes) {
    // first sample: prime baseline with aggregate; per-core deltas start from next call
    lastCpuTimes = per.reduce(
      (a, c) => ({ idle: a.idle + c.idle, total: a.total + c.total }),
      { idle: 0, total: 0 },
    );
  }
  const usage = per.map((c, i) => {
    const prev = lastCpuPerCore[i];
    if (!prev) return 0;
    const dt = c.total - prev.total;
    const di = c.idle - prev.idle;
    return dt > 0 ? Math.max(0, Math.min(100, ((dt - di) / dt) * 100)) : 0;
  });
  lastCpuPerCore = per;
  return { count: cpus.length, usage };
}

let lastCpuPerCore: { idle: number; total: number }[] = [];
export function ramDetails() {
  const info = ramInfo();
  let cached = 0;
  let swapTotal = 0;
  let swapFree = 0;
  try {
    const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
    const grab = (key: string): number => {
      const m = meminfo.match(new RegExp(`^${key}:\\s+(\\d+)`));
      return m ? Number(m[1]) * 1024 : 0;
    };
    cached = grab('Cached') + grab('Buffers') + grab('SReclaimable');
    swapTotal = grab('SwapTotal');
    swapFree = grab('SwapFree');
  } catch {
    /* not linux */
  }
  const used = info.total - info.free;
  return {
    total: info.total,
    used,
    free: info.free,
    cached,
    usedPercent: info.total > 0 ? (used / info.total) * 100 : 0,
    swapTotal,
    swapFree,
    swapUsed: swapTotal - swapFree,
  };
}

export function diskDetails(dir: string) {
  const primary = diskInfo(dir);
  const mounts: { mount: string; total: number; free: number; usedPercent: number }[] = [];
  try {
    const out = fs.readFileSync('/proc/mounts', 'utf8').split('\n');
    const seen = new Set<string>();
    for (const line of out) {
      const parts = line.split(' ');
      if (parts.length < 2) continue;
      const mount = parts[1];
      const fsType = parts[2];
      if (seen.has(mount)) continue;
      if (!mount.startsWith('/') || mount.startsWith('/proc') || mount.startsWith('/sys') || mount.startsWith('/dev') || mount.startsWith('/run')) continue;
      if (/^(overlay|tmpfs|devtmpfs|proc|sysfs|cgroup)/.test(fsType)) continue;
      seen.add(mount);
      const s = fs.statfsSync(mount);
      const total = s.blocks * s.bsize;
      const free = s.bavail * s.bsize;
      mounts.push({
        mount,
        total,
        free,
        usedPercent: total > 0 ? ((total - free) / total) * 100 : 0,
      });
    }
  } catch {
    /* ignore */
  }
  return {
    primary,
    mounts,
  };
}

export function thermalZones(): { id: string; type: string; tempC: number | null }[] {
  const zones: { id: string; type: string; tempC: number | null }[] = [];
  for (let i = 0; i < 16; i++) {
    try {
      const base = `/sys/class/thermal/thermal_zone${i}`;
      const type = fs.readFileSync(`${base}/type`, 'utf8').trim();
      const raw = Number(fs.readFileSync(`${base}/temp`, 'utf8').trim());
      zones.push({ id: `zone${i}`, type, tempC: Number.isFinite(raw) ? raw / 1000 : null });
    } catch {
      break;
    }
  }
  return zones;
}

export function batteryInfo(): { present: boolean; percent: number | null; status: string; tempC: number | null } | null {
  try {
    const base = '/sys/class/power_supply';
    const bats = fs.readdirSync(base).filter((d) => d.startsWith('BAT'));
    if (bats.length === 0) return null;
    const bat = `${base}/${bats[0]}`;
    const read = (f: string): string => {
      try {
        return fs.readFileSync(`${bat}/${f}`, 'utf8').trim();
      } catch {
        return '';
      }
    };
    const capacityRaw = read('capacity');
    const status = read('status');
    const tempRaw = read('temp');
    return {
      present: true,
      percent: capacityRaw ? Number(capacityRaw) : null,
      status: status || 'Unknown',
      tempC: tempRaw ? Number(tempRaw) / 10 : null,
    };
  } catch {
    return null;
  }
}

export function topProcesses(limit = 8): { pid: number; name: string; cpu: number; mem: number }[] {
  try {
    const lines = fs.readFileSync('/proc/stat', 'utf8').split('\n').filter((l) => l.startsWith('cpu '));
    // approximate: /proc/<pid>/stat utime+stime and total system ticks
    const totalTick = cpuTicks();
    if (totalTick <= 0) return [];
    const out: { pid: number; name: string; cpu: number; mem: number }[] = [];
    const dirs = fs.readdirSync('/proc');
    for (const d of dirs) {
      if (!/^\d+$/.test(d)) continue;
      try {
        const stat = fs.readFileSync(`/proc/${d}/stat`, 'utf8');
        const close = stat.lastIndexOf(')');
        const after = stat.slice(close + 2).trim().split(' ');
        const comm = stat.slice(stat.indexOf('(') + 1, close);
        const utime = Number(after[11]);
        const stime = Number(after[12]);
        const starttime = Number(after[19]);
        const rssPages = Number(after[20]);
        const cpu = ((utime + stime) / totalTick) * 100;
        const mem = (rssPages * osPagesize());
        out.push({ pid: Number(d), name: comm.slice(0, 40), cpu, mem });
      } catch {
        /* process vanished */
      }
    }
    return out.sort((a, b) => b.cpu - a.cpu).slice(0, limit);
  } catch {
    return [];
  }
}

function cpuTicks(): number {
  try {
    let sum = 0;
    for (const l of fs.readFileSync('/proc/stat', 'utf8').split('\n')) {
      if (l.startsWith('cpu')) {
        const parts = l.trim().split(/\s+/).slice(1);
        sum += parts.reduce((a, p) => a + Number(p), 0);
      }
    }
    return sum || 0;
  } catch {
    return 0;
  }
}

function osPagesize(): number {
  try {
    return Number(fs.readFileSync('/proc/self/statm', 'utf8').split(' ')[2]) > 0
      ? Number(fs.readFileSync('/proc/meminfo', 'utf8').match(/MemTotal:\s+(\d+)/)?.[1]) * 1024 / Number(fs.readFileSync('/proc/statm', 'utf8').split(' ')[1] || 1) || 4096
      : 4096;
  } catch {
    return 4096;
  }
}

export function netThroughput(): { rxBytesPerSec: number; txBytesPerSec: number } {
  try {
    const net = fs.readFileSync('/proc/net/dev', 'utf8');
    let rx = 0;
    let tx = 0;
    for (const line of net.split('\n').slice(2)) {
      const parts = line.trim().split(':');
      if (parts.length < 2) continue;
      const vals = parts[1].trim().split(/\s+/);
      rx += Number(vals[0]);
      tx += Number(vals[8]);
    }
    const now = Date.now();
    if (lastNet) {
      const dt = (now - lastNet.at) / 1000;
      lastNet = { rx, tx, at: now };
      if (dt > 0) {
        return {
          rxBytesPerSec: Math.max(0, (rx - lastNet.rx) / dt),
          txBytesPerSec: Math.max(0, (tx - lastNet.tx) / dt),
        };
      }
      return { rxBytesPerSec: 0, txBytesPerSec: 0 };
    }
    lastNet = { rx, tx, at: now };
    return { rxBytesPerSec: 0, txBytesPerSec: 0 };
  } catch {
    return { rxBytesPerSec: 0, txBytesPerSec: 0 };
  }
}

export function serverHealth(storageDir: string, logDir: string) {
  const ram = ramDetails();
  const disk = diskDetails(storageDir);
  const temp = cpuTempC();
  const cpu = cpuPerCore();
  return {
    hostname: os.hostname(),
    platform: `${os.platform()} ${os.release()}`,
    arch: os.arch(),
    uptime: os.uptime(),
    cpu: cpuUsagePercent(),
    cpuPerCore: cpu.usage,
    cpuCount: cpu.count,
    load: loadAverages(),
    ram,
    storage: disk.primary,
    mounts: disk.mounts,
    temp,
    thermal: thermalZones(),
    battery: batteryInfo(),
    processes: topProcesses(),
    net: netThroughput(),
    addresses: lanAddresses().map((a) => a.address),
    logDir,
  };
}
