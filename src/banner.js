import { paint } from './terminal.js';

// Keep the official symbol and wordmark as one dot logo; only its scale changes with terminal width.
const symbol = [
  '                              ⣠⣴⣿⣿',
  '                           ⣠⣴⣿⣿⣿⣿⣿',
  '                         ⢰⣿⣿⣿⣿⣿⣿⣿⣿',
  '⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣷⣦⡀   ⢸⣿⣿⣿⣿⣿⣿⣿⣿',
  '⠈⢿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣷⡄  ⢸⣿⣿⣿⣿⣿⣿⣿⣿',
  '  ⠻⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣆ ⢸⣿⣿⣿⣿⣿⣿⣿⣿',
  '   ⠙⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣧⣸⣿⣿⣿⣿⣿⣿⣿⣿',
  '    ⠈⠉⠉⠉⠉⠉⠉⠉⣉⣽⡏⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⢹⣿⣿⣿⣿⣿⣿⣿⣿',
  '         ⣀⣴⣾⣿⣿⡇          ⢸⣿⣿⣿⣿⣿⣿⣿⣿',
  '      ⢀⣴⣾⣿⣿⣿⣿⣿⡇          ⢸⣿⣿⣿⣿⣿⣿⣿⡿',
  '      ⣿⣿⣿⣿⣿⣿⣿⣿⡇          ⢸⣿⣿⣿⣿⣿⡿⠟⠁',
  '      ⣿⣿⣿⣿⣿⣿⣿⣿⡇          ⢸⣿⣿⡿⠟⠉',
  '      ⣿⣿⣿⣿⣿⣿⣿⣿⣇⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣸⣟⣉⣀⣀⣀⣀⣀⣀⣀⡀',
  '      ⣿⣿⣿⣿⣿⣿⣿⣿⡏⢻⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣄',
  '      ⣿⣿⣿⣿⣿⣿⣿⣿⡇ ⠹⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣦',
  '      ⣿⣿⣿⣿⣿⣿⣿⣿⡇  ⠘⢿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣷⡀',
  '      ⣿⣿⣿⣿⣿⣿⣿⣿⡇   ⠈⠻⢿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿',
  '      ⣿⣿⣿⣿⣿⣿⣿⣿⠇',
  '      ⣿⣿⣿⣿⣿⠟⠋',
  '      ⣿⣿⠟⠋',
];

const wordmark = [
  '                                                                     ⣿⣿⣿⣿⣿',
  '                                                                     ⣿⣿⣿⣿⣿',
  '                                                                     ⠉⠉⠉⠉⠉',
  '  ⢀⣀⣀⣀⣀⡀  ⢀⣀⣤⣤⣤⣤⣄⡀            ⣀⣠⣤⣤⣤⣤⣄⣀       ⢀⣀⣀⣀⣀⣀⣀       ⣀⣀⣀⣀⣀⣀    ⣀⣀⣀⣀⣀        ⢀⣀⣤⣤⣤⣤⣤⣤⣤⣀⡀',
  '  ⢸⣿⣿⣿⣿⡇⣠⣶⣿⣿⣿⣿⣿⣿⣿⣿⣷⣄       ⢀⣴⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣦⡀     ⠹⣿⣿⣿⣿⣿⣧    ⢠⣾⣿⣿⣿⣿⡿⠁    ⣿⣿⣿⣿⣿      ⣠⣾⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣶⡄',
  '  ⢸⣿⣿⣿⣿⣿⣿⣿⠿⠛⠛⠻⢿⣿⣿⣿⣿⣿⡆     ⣴⣿⣿⣿⣿⣿⠿⠛⠛⠻⢿⣿⣿⣿⣿⣦     ⠘⢿⣿⣿⣿⣿⣷⡀ ⣰⣿⣿⣿⣿⣿⠟      ⣿⣿⣿⣿⣿     ⣼⣿⣿⣿⣿⡿⠟⠛⠛⠛⢿⣿⣿⣿⣿⣿⡄',
  '  ⢸⣿⣿⣿⣿⣿⡟⠁     ⢻⣿⣿⣿⣿⣧    ⣸⣿⣿⣿⣿⡟⠁     ⢹⣿⣿⣿⣿⡆     ⠈⠻⣿⣿⣿⣿⣿⣾⣿⣿⣿⣿⡿⠃       ⣿⣿⣿⣿⣿    ⠐⠛⠛⠿⠿⠏      ⢹⣿⣿⣿⣿⡇',
  '  ⢸⣿⣿⣿⣿⣿⠁      ⢸⣿⣿⣿⣿⣿    ⣿⣿⣿⣿⣿⡁       ⣿⣿⣿⣿⣿       ⠙⣿⣿⣿⣿⣿⣿⣿⣿⡟⠁        ⣿⣿⣿⣿⣿           ⣀⣀⣠⣤⣴⣾⣿⣿⣿⣿⡇',
  '  ⢸⣿⣿⣿⣿⣿       ⢸⣿⣿⣿⣿⣿   ⢰⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡀       ⠈⣿⣿⣿⣿⣿⣿⣏          ⣿⣿⣿⣿⣿      ⣠⣴⣶⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡇',
  '  ⢸⣿⣿⣿⣿⣿       ⢸⣿⣿⣿⣿⣿   ⠘⣿⣿⣿⣿⣿⠛⠛⠛⠛⠛⠛⠛⠛⠛⠛⠛⠛⠛⠁      ⢀⣾⣿⣿⣿⣿⣿⣿⣿⣧⡀        ⣿⣿⣿⣿⣿    ⢠⣾⣿⣿⣿⣿⠿⠛⠛⠉⠉⠁⢸⣿⣿⣿⣿⡇',
  '  ⢸⣿⣿⣿⣿⣿       ⢸⣿⣿⣿⣿⣿    ⢿⣿⣿⣿⣿⣆      ⢀⣀⣀⣀        ⣰⣿⣿⣿⣿⣿⢿⣿⣿⣿⣿⣷⣄       ⣿⣿⣿⣿⣿    ⣾⣿⣿⣿⣿⡇      ⣼⣿⣿⣿⣿⡇',
  '  ⢸⣿⣿⣿⣿⣿       ⢸⣿⣿⣿⣿⣿    ⠘⣿⣿⣿⣿⣿⣦⣀  ⢀⣠⣾⣿⣿⣿⣿⠏    ⢀⣼⣿⣿⣿⣿⡿⠃ ⠻⣿⣿⣿⣿⣿⣦      ⣿⣿⣿⣿⣿    ⢿⣿⣿⣿⣿⣷⣀  ⢀⣠⣼⣿⣿⣿⣿⣿⡇',
  '  ⢸⣿⣿⣿⣿⣿       ⢸⣿⣿⣿⣿⣿     ⠈⢿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡿⠋    ⢠⣾⣿⣿⣿⣿⡟⠁   ⠙⣿⣿⣿⣿⣿⣷⡀    ⣿⣿⣿⣿⣿    ⠘⢿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠿⣿⣿⣿⣿⣧',
  '  ⠸⠿⠿⠿⠿⠿       ⠸⠿⠿⠿⠿⠿       ⠈⠛⠿⢿⣿⣿⣿⣿⣿⠿⠟⠋     ⠴⠿⠿⠿⠿⠿⠏      ⠈⠿⠿⠿⠿⠿⠿⠄   ⠿⠿⠿⠿⠿      ⠙⠿⢿⣿⣿⣿⡿⠿⠛⠁ ⠹⠿⠿⠿⠿⠆',
];

