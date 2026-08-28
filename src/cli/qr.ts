/**
 * A QR encoder, byte mode, error-correction level M, versions 1 to 10.
 *
 * Narrow on purpose. The only thing this ever encodes is a pairing URL of
 * about eighty characters, which fits comfortably inside version 6, and the
 * alternative was a runtime dependency in a published package for the sake of
 * one line of terminal output.
 *
 * Level M corrects around 15% of the symbol, which is what makes a code
 * scannable off a terminal where the font, the colours and the camera angle
 * are all somebody else's choice.
 *
 * The tables below are from ISO/IEC 18004. `qr.test.ts` pins the output
 * against codes produced by an independent implementation and decoded back to
 * their original text, because a QR encoder that is subtly wrong produces
 * something that still looks exactly like a QR code.
 */

/** Data codewords, EC codewords per block, and the block layout, per version. */
interface VersionSpec {
  ecCodewordsPerBlock: number;
  group1Blocks: number;
  group1DataCodewords: number;
  group2Blocks: number;
  group2DataCodewords: number;
}

const VERSIONS: Record<number, VersionSpec> = {
  1: { ecCodewordsPerBlock: 10, group1Blocks: 1, group1DataCodewords: 16, group2Blocks: 0, group2DataCodewords: 0 },
  2: { ecCodewordsPerBlock: 16, group1Blocks: 1, group1DataCodewords: 28, group2Blocks: 0, group2DataCodewords: 0 },
  3: { ecCodewordsPerBlock: 26, group1Blocks: 1, group1DataCodewords: 44, group2Blocks: 0, group2DataCodewords: 0 },
  4: { ecCodewordsPerBlock: 18, group1Blocks: 2, group1DataCodewords: 32, group2Blocks: 0, group2DataCodewords: 0 },
  5: { ecCodewordsPerBlock: 24, group1Blocks: 2, group1DataCodewords: 43, group2Blocks: 0, group2DataCodewords: 0 },
  6: { ecCodewordsPerBlock: 16, group1Blocks: 4, group1DataCodewords: 27, group2Blocks: 0, group2DataCodewords: 0 },
  7: { ecCodewordsPerBlock: 18, group1Blocks: 4, group1DataCodewords: 31, group2Blocks: 0, group2DataCodewords: 0 },
  8: { ecCodewordsPerBlock: 22, group1Blocks: 2, group1DataCodewords: 38, group2Blocks: 2, group2DataCodewords: 39 },
  9: { ecCodewordsPerBlock: 22, group1Blocks: 3, group1DataCodewords: 36, group2Blocks: 2, group2DataCodewords: 37 },
  10: { ecCodewordsPerBlock: 26, group1Blocks: 4, group1DataCodewords: 43, group2Blocks: 1, group2DataCodewords: 44 },
};

/** Row and column centres of the alignment patterns, per version. */
const ALIGNMENT_CENTRES: Record<number, number[]> = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
};

const MAX_VERSION = 10;

export class QrTooLongError extends Error {}

function dataCodewords(spec: VersionSpec): number {
  return spec.group1Blocks * spec.group1DataCodewords + spec.group2Blocks * spec.group2DataCodewords;
}

/** 8 bits of character count up to version 9, 16 from version 10. */
function countBits(version: number): number {
  return version < 10 ? 8 : 16;
}

function chooseVersion(byteLength: number): number {
  for (let version = 1; version <= MAX_VERSION; version += 1) {
    const capacityBits = dataCodewords(VERSIONS[version]) * 8;
    if (4 + countBits(version) + byteLength * 8 <= capacityBits) return version;
  }
  throw new QrTooLongError(`${byteLength} bytes does not fit in a version ${MAX_VERSION} code`);
}

class BitBuffer {
  readonly bits: number[] = [];

  push(value: number, length: number): void {
    for (let index = length - 1; index >= 0; index -= 1) this.bits.push((value >>> index) & 1);
  }

  get length(): number {
    return this.bits.length;
  }
}

