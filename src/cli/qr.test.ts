import { describe, expect, it } from "vitest";
import { QrTooLongError, encodeQr, renderQr } from "./qr.js";

/* How this was checked, since a QR encoder that is subtly wrong still looks
   exactly like a QR code:

   Every byte length from 1 to 210 was encoded here, rendered to an image, and
   read back with an independent decoder (`jsqr`), and each one returned the
   text it started from. The same symbols were compared module for module
   against an independent encoder (`qrcode`, level M). They agree everywhere
   except a handful of lengths where the two implementations score the masking
   penalty differently and choose different masks — both scannable, both valid.
   Neither library is a dependency of this project; they were the instrument,
   not the fix. The tests below pin the result so a later change has to stay
   right.

   That check found exactly one bug, and it is the one worth remembering: a
   wrong generator polynomial in the version information made every symbol from
   version 7 up unreadable while leaving smaller ones perfect. Nothing
   structural looked wrong. Only a decoder said so. */

function render(modules: boolean[][]): string[] {
  return modules.map((row) => row.map((cell) => (cell ? "#" : ".")).join(""));
}

const PAIR_FIXTURE = [
  "#######.......#######",
  "#.....#..#.#..#.....#",
  "#.###.#.###...#.###.#",
  "#.###.#.###...#.###.#",
  "#.###.#.#..##.#.###.#",
  "#.....#.##..#.#.....#",
  "#######.#.#.#.#######",
  "........#####........",
  "#.#####.....#.#####..",
  "##...#..##..#..#..#.#",
  "...##.#....#.#..####.",
  ".##..#.##......####..",
  "#..#######.#.#..#....",
  "........##.####....##",
  "#######..#..#.##.###.",
  "#.....#.#..####..##..",
  "#.###.#.#...#..#.#.#.",
  "#.###.#.##..#..#..#..",
  "#.###.#.####.#..#....",
  "#.....#........##.#..",
  "#######.####.#..#.##.",
];

describe("encodeQr", () => {
  it("produces the symbol a decoder was shown reading", () => {
    expect(render(encodeQr("pair"))).toEqual(PAIR_FIXTURE);
  });

  it("grows a version at a time, and only as far as the text needs", () => {
    // 4v + 17 modules a side, so each version is four modules wider.
    expect(encodeQr("x".repeat(14)).length).toBe(21);
    expect(encodeQr("x".repeat(15)).length).toBe(25);
    expect(encodeQr("x".repeat(106)).length).toBe(41);
    expect(encodeQr("x".repeat(213)).length).toBe(57);
  });

  // A pairing URL is about eighty characters. Refusing is the honest answer
  // for anything past the largest version this encodes.
  it("refuses text that will not fit rather than truncating it", () => {
    expect(() => encodeQr("x".repeat(214))).toThrow(QrTooLongError);
  });

  it("counts UTF-8 bytes, not characters", () => {
    // Twelve characters, twenty-four bytes: a version larger than the
    // character count alone would have chosen.
    expect(encodeQr("é".repeat(12)).length).toBe(encodeQr("x".repeat(24)).length);
  });

  it("places the three finder patterns and the module that is always dark", () => {
    const modules = encodeQr("https://host.tailnet.ts.net/#pair=token");
    const dimension = modules.length;
    for (const [top, left] of [[0, 0], [0, dimension - 7], [dimension - 7, 0]]) {
      expect(modules[top][left]).toBe(true);
      expect(modules[top + 1][left + 1]).toBe(false);
      expect(modules[top + 3][left + 3]).toBe(true);
    }
    expect(modules[dimension - 8][8]).toBe(true);
  });

  it("alternates the timing patterns", () => {
    const modules = encodeQr("https://host.tailnet.ts.net/#pair=token");
    for (let index = 8; index < modules.length - 8; index += 1) {
      expect(modules[6][index]).toBe(index % 2 === 0);
      expect(modules[index][6]).toBe(index % 2 === 0);
    }
  });

  /* The bug only a decoder caught. These are the version information strings
     from the standard's own table, and a symbol carrying anything else is
     unreadable however good the rest of it is. */
  it.each([
    [7, "000111110010010100"],
    [8, "001000010110111100"],
    [9, "001001101010011001"],
    [10, "001010010011010011"],
  ])("carries the standard's version information for version %i", (version, expected) => {
    const lengths: Record<number, number> = { 7: 107, 8: 123, 9: 153, 10: 181 };
    const modules = encodeQr("x".repeat(lengths[version]));
    const dimension = modules.length;
    expect(dimension).toBe(version * 4 + 17);

    // Bit 0 is the last character of the string, and the block is repeated
    // beside the bottom-left finder with its axes swapped.
    let topRight = "";
    let bottomLeft = "";
    for (let index = 17; index >= 0; index -= 1) {
      const row = Math.floor(index / 3);
      const column = dimension - 11 + (index % 3);
      topRight += modules[row][column] ? "1" : "0";
      bottomLeft += modules[column][row] ? "1" : "0";
    }
    expect(topRight).toBe(expected);
    expect(bottomLeft).toBe(expected);
  });

  // The two copies encode the same thing, so a scanner that can only make out
  // one corner still learns the mask and the error-correction level.
  it("agrees with itself about the format information", () => {
    const modules = encodeQr("https://host.tailnet.ts.net/#pair=token");
    const dimension = modules.length;
    const near: boolean[] = [];
    const far: boolean[] = [];
    for (let index = 0; index < 15; index += 1) {
      if (index < 6) near.push(modules[index][8]);
      else if (index === 6) near.push(modules[7][8]);
      else if (index === 7) near.push(modules[8][8]);
      else if (index === 8) near.push(modules[8][7]);
      else near.push(modules[8][14 - index]);
      far.push(index < 8 ? modules[8][dimension - 1 - index] : modules[dimension - 15 + index][8]);
    }
    expect(near).toEqual(far);

    // And what they say is one of the eight level-M format strings.
    const value = near.map((bit) => (bit ? "1" : "0")).reverse().join("");
    expect([
      "101010000010010", "101000100100101", "101111001111100", "101101101001011",
      "100010111111001", "100000011001110", "100111110010111", "100101010100000",
    ]).toContain(value);
  });
});