const dots = [[0, 0, 0], [1, 0, 1], [2, 0, 2], [0, 1, 3], [1, 1, 4], [2, 1, 5], [3, 0, 6], [3, 1, 7]];

function rasterize(rows) {
  const width = Math.max(...rows.map(row => [...row].length)) * 2;
  const pixels = Array.from({ length: rows.length * 4 }, () => Array(width).fill(0));
  rows.forEach((row, rowIndex) => [...row].forEach((character, columnIndex) => {
    const bits = character.codePointAt(0) - 0x2800;
    if (bits < 0 || bits > 0xff) return;
    for (const [y, x, bit] of dots) if (bits & (1 << bit)) pixels[rowIndex * 4 + y][columnIndex * 2 + x] = 1;
  }));
  return pixels;
}

function resize(source, scale) {
  const sourceHeight = source.length, sourceWidth = source[0].length;
  const height = Math.max(4, Math.round(sourceHeight * scale / 4) * 4);
  const width = Math.max(2, Math.round(sourceWidth * scale / 2) * 2);
  return Array.from({ length: height }, (_, y) => Array.from({ length: width }, (_, x) => {
    const x0 = x * sourceWidth / width, x1 = (x + 1) * sourceWidth / width;
    const y0 = y * sourceHeight / height, y1 = (y + 1) * sourceHeight / height;
    let ink = 0, area = 0;
    for (let sourceY = Math.floor(y0); sourceY < Math.ceil(y1); sourceY++) {
      for (let sourceX = Math.floor(x0); sourceX < Math.ceil(x1); sourceX++) {
        const overlap = Math.max(0, Math.min(x1, sourceX + 1) - Math.max(x0, sourceX))
          * Math.max(0, Math.min(y1, sourceY + 1) - Math.max(y0, sourceY));
        area += overlap;
        ink += overlap * (source[sourceY]?.[sourceX] || 0);
      }
    }
    return ink / area >= 0.32 ? 1 : 0;
  }));
}

function encode(pixels) {
  const rows = [];
  for (let row = 0; row < pixels.length / 4; row++) {
    let encoded = '';
    for (let column = 0; column < pixels[0].length / 2; column++) {
      let bits = 0;
      for (const [y, x, bit] of dots) if (pixels[row * 4 + y]?.[column * 2 + x]) bits |= 1 << bit;
      encoded += bits ? String.fromCodePoint(0x2800 + bits) : ' ';
    }
    rows.push(encoded.trimEnd());
  }
  return rows;
}

const symbolPixels = rasterize(symbol);
const wordmarkPixels = rasterize(wordmark);
const sourceColumns = (symbolPixels[0].length + 8 + wordmarkPixels[0].length) / 2;

export function banner(stream = process.stderr, env = process.env) {
  if (!stream.isTTY || env.TERM === 'dumb') return '';
  const columns = stream.columns || 80;
  const scale = Math.min(0.62, Math.max(8, columns - 4) / sourceColumns);
  const symbolRows = encode(resize(symbolPixels, scale));
  const wordmarkRows = encode(resize(wordmarkPixels, scale));
  const symbolWidth = Math.max(...symbolRows.map(row => [...row].length));
  const wordmarkWidth = Math.max(...wordmarkRows.map(row => [...row].length));
  const gap = ' '.repeat(Math.max(1, Math.round(4 * scale)));
  const width = symbolWidth + gap.length + wordmarkWidth;
  const left = ' '.repeat(Math.max(0, Math.floor((columns - width) / 2)));
  const wordmarkTop = Math.floor((symbolRows.length - wordmarkRows.length) / 2);
  return ['', ...symbolRows.map((row, index) => `${left}${paint(row.padEnd(symbolWidth), 'brand', stream, env)}${gap}${paint(wordmarkRows[index - wordmarkTop] || '', 'white', stream, env)}`), ''].join('\n');
}
