// Generates the requirement pet's pixel sprite animations programmatically (as placeholders). No
// dependencies: it carries its own GIF89a encoder, LZW, transparency and looping included.
//   Run: ./forge-gen, or node --experimental-strip-types tools/gen-pet-sprites.ts
//   Output: assets/pet/<stage>.gif -- 16x16 pixels scaled up by SCALE, a few frames of idle animation
// The design: each pet is one 16x16 character grid, whose characters index the palette, plus a few frames
// that shift it vertically in output pixels (oy) and overlay individual logical cells.
//   The art is data: changing how a pet looks means editing GRID and FRAMES, never the encoder.
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = resolve(ROOT, 'assets/pet');
const SCALE = 8; // 16px → 128px
const DELAY_CS = 14; // 0.14s per frame

// -- The palette (16 colours at most, index 0 being transparent). Change the theme colours here and nowhere else. --
const PAL: Record<string, [number, number, number] | null> = {
  '.': null, // transparent
  K: [38, 30, 22], // the outline
  W: [255, 255, 255], // white, for highlights and the glint in an eye
  Y: [255, 209, 64], // chick yellow
  D: [228, 162, 0], // the yellow shadow
  O: [255, 138, 28], // orange, for the beak and feet
  S: [253, 243, 223], // eggshell
  d: [231, 215, 178], // the eggshell shadow and its cracks
  R: [231, 76, 60], // the red comb
  P: [168, 124, 232], // purple, the final form's body
  p: [219, 197, 255], // the pale purple highlight
  M: [255, 94, 145], // pink
  C: [142, 202, 230], // cyan, for the sparkle
  G: [255, 214, 0], // gold, for the horn
};
const CHARS = Object.keys(PAL);
const IDX: Record<string, number> = {};
CHARS.forEach((c, i) => (IDX[c] = i));

type Overlay = [number, number, string][]; // [row, col, char]
interface Frame {
  oy: number; // a vertical shift in output pixels, for breathing and bouncing
  ov?: Overlay; // overlays over individual logical cells, for blinking, wings and sparkle
}
interface Sprite {
  grid: string[]; // 16 rows by 16 columns
  frames: Frame[];
}

const BOB: number[] = [0, -4, -6, -4]; // a gentle four-frame bounce, in output pixels

// 🥚 the egg, rocking gently
const EGG: Sprite = {
  grid: [
    '................',
    '................',
    '......KKKK......',
    '.....KSSSSK.....',
    '....KSSSSSSK....',
    '....KSdSSSSK....',
    '...KSSSSSSSSK...',
    '...KSSSSdSSSK...',
    '...KSSSSSSSSK...',
    '...KSSSSSSSSK...',
    '...KSdSSSSSSK...',
    '....KSSSSSSK....',
    '....KSSSSSSK....',
    '.....KKKKKK.....',
    '................',
    '................',
  ],
  frames: BOB.map((oy) => ({ oy })),
};

// 🐣 hatching: the chick's head pokes out of a cracked shell, with a small bounce
const HATCH: Sprite = {
  grid: [
    '................',
    '......KKKK......',
    '.....KYYYYK.....',
    '....KYKYYKYK....',
    '....KYYOOYYK....',
    '....KYYYYYYK....',
    '...KdSSSSSSdK...',
    '...KSdSdSdSSK...',
    '...KSSSSSSSSK...',
    '...KSSSSSSSSK...',
    '....KSSSSSSK....',
    '.....KKKKKK.....',
    '................',
    '................',
    '................',
    '................',
  ],
  frames: BOB.map((oy) => ({ oy })),
};

// 🐤 the chick, bouncing and blinking
const CHICK: Sprite = {
  grid: [
    '................',
    '......KKKK......',
    '.....KYYYYK.....',
    '....KYYYYYYK....',
    '....KYKYYKYK....',
    '....KYYOOYYK....',
    '....KYYYYYYK....',
    '....KYYYYYYK....',
    '.....KYYYYK.....',
    '......KKKK......',
    '......O..O......',
    '.....OO..OO.....',
    '................',
    '................',
    '................',
    '................',
  ],
  // The blink on frame 3: clear the K from both eyes, turning them back to body yellow.
  frames: [
    { oy: BOB[0] },
    { oy: BOB[1] },
    { oy: BOB[2], ov: [[4, 6, 'Y'], [4, 9, 'Y']] },
    { oy: BOB[3] },
  ],
};

// 🐔 the grown bird with its red comb, bouncing as the comb sways
const BIRD: Sprite = {
  grid: [
    '.......RR.......',
    '......KRRK......',
    '.....KYYYYK.....',
    '....KYKYYKYK....',
    '....KYYOOYYK....',
    '...KYYYYYYYYK...',
    '...KYYYYYYYYK...',
    '..KWYYYYYYYYK...',
    '...KYYYYYYYYK...',
    '....KYYYYYYK....',
    '.....KKKKKK.....',
    '......O..O......',
    '.....OO..OO.....',
    '................',
    '................',
    '................',
  ],
  // The wing (W) flaps: on frames 2 and 4 the white left wing moves up one cell.
  frames: [
    { oy: BOB[0] },
    { oy: BOB[1], ov: [[7, 2, '.'], [6, 2, 'W']] },
    { oy: BOB[2] },
    { oy: BOB[3], ov: [[7, 2, '.'], [6, 2, 'W']] },
  ],
};

