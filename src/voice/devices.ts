/**
 * Input device discovery for `lexicon voice --list-devices` and for the
 * recorder's default device. Pure parsers over the tools' output so they can
 * be tested from fixture strings.
 */
import type { VoiceExec } from './process.js';

export interface AudioDevice {
  /** Index as the platform tool reports it (avfoundation, dshow order, arecord card). */
  index: number;
  /** Human-readable name (what `--device <name>` matches). */
  name: string;
  /** The identifier to hand ffmpeg: `:N` (avfoundation), the pulse source name, `hw:c,d` (alsa), the dshow name. */
  id: string;
  /** Which capture backend the entry came from. */
  backend: 'avfoundation' | 'pulse' | 'alsa' | 'dshow';
}

/**
 * Parse `ffmpeg -f avfoundation -list_devices true -i ""` (stderr). Only the
 * block after "AVFoundation audio devices:" counts; video devices are skipped.
 */
export function parseAvfoundationDevices(output: string): AudioDevice[] {
  const devices: AudioDevice[] = [];
  let inAudio = false;
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.replace(/^\[AVFoundation[^\]]*\]\s*/, '').trim();
    if (/^AVFoundation audio devices:/i.test(line)) {
      inAudio = true;
      continue;
    }
    if (/^AVFoundation video devices:/i.test(line)) {
      inAudio = false;
      continue;
    }
    if (!inAudio) continue;
    const m = /^\[(\d+)\]\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const index = Number(m[1]);
    devices.push({ index, name: m[2], id: `:${index}`, backend: 'avfoundation' });
  }
  return devices;
}

/**
 * Parse `ffmpeg -sources pulse`: lines of `  name [description]` (a leading
 * `*` marks the default source). Monitor sources (loopback of an output) are
 * skipped, they are not microphones.
 */
export function parsePulseSources(output: string): AudioDevice[] {
  const devices: AudioDevice[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const m = /^\s*\*?\s*(\S+)\s+\[(.*)\]\s*$/.exec(raw);
    if (!m) continue;
    const id = m[1];
    if (/\.monitor$/.test(id) || /Monitor of/i.test(m[2])) continue;
    devices.push({ index: devices.length, name: m[2] || id, id, backend: 'pulse' });
  }
  return devices;
}

/** Parse `arecord -l`: `card 1: Device [USB Audio], device 0: USB Audio [USB Audio]` -> `hw:1,0`. */
export function parseArecordList(output: string): AudioDevice[] {
  const devices: AudioDevice[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const m = /^card (\d+): (\S+) \[(.*?)\], device (\d+): .*?\[(.*?)\]/.exec(raw);
    if (!m) continue;
    const card = Number(m[1]);
    devices.push({ index: card, name: `${m[3]} (${m[5]})`, id: `hw:${card},${m[4]}`, backend: 'alsa' });
  }
  return devices;
}

/**
 * Parse `ffmpeg -f dshow -list_devices true -i dummy` (stderr). Modern ffmpeg
 * prints `"Name" (audio)` per line; older builds print a "DirectShow audio
 * devices" header followed by `"Name"` lines. Both are handled.
 */
export function parseDshowDevices(output: string): AudioDevice[] {
  const devices: AudioDevice[] = [];
  let section: 'video' | 'audio' | undefined;
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.replace(/^\[dshow[^\]]*\]\s*/, '').trim();
    if (/^DirectShow video devices/i.test(line)) {
      section = 'video';
      continue;
    }
    if (/^DirectShow audio devices/i.test(line)) {
      section = 'audio';
      continue;
    }
    if (/^Alternative name/i.test(line)) continue;
    const tagged = /^"(.+)"\s+\((audio|video)\)\s*$/.exec(line);
    if (tagged) {
      if (tagged[2] === 'audio') devices.push({ index: devices.length, name: tagged[1], id: tagged[1], backend: 'dshow' });
      continue;
    }
    const bare = /^"(.+)"\s*$/.exec(line);
    if (bare && section === 'audio') devices.push({ index: devices.length, name: bare[1], id: bare[1], backend: 'dshow' });
  }
  return devices;
}

/** Match `--device <name|index>` against a device list (index, exact name, then case-insensitive substring). */
export function pickDevice(devices: readonly AudioDevice[], selector: string): AudioDevice | undefined {
  const trimmed = selector.trim();
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    return devices.find((d) => d.index === n);
  }
  const lower = trimmed.toLowerCase();
  return (
    devices.find((d) => d.name === trimmed || d.id === trimmed) ??
    devices.find((d) => d.name.toLowerCase() === lower) ??
    devices.find((d) => d.name.toLowerCase().includes(lower))
  );
}

export interface ListDevicesOptions {
  platform: NodeJS.Platform;
  ffmpeg: string;
  exec: VoiceExec;
}

/**
 * List audio input devices for this platform. ffmpeg exits non-zero after
 * listing on every platform (there is no real input), so the exit code is
 * ignored and only the parsed text matters.
 */
export async function listAudioDevices(opts: ListDevicesOptions): Promise<AudioDevice[]> {
  const { platform, ffmpeg, exec } = opts;
  switch (platform) {
    case 'darwin': {
      const r = await exec(ffmpeg, ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''], { timeoutMs: 10_000 });
      return parseAvfoundationDevices(`${r.stderr}\n${r.stdout}`);
    }
    case 'win32': {
      const r = await exec(ffmpeg, ['-hide_banner', '-f', 'dshow', '-list_devices', 'true', '-i', 'dummy'], { timeoutMs: 10_000 });
      return parseDshowDevices(`${r.stderr}\n${r.stdout}`);
    }
    default: {
      const pulse = await exec(ffmpeg, ['-hide_banner', '-sources', 'pulse'], { timeoutMs: 10_000 });
      const fromPulse = pulse.code === 0 ? parsePulseSources(pulse.stdout) : [];
      if (fromPulse.length > 0) return fromPulse;
      try {
        const alsa = await exec('arecord', ['-l'], { timeoutMs: 10_000 });
        return parseArecordList(alsa.stdout);
      } catch {
        return [];
      }
    }
  }
}

export function formatDeviceList(devices: readonly AudioDevice[]): string {
  if (devices.length === 0) return 'no audio input devices found\n';
  const width = Math.max(...devices.map((d) => String(d.index).length));
  return devices.map((d) => `[${String(d.index).padStart(width)}] ${d.name}${d.id !== `:${d.index}` && d.id !== d.name ? `  (${d.id})` : ''}`).join('\n') + '\n';
}
