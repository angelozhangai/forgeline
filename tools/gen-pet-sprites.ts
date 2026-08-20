// 程序化生成「需求宠物」像素 sprite 动图（占位）。零依赖：自带 GIF89a 编码器（含 LZW + 透明 + 无限循环）。
//   跑：./forge-gen  或  node --experimental-strip-types tools/gen-pet-sprites.ts
//   出：assets/pet/<stage>.gif（16×16 像素 → 放大 SCALE 倍，几帧待机动效）
// 设计：每只宠物 = 一张 16×16 字符网格（调色板 char）+ 若干帧（输出像素级 y 抖动 oy + 逻辑格 overlay）。
//   art 即数据，改样子只动 GRID/FRAMES，不碰编码器。
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = resolve(ROOT, 'assets/pet');
const SCALE = 8; // 16px → 128px
const DELAY_CS = 14; // 每帧 0.14s

// ── 调色板（≤16 色，index0 = 透明）。改主题色只动这里。 ──
const PAL: Record<string, [number, number, number] | null> = {
  '.': null, // 透明
  K: [38, 30, 22], // 描边
  W: [255, 255, 255], // 白（高光/眼神光）
  Y: [255, 209, 64], // 雏鸡黄
  D: [228, 162, 0], // 黄阴影
  O: [255, 138, 28], // 橙（喙/脚）
  S: [253, 243, 223], // 蛋壳
  d: [231, 215, 178], // 蛋壳阴影/裂纹
  R: [231, 76, 60], // 红冠
  P: [168, 124, 232], // 紫（完全体身）
  p: [219, 197, 255], // 浅紫高光
  M: [255, 94, 145], // 粉
  C: [142, 202, 230], // 青（星光）
  G: [255, 214, 0], // 金（角）
};
const CHARS = Object.keys(PAL);
const IDX: Record<string, number> = {};
CHARS.forEach((c, i) => (IDX[c] = i));

type Overlay = [number, number, string][]; // [row, col, char]
interface Frame {
  oy: number; // 输出像素级竖直抖动（呼吸/弹跳）
  ov?: Overlay; // 覆盖若干逻辑格（眨眼/翅膀/星光）
}
interface Sprite {
  grid: string[]; // 16 行 × 16 列
  frames: Frame[];
}

const BOB: number[] = [0, -4, -6, -4]; // 4 帧轻弹跳（输出像素）

// 🥚 蛋（轻摇）
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

// 🐣 破壳（雏鸡头探出 + 裂纹蛋壳，轻弹）
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

// 🐤 雏鸡（弹跳 + 眨眼）
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
  // 第 3 帧眨眼：抹掉两只眼的 K（变回身体黄）
  frames: [
    { oy: BOB[0] },
    { oy: BOB[1] },
    { oy: BOB[2], ov: [[4, 6, 'Y'], [4, 9, 'Y']] },
    { oy: BOB[3] },
  ],
};

// 🐔 成鸟（红冠，弹跳 + 冠子轻摆）
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
  // 翅膀(W)上下扇动：第2/4帧把左侧白翅往上挪一格
  frames: [
    { oy: BOB[0] },
    { oy: BOB[1], ov: [[7, 2, '.'], [6, 2, 'W']] },
    { oy: BOB[2] },
    { oy: BOB[3], ov: [[7, 2, '.'], [6, 2, 'W']] },
  ],
};

// 🦄 完全体（紫身金角，弹跳 + 四角星光轮转）
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
  // 星光每帧换位置闪烁
  frames: [
    { oy: BOB[0], ov: [[2, 2, 'C']] },
    { oy: BOB[1], ov: [[4, 13, 'W']] },
    { oy: BOB[2], ov: [[9, 1, 'C']] },
    { oy: BOB[3], ov: [[6, 14, 'W']] },
  ],
};

const SPRITES: Record<string, Sprite> = { egg: EGG, hatch: HATCH, chick: CHICK, bird: BIRD, final: FINAL };

// ── 把 sprite 一帧渲染成输出分辨率的调色板索引缓冲（透明=0）。 ──
function renderFrame(sp: Sprite, f: Frame, W: number, H: number): Uint8Array {
  const buf = new Uint8Array(W * H); // 默认 0 = 透明
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

// ── GIF89a 编码器（全局调色板 + 逐帧透明 + 无限循环）。LZW 用「免压缩」流（定长码 + 周期 clear），保证解码无歧义。 ──
function lzw(minCodeSize: number, indices: Uint8Array): number[] {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  const codeSize = minCodeSize + 1;
  const maxBeforeClear = clear - 2; // 提前 clear，杜绝码长增长
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
  b.push(0xf3, 0x00, 0x00); // GCT flag, colorRes7, 16色; bg=0; aspect=0
  // Global Color Table（16 项 × 3 字节，不足补黑）
  for (let i = 0; i < 16; i++) {
    const col = PAL[CHARS[i]] ?? [0, 0, 0];
    b.push(col[0], col[1], col[2]);
  }
  // NETSCAPE2.0 无限循环
  b.push(0x21, 0xff, 0x0b);
  for (const ch of 'NETSCAPE2.0') b.push(ch.charCodeAt(0));
  b.push(0x03, 0x01, ...u16(0), 0x00);
  // 逐帧
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
  console.log(`✓ ${name}.gif  ${W}×${H}  ${sp.frames.length}帧  ${(gif.length / 1024).toFixed(1)}KB`);
}
console.log(`\n输出目录：${OUT_DIR}`);