// GF(256) with the QR primitive polynomial, as log/antilog tables so the
// Reed-Solomon multiply below is an addition.
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let value = 1;
  for (let index = 0; index < 255; index += 1) {
    EXP[index] = value;
    LOG[value] = index;
    value <<= 1;
    if (value & 0x100) value ^= 0x11d;
  }
  for (let index = 255; index < 512; index += 1) EXP[index] = EXP[index - 255];
}

function multiply(a: number, b: number): number {
  return a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]];
}

/** The generator polynomial for `degree` error-correction codewords. */
function generatorPolynomial(degree: number): number[] {
  let polynomial = [1];
  for (let index = 0; index < degree; index += 1) {
    const next = new Array<number>(polynomial.length + 1).fill(0);
    for (let term = 0; term < polynomial.length; term += 1) {
      next[term] ^= polynomial[term];
      next[term + 1] ^= multiply(polynomial[term], EXP[index]);
    }
    polynomial = next;
  }
  return polynomial;
}

function errorCorrection(block: number[], ecLength: number): number[] {
  const generator = generatorPolynomial(ecLength);
  const remainder = new Array<number>(ecLength).fill(0);
  for (const codeword of block) {
    const factor = codeword ^ remainder[0];
    remainder.shift();
    remainder.push(0);
    for (let index = 0; index < ecLength; index += 1) {
      remainder[index] ^= multiply(generator[index + 1], factor);
    }
  }
  return remainder;
}

/** Mode indicator, length, payload, terminator and padding, as codewords. */
function encodeData(bytes: Uint8Array, version: number): number[] {
  const spec = VERSIONS[version];
  const capacity = dataCodewords(spec);
  const buffer = new BitBuffer();
  buffer.push(0b0100, 4);
  buffer.push(bytes.length, countBits(version));
  for (const byte of bytes) buffer.push(byte, 8);

  const capacityBits = capacity * 8;
  buffer.push(0, Math.min(4, capacityBits - buffer.length));
  while (buffer.length % 8 !== 0) buffer.push(0, 1);

  const codewords: number[] = [];
  for (let index = 0; index < buffer.length; index += 8) {
    let byte = 0;
    for (let bit = 0; bit < 8; bit += 1) byte = (byte << 1) | buffer.bits[index + bit];
    codewords.push(byte);
  }
  // The two pad codewords the standard names, alternating.
  const pads = [0xec, 0x11];
  for (let index = 0; codewords.length < capacity; index += 1) codewords.push(pads[index % 2]);
  return codewords;
}

/** Splits into blocks, appends their EC codewords, and interleaves both. */
function interleave(codewords: number[], version: number): number[] {
  const spec = VERSIONS[version];
  const blocks: number[][] = [];
  const ecBlocks: number[][] = [];
  let offset = 0;
  const layout = [
    ...Array.from({ length: spec.group1Blocks }, () => spec.group1DataCodewords),
    ...Array.from({ length: spec.group2Blocks }, () => spec.group2DataCodewords),
  ];
  for (const size of layout) {
    const block = codewords.slice(offset, offset + size);
    offset += size;
    blocks.push(block);
    ecBlocks.push(errorCorrection(block, spec.ecCodewordsPerBlock));
  }

  const result: number[] = [];
  const longest = Math.max(...layout);
  for (let index = 0; index < longest; index += 1) {
    for (const block of blocks) if (index < block.length) result.push(block[index]);
  }
  for (let index = 0; index < spec.ecCodewordsPerBlock; index += 1) {
    for (const block of ecBlocks) result.push(block[index]);
  }
  return result;
}

type Cell = boolean | null;

function size(version: number): number {
  return version * 4 + 17;
}

