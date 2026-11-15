// Tiny pure-JS RGBA canvas for pixel checks in node tests (SAA-303 layer/buffer tests).
// Implements the subset DesktopSession uses: width/height (resizing clears, like a real
// canvas), getContext('2d') with fillStyle, fillRect, clearRect and drawImage (3- and 9-arg).
export class PixelCanvas {
  constructor(width = 0, height = 0) { this._w = width; this._h = height; this.data = new Uint8ClampedArray(width * height * 4); this.ctx = new PixelContext(this); }
  get width() { return this._w; }
  set width(v) { this._w = v; this.data = new Uint8ClampedArray(this._w * this._h * 4); }
  get height() { return this._h; }
  set height(v) { this._h = v; this.data = new Uint8ClampedArray(this._w * this._h * 4); }
  getContext() { return this.ctx; }
  focus() {}
  setAttribute() {}
  addEventListener() {}
  pixel(x, y) { const i = (y * this._w + x) * 4; return [...this.data.slice(i, i + 4)]; }
  set(x, y, rgba) { if (x < 0 || y < 0 || x >= this._w || y >= this._h) return; this.data.set(rgba, (y * this._w + x) * 4); }
}

class PixelContext {
  constructor(canvas) { this.canvas = canvas; this.fillStyle = 'rgba(0,0,0,1)'; this.pathRects = []; }
  save() {}
  restore() {}
  setTransform() {}
  transform() {}
  translate() {}
  scale() {}
  rotate() {}
  beginPath() { this.pathRects = []; }
  closePath() {}
  moveTo() {}
  lineTo() {}
  stroke() {}
  fill() { for (const [x, y, w, h] of this.pathRects) this.fillRect(x, y, w, h); }
  rect(x, y, w, h) { this.pathRects.push([x, y, w, h]); }
  clip() {}
  putImageData(image, x, y) {
    for (let j = 0; j < image.height; j += 1) for (let i = 0; i < image.width; i += 1) {
      const offset = (j * image.width + i) * 4;
      this.canvas.set(x + i, y + j, [...image.data.slice(offset, offset + 4)]);
    }
  }
  getImageData(x, y, width, height) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let j = 0; j < height; j += 1) for (let i = 0; i < width; i += 1) {
      const pixel = this.canvas.pixel(x + i, y + j);
      data.set(pixel, (j * width + i) * 4);
    }
    return { data, width, height };
  }
  createImageData(width, height) { return { data: new Uint8ClampedArray(width * height * 4), width, height }; }
  fillRect(x, y, w, h) {
    const [r, g, b, a] = this.fillStyle.match(/[\d.]+/g).map(Number);
    for (let j = y; j < y + h; j += 1) for (let i = x; i < x + w; i += 1) this.canvas.set(i, j, [r, g, b, Math.round(a * 255)]);
  }
  clearRect(x, y, w, h) { for (let j = y; j < y + h; j += 1) for (let i = x; i < x + w; i += 1) this.canvas.set(i, j, [0, 0, 0, 0]); }
  drawImage(src, ...a) {
    const [sx, sy, sw, sh, dx, dy] = a.length === 2 ? [0, 0, src.width, src.height, a[0], a[1]] : a;
    const copy = [];
    for (let j = 0; j < sh; j += 1) for (let i = 0; i < sw; i += 1) copy.push([i, j, src.pixel(sx + i, sy + j)]);
    for (const [i, j, p] of copy) if (p[3] > 0) this.canvas.set(dx + i, dy + j, p);
  }
}

// "Image" from a 2-D array of rows of [r,g,b,a]; encoded into base64 JSON for img streams.
export function encodeTestImage(rows) { return Buffer.from(JSON.stringify(rows)).toString('base64'); }
export function decodeTestImage(_mime, base64) {
  const rows = JSON.parse(Buffer.from(base64, 'base64').toString());
  const c = new PixelCanvas(rows[0].length, rows.length);
  rows.forEach((row, y) => row.forEach((p, x) => c.set(x, y, p)));
  return c;
}
