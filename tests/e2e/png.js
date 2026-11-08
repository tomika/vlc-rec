// Decodes the 8-bit RGB/RGBA PNG files made by the screenshot tools and counts pixels.
const { readFileSync } = require("node:fs");
const { inflateSync } = require("node:zlib");

function readPng(file) {
  const data = readFileSync(file);
  let offset = 8;
  let width = 0, height = 0, channels = 0;
  const idat = [];
  while (offset < data.length) {
    const length = data.readUInt32BE(offset);
    const type = data.toString("latin1", offset + 4, offset + 8);
    const body = data.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const colorType = body[9];
      if (body[8] !== 8 || body[12] !== 0 || (colorType !== 2 && colorType !== 6)) {
        throw new Error(`Unsupported PNG format in ${file}`);
      }
      channels = colorType === 6 ? 4 : 3;
    } else if (type === "IDAT") {
      idat.push(body);
    }
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? pixels[y * stride + x - channels] : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const upLeft = x >= channels && y > 0 ? pixels[(y - 1) * stride + x - channels] : 0;
      let predicted = 0;
      if (filter === 1) predicted = left;
      else if (filter === 2) predicted = up;
      else if (filter === 3) predicted = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - upLeft);
        predicted = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      pixels[y * stride + x] = (raw[line + x] + predicted) & 255;
    }
  }
  return { width, height, channels, pixels };
}

// saturated: pure video colors, which no app styling comes close to.
function countPixels(png) {
  const counts = { saturated: 0, black: 0, magenta: 0 };
  for (let i = 0; i < png.pixels.length; i += png.channels) {
    const r = png.pixels[i], g = png.pixels[i + 1], b = png.pixels[i + 2];
    if (Math.max(r, g, b) - Math.min(r, g, b) > 200) counts.saturated += 1;
    if (r === 0 && g === 0 && b === 0) counts.black += 1;
    if (r === 255 && g === 0 && b === 255) counts.magenta += 1;
  }
  return counts;
}

module.exports = { readPng, countPixels };