function placeFinder(grid: Cell[][], row: number, column: number): void {
  for (let deltaRow = -1; deltaRow <= 7; deltaRow += 1) {
    for (let deltaColumn = -1; deltaColumn <= 7; deltaColumn += 1) {
      const r = row + deltaRow;
      const c = column + deltaColumn;
      if (r < 0 || c < 0 || r >= grid.length || c >= grid.length) continue;
      const inRing = deltaRow === 0 || deltaRow === 6 || deltaColumn === 0 || deltaColumn === 6;
      const inCore = deltaRow >= 2 && deltaRow <= 4 && deltaColumn >= 2 && deltaColumn <= 4;
      const inside = deltaRow >= 0 && deltaRow <= 6 && deltaColumn >= 0 && deltaColumn <= 6;
      grid[r][c] = inside && (inRing || inCore);
    }
  }
}

function placeFunctionPatterns(version: number): { grid: Cell[][]; reserved: boolean[][] } {
  const dimension = size(version);
  const grid: Cell[][] = Array.from({ length: dimension }, () => new Array<Cell>(dimension).fill(null));

  placeFinder(grid, 0, 0);
  placeFinder(grid, 0, dimension - 7);
  placeFinder(grid, dimension - 7, 0);

  for (let index = 8; index < dimension - 8; index += 1) {
    const dark = index % 2 === 0;
    grid[6][index] = dark;
    grid[index][6] = dark;
  }

  const centres = ALIGNMENT_CENTRES[version];
  for (const row of centres) {
    for (const column of centres) {
      // Not over the finder patterns in the three corners.
      if ((row === 6 && column === 6)
        || (row === 6 && column === dimension - 7)
        || (row === dimension - 7 && column === 6)) continue;
      for (let deltaRow = -2; deltaRow <= 2; deltaRow += 1) {
        for (let deltaColumn = -2; deltaColumn <= 2; deltaColumn += 1) {
          const ring = Math.max(Math.abs(deltaRow), Math.abs(deltaColumn));
          grid[row + deltaRow][column + deltaColumn] = ring !== 1;
        }
      }
    }
  }

  // The one module that is always dark.
  grid[dimension - 8][8] = true;

  const reserved: boolean[][] = Array.from({ length: dimension }, () => new Array<boolean>(dimension).fill(false));
  for (let row = 0; row < dimension; row += 1) {
    for (let column = 0; column < dimension; column += 1) {
      if (grid[row][column] !== null) reserved[row][column] = true;
    }
  }
  // Format information, which is written after masking.
  for (let index = 0; index < 9; index += 1) {
    reserved[8][index] = true;
    reserved[index][8] = true;
  }
  for (let index = 0; index < 8; index += 1) {
    reserved[8][dimension - 1 - index] = true;
    reserved[dimension - 1 - index][8] = true;
  }
  if (version >= 7) {
    for (let index = 0; index < 6; index += 1) {
      for (let offset = 0; offset < 3; offset += 1) {
        reserved[index][dimension - 11 + offset] = true;
        reserved[dimension - 11 + offset][index] = true;
      }
    }
  }
  return { grid, reserved };
}

/** Up the right-hand column pair, then down the next, skipping column 6. */
function placeData(grid: Cell[][], reserved: boolean[][], codewords: number[]): void {
  const dimension = grid.length;
  const bits: number[] = [];
  for (const codeword of codewords) {
    for (let index = 7; index >= 0; index -= 1) bits.push((codeword >>> index) & 1);
  }

  let bitIndex = 0;
  let upward = true;
  for (let right = dimension - 1; right >= 1; right -= 2) {
    const column = right <= 6 ? right - 1 : right;
    for (let step = 0; step < dimension; step += 1) {
      const row = upward ? dimension - 1 - step : step;
      for (const offset of [0, 1]) {
        const target = column - offset;
        if (reserved[row][target]) continue;
        grid[row][target] = bitIndex < bits.length ? bits[bitIndex] === 1 : false;
        bitIndex += 1;
      }
    }
    upward = !upward;
  }
}