describe("renderQr", () => {
  const modules = encodeQr("pair");
  const rendered = renderQr(modules);
  const lines = rendered.split("\n");

  it("draws two module rows per line, with a quiet zone around them", () => {
    // 21 modules plus two either side is 25, which is 13 lines of half blocks.
    expect(lines).toHaveLength(13);
    expect(new Set(lines.map((line) => line.length))).toEqual(new Set([25]));
  });

  /* A scanner needs the quiet zone as much as it needs the symbol. The border
     is drawn as full blocks because a terminal's background is the dark end,
     and the code has to read the way a printed one does. */
  it("leaves the border clear", () => {
    expect(lines[0]).toBe("█".repeat(25));
    expect(lines.at(-1)).toBe("█".repeat(25));
    for (const line of lines) {
      expect(line.startsWith("██")).toBe(true);
      expect(line.endsWith("██")).toBe(true);
    }
  });

  // Redirected output has no terminal to colour, and the glyphs alone are
  // right on a dark theme.
  it("uses no escape sequences unless asked", () => {
    expect(rendered).not.toContain(String.fromCharCode(27));
    expect(new Set(rendered.replace(/\n/gu, "").split("")))
      .toEqual(new Set(["█", "▀", "▄", " "]));
  });

  /* Polarity is the whole reason colour exists here: uncoloured, the code is
     correct on a dark terminal and inverted on a light one, and a phone reads
     an inverted code far less reliably. Naming both colours settles it. */
  it("names its own colours, and draws the same code inside them", () => {
    const escape = String.fromCharCode(27);
    const coloured = renderQr(modules, { color: true }).split("\n");
    expect(coloured).toHaveLength(lines.length);
    for (const [index, line] of coloured.entries()) {
      expect(line.startsWith(`${escape}[97;40m`)).toBe(true);
      expect(line.endsWith(`${escape}[0m`)).toBe(true);
      expect(line.slice(`${escape}[97;40m`.length, -`${escape}[0m`.length)).toBe(lines[index]);
    }
  });
});
