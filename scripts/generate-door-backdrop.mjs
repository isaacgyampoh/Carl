/**
 * Draws the image that sits behind every door screen (owner PIN, business door, till door,
 * till finder, email sign-in) and writes it to apps/web/public/door-backdrop.png.
 *
 * Why a file and not CSS: the doors are the first thing a shopkeeper sees of software they pay
 * for, and a browser-drawn wash reads as an unstyled page on a bright shop floor. Why generated
 * and not photographed: a photograph of someone else's shop would be a lie about this one, and
 * a licensed stock image is weight and paperwork. This is a lit field in Carl's own colours.
 *
 * Why it is small: 600x400, and soft everywhere. A field with no edge in it survives being
 * stretched across a 27-inch counter screen — the browser's own interpolation is doing the same
 * smoothing the picture is made of, which is also why it needs no dithering to avoid banding.
 * A shop on a slow connection pays about 80 KB for the whole thing, once.
 *
 * Run with: node scripts/generate-door-backdrop.mjs
 * No dependencies — PNG is deflate plus a header, and Node has both.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const WIDTH = 600;
const HEIGHT = 400;
const OUT = fileURLToPath(new URL('../apps/web/public/door-backdrop.png', import.meta.url));

/* ── colour ──────────────────────────────────────────────────────────────────────────────── */

/** oklch to linear sRGB, so the palette here can be copied from globals.css unchanged. */
function oklch(l, c, hDeg) {
  const h = (hDeg * Math.PI) / 180;
  const a = c * Math.cos(h);
  const b = c * Math.sin(h);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
}

/** Linear light to sRGB, the transfer curve a screen expects. */
const encode = (v) =>
  v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(Math.max(v, 0), 1 / 2.4) - 0.055;

/* ── the field ───────────────────────────────────────────────────────────────────────────── */

/*
 * A night-navy ground with light laid over it, kept dark and low in chroma on purpose: this is
 * the backing behind a white card, not a picture in its own right. Carl's brand blue falls from
 * the top left the way a window falls across a counter, the green of a completed sale answers it
 * from the far corner, and one wide beam crosses the middle so the field has a direction.
 * Positions are fractions of the canvas; radius is a fraction of its width.
 */
const GROUND = oklch(0.145, 0.03, 262);
const LIGHTS = [
  { x: 0.12, y: -0.04, r: 0.92, strength: 0.62, colour: oklch(0.5, 0.15, 258) },
  { x: 1.0, y: 1.06, r: 0.8, strength: 0.34, colour: oklch(0.52, 0.11, 162) },
  { x: 0.52, y: 0.38, r: 0.62, strength: 0.1, colour: oklch(0.62, 0.09, 250) },
];
/** One soft shaft across the field: angle from the horizontal, and how wide it reads. */
const BEAM = {
  angle: 34,
  offset: 0.46,
  width: 0.3,
  strength: 0.075,
  colour: oklch(0.8, 0.04, 250),
};
/** How much darker the corners go than the middle: the card should sit in the light. */
const VIGNETTE = 0.5;

/** Smooth both ends, so a light has no visible edge where it runs out. */
const falloff = (t) => {
  const s = Math.min(Math.max(1 - t, 0), 1);
  return s * s * (3 - 2 * s);
};

const stride = WIDTH * 3 + 1;
const raw = Buffer.alloc(stride * HEIGHT);
const aspect = WIDTH / HEIGHT;

for (let py = 0; py < HEIGHT; py += 1) {
  const v = py / (HEIGHT - 1);
  raw[py * stride] = 0; // PNG filter: none. The field is smooth; deflate does the work.
  for (let px = 0; px < WIDTH; px += 1) {
    const u = px / (WIDTH - 1);
    const rgb = [GROUND[0], GROUND[1], GROUND[2]];

    for (const light of LIGHTS) {
      const dx = (u - light.x) * aspect;
      const dy = v - light.y;
      const amount = falloff(Math.hypot(dx, dy) / (light.r * aspect)) * light.strength;
      if (amount <= 0) continue;
      for (let i = 0; i < 3; i += 1) rgb[i] += light.colour[i] * amount;
    }

    // The shaft: distance to a line, faded smoothly on both sides of it.
    const theta = (BEAM.angle * Math.PI) / 180;
    const along = Math.abs(u * Math.sin(theta) + v * Math.cos(theta) - BEAM.offset);
    const beam = falloff(along / BEAM.width) * BEAM.strength;
    for (let i = 0; i < 3; i += 1) rgb[i] += BEAM.colour[i] * beam;

    // Corners fall away from the centre, which is where the card sits.
    const cx = (u - 0.5) * aspect;
    const cy = v - 0.5;
    const shade = 1 - VIGNETTE * Math.min(Math.hypot(cx, cy) / (0.5 * aspect), 1) ** 2;

    const o = py * stride + 1 + px * 3;
    for (let i = 0; i < 3; i += 1) {
      raw[o + i] = Math.round(Math.min(Math.max(encode(rgb[i] * shade), 0), 1) * 255);
    }
  }
}

/* ── PNG ─────────────────────────────────────────────────────────────────────────────────── */

const chunk = (type, body) => {
  const out = Buffer.alloc(body.length + 12);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, 'ascii');
  body.copy(out, 8);
  out.writeUInt32BE(crc(out.subarray(4, 8 + body.length)), 8 + body.length);
  return out;
};

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(WIDTH, 0);
ihdr.writeUInt32BE(HEIGHT, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 2; // truecolour
writeFileSync(
  OUT,
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]),
);
console.log(`${OUT} — ${WIDTH}x${HEIGHT}`);