const MASKS: Array<(row: number, column: number) => boolean> = [
  (row, column) => (row + column) % 2 === 0,
  (row) => row % 2 === 0,
  (_row, column) => column % 3 === 0,
  (row, column) => (row + column) % 3 === 0,
  (row, column) => (Math.floor(row / 2) + Math.floor(column / 3)) % 2 === 0,
  (row, column) => ((row * column) % 2) + ((row * column) % 3) === 0,
  (row, column) => (((row * column) % 2) + ((row * column) % 3)) % 2 === 0,
  (row, column) => (((row + column) % 2) + ((row * column) % 3)) % 2 === 0,
];

function applyMask(grid: Cell[][], reserved: boolean[][], mask: number): boolean[][] {
  return grid.map((row, rowIndex) => row.map((cell, columnIndex) => {
    const value = cell === true;
    if (reserved[rowIndex][columnIndex]) return value;
    return MASKS[mask](rowIndex, columnIndex) ? !value : value;
  }));
}

function runPenalty(line: boolean[]): number {
  let penalty = 0;
  let runLength = 1;
  for (let index = 1; index < line.length; index += 1) {
    if (line[index] === line[index - 1]) {
      runLength += 1;
      if (runLength === 5) penalty += 3;
      else if (runLength > 5) penalty += 1;
    } else runLength = 1;
  }
  return penalty;
}

/** The four penalty rules, which together decide which mask reads best. */
export function penalty(modules: boolean[][]): number {
  const dimension = modules.length;
  let total = 0;

  for (let row = 0; row < dimension; row += 1) total += runPenalty(modules[row]);
  for (let column = 0; column < dimension; column += 1) {
    total += runPenalty(modules.map((row) => row[column]));
  }

  for (let row = 0; row < dimension - 1; row += 1) {
    for (let column = 0; column < dimension - 1; column += 1) {
      const first = modules[row][column];
      if (first === modules[row][column + 1]
        && first === modules[row + 1][column]
        && first === modules[row + 1][column + 1]) total += 3;
    }
  }

  const finderLike = [true, false, true, true, true, false, true, false, false, false, false];
  const reversed = [...finderLike].reverse();
  const matches = (line: boolean[], pattern: boolean[], start: number) =>
    pattern.every((value, index) => line[start + index] === value);
  for (let index = 0; index < dimension; index += 1) {
    const row = modules[index];
    const column = modules.map((line) => line[index]);
    for (let start = 0; start + finderLike.length <= dimension; start += 1) {
      if (matches(row, finderLike, start) || matches(row, reversed, start)) total += 40;
      if (matches(column, finderLike, start) || matches(column, reversed, start)) total += 40;
    }
  }

  const dark = modules.flat().filter(Boolean).length;
  const percent = (dark * 100) / (dimension * dimension);
  total += Math.floor(Math.abs(percent - 50) / 5) * 10;
  return total;
}

/** BCH(15,5) format information for level M and the chosen mask. */
function formatBits(mask: number): number {
  const data = (0b00 << 3) | mask;
  let value = data << 10;
  for (let index = 14; index >= 10; index -= 1) {
    if ((value >>> index) & 1) value ^= 0b10100110111 << (index - 10);
  }
  return ((data << 10) | value) ^ 0b101010000010010;
}

/**
 * BCH(18,6) version information, for versions 7 and up.
 *
 * The generator is degree 12, so the remainder is taken over bits 17 down to
 * 12. Getting this polynomial wrong produces a symbol that is correct in every
 * other respect and that no scanner will read, which is exactly what the
 * round-trip test in `qr.test.ts` is there to catch.
 */
function versionBits(version: number): number {
  let value = version << 12;
  for (let index = 17; index >= 12; index -= 1) {
    if ((value >>> index) & 1) value ^= 0b1111100100101 << (index - 12);
  }
  return (version << 12) | value;
}