// 🦄 the final form, purple with a gold horn, bouncing as four sparkles rotate around it
const FINAL: Sprite = {
  grid: [
    '.......G........',
    '......KGK.......',
    '......KPK.......',
    '.....KPPPK......',
    '....KPPPPPK.....',
    '....KPKPPKPK....',
    '....KPPMPPPK....',
    '...KPPPPPPPPK...',
    '...KPpPPPPpPK...',
    '...KPPPPPPPPK...',
    '....KPPPPPPK....',
    '.....KPPPPK.....',
    '......KKKK......',
    '......P..P......',
    '.....PP..PP.....',
    '................',
  ],
  // The sparkle moves to a different position each frame.
  frames: [
    { oy: BOB[0], ov: [[2, 2, 'C']] },
    { oy: BOB[1], ov: [[4, 13, 'W']] },
    { oy: BOB[2], ov: [[9, 1, 'C']] },
    { oy: BOB[3], ov: [[6, 14, 'W']] },
  ],
};

const SPRITES: Record<string, Sprite> = { egg: EGG, hatch: HATCH, chick: CHICK, bird: BIRD, final: FINAL };

// -- Render one frame of a sprite into a palette-index buffer at the output resolution (0 = transparent). --
function renderFrame(sp: Sprite, f: Frame, W: number, H: number): Uint8Array {
  const buf = new Uint8Array(W * H); // 0 by default, which is transparent
  const cells: Record<string, string> = {};
  if (f.ov) for (const [r, c, ch] of f.ov) cells[`${r},${c}`] = ch;
  for (let r = 0; r < 16; r++) {
    const row = sp.grid[r];
    for (let c = 0; c < 16; c++) {
      const ch = cells[`${r},${c}`] ?? row[c];
      if (ch === '.' || ch === undefined) continue;
      const pi = IDX[ch];
      if (pi == null) continue;
      for (let dy = 0; dy < SCALE; dy++) {
        const y = r * SCALE + dy + f.oy;
        if (y < 0 || y >= H) continue;
        for (let dx = 0; dx < SCALE; dx++) {
          const x = c * SCALE + dx;
          buf[y * W + x] = pi;
        }
      }
    }
  }
  return buf;
}

// -- The GIF89a encoder: a global colour table, per-frame transparency, and looping forever. The LZW stream
// is the uncompressed kind -- fixed-width codes with a periodic clear -- which keeps decoding unambiguous. --
function lzw(minCodeSize: number, indices: Uint8Array): number[] {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  const codeSize = minCodeSize + 1;
  const maxBeforeClear = clear - 2; // clear early, so the code width never has to grow
  const out: number[] = [];
  let cur = 0;
  let bits = 0;
  const put = (code: number) => {
    cur |= code << bits;
    bits += codeSize;
    while (bits >= 8) {
      out.push(cur & 0xff);
      cur >>= 8;
      bits -= 8;
    }
  };
  put(clear);
  let since = 0;
  for (let i = 0; i < indices.length; i++) {
    put(indices[i]);
    if (++since >= maxBeforeClear) {
      put(clear);
      since = 0;
    }
  }
  put(eoi);
  if (bits > 0) out.push(cur & 0xff);
  return out;
}

function u16(n: number): [number, number] {
  return [n & 0xff, (n >> 8) & 0xff];
}

function encodeGif(W: number, H: number, frames: Uint8Array[], delayCs: number): Buffer {
  const b: number[] = [];
  // Header + Logical Screen Descriptor
  for (const ch of 'GIF89a') b.push(ch.charCodeAt(0));
  b.push(...u16(W), ...u16(H));
  b.push(0xf3, 0x00, 0x00); // GCT flag, colorRes 7, 16 colours; bg=0; aspect=0
  // The global colour table: 16 entries of 3 bytes each, padded with black.
  for (let i = 0; i < 16; i++) {
    const col = PAL[CHARS[i]] ?? [0, 0, 0];
    b.push(col[0], col[1], col[2]);
  }
  // The NETSCAPE2.0 block, which makes it loop forever.
  b.push(0x21, 0xff, 0x0b);
  for (const ch of 'NETSCAPE2.0') b.push(ch.charCodeAt(0));
  b.push(0x03, 0x01, ...u16(0), 0x00);
  // Frame by frame.
  for (const frame of frames) {
    b.push(0x21, 0xf9, 0x04, 0x09, ...u16(delayCs), 0x00, 0x00); // GCE: disposal=2, transparent=index0
    b.push(0x2c, ...u16(0), ...u16(0), ...u16(W), ...u16(H), 0x00); // Image Descriptor
    b.push(4); // minCodeSize
    const data = lzw(4, frame);
    for (let i = 0; i < data.length; i += 255) {
      const chunk = data.slice(i, i + 255);
      b.push(chunk.length, ...chunk);
    }
    b.push(0x00); // block terminator
  }
  b.push(0x3b); // trailer
  return Buffer.from(b);
}

// ── main ──
mkdirSync(OUT_DIR, { recursive: true });
const W = 16 * SCALE;
const H = 16 * SCALE;
for (const [name, sp] of Object.entries(SPRITES)) {
  const frames = sp.frames.map((f) => renderFrame(sp, f, W, H));
  const gif = encodeGif(W, H, frames, DELAY_CS);
  const path = resolve(OUT_DIR, `${name}.gif`);
  writeFileSync(path, gif);
  console.log(`✓ ${name}.gif  ${W}x${H}  ${sp.frames.length} frames  ${(gif.length / 1024).toFixed(1)}KB`);
}
console.log(`\noutput directory: ${OUT_DIR}`);