function writeFormat(modules: boolean[][], mask: number): void {
  const dimension = modules.length;
  const bits = formatBits(mask);
  for (let index = 0; index < 15; index += 1) {
    const bit = ((bits >>> index) & 1) === 1;
    // Around the top-left finder.
    if (index < 6) modules[index][8] = bit;
    else if (index === 6) modules[7][8] = bit;
    else if (index === 7) modules[8][8] = bit;
    else if (index === 8) modules[8][7] = bit;
    else modules[8][14 - index] = bit;
    // And the copy split between the other two.
    if (index < 8) modules[8][dimension - 1 - index] = bit;
    else modules[dimension - 15 + index][8] = bit;
  }
}

function writeVersion(modules: boolean[][], version: number): void {
  if (version < 7) return;
  const dimension = modules.length;
  const bits = versionBits(version);
  for (let index = 0; index < 18; index += 1) {
    const bit = ((bits >>> index) & 1) === 1;
    const row = Math.floor(index / 3);
    const column = dimension - 11 + (index % 3);
    modules[row][column] = bit;
    modules[column][row] = bit;
  }
}

/**
 * The finished symbol, row-major, `true` for a dark module. No quiet zone —
 * `renderQr` adds it, because how much white space a terminal needs is a
 * rendering question.
 */
export function encodeQr(text: string): boolean[][] {
  const bytes = new TextEncoder().encode(text);
  const version = chooseVersion(bytes.length);
  const codewords = interleave(encodeData(bytes, version), version);
  const { grid, reserved } = placeFunctionPatterns(version);
  placeData(grid, reserved, codewords);

  let best: boolean[][] | null = null;
  let bestPenalty = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < MASKS.length; mask += 1) {
    const candidate = applyMask(grid, reserved, mask);
    writeFormat(candidate, mask);
    writeVersion(candidate, version);
    const score = penalty(candidate);
    if (score < bestPenalty) {
      bestPenalty = score;
      best = candidate;
    }
  }
  return best!;
}

const QUIET_ZONE = 2;

/** White foreground on a black background, and back to whatever it was. */
const LIGHT_ON_DARK = `${String.fromCharCode(27)}[97;40m`;
const RESET = `${String.fromCharCode(27)}[0m`;

/**
 * Two module rows per line of text, as half blocks.
 *
 * Half blocks because a code drawn one module per character line is twice as
 * tall as it is wide, and scrolls off the top of the terminal before a camera
 * can see all of it. The glyphs draw the *light* modules, so the dark ones are
 * whatever the terminal paints behind them.
 *
 * Which makes polarity the whole problem. A phone reads a code the way it is
 * printed — dark modules on a light ground — and scans an inverted one far
 * less reliably than the internet believes. Uncoloured, this comes out right
 * on a dark terminal and exactly backwards on a light one, and the terminal's
 * theme is not something the code can see. So when the output is going to a
 * terminal it names its own two colours and stops depending on the theme;
 * piped, redirected, or under NO_COLOR it falls back to bare glyphs, which are
 * right on the dark themes most terminals use.
 */
export function renderQr(modules: boolean[][], options: { color?: boolean } = {}): string {
  const dimension = modules.length;
  const padded = dimension + QUIET_ZONE * 2;
  const dark = (row: number, column: number): boolean => {
    const r = row - QUIET_ZONE;
    const c = column - QUIET_ZONE;
    if (r < 0 || c < 0 || r >= dimension || c >= dimension) return false;
    return modules[r][c];
  };

  const lines: string[] = [];
  for (let row = 0; row < padded; row += 2) {
    let line = options.color ? LIGHT_ON_DARK : "";
    for (let column = 0; column < padded; column += 1) {
      const top = dark(row, column);
      const bottom = row + 1 < padded ? dark(row + 1, column) : false;
      // Dark modules are drawn as empty space and light ones as blocks: a
      // terminal's background is usually the dark end, and a scanner wants the
      // pattern light-on-dark the same way a printed code is dark-on-light.
      if (top && bottom) line += " ";
      else if (top) line += "▄";
      else if (bottom) line += "▀";
      else line += "█";
    }
    lines.push(options.color ? line + RESET : line);
  }
  return lines.join("\n");
}
