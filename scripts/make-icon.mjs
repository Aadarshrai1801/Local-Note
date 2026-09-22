// Generates Local Note's app icon, tray icons and Windows .ico procedurally.
//
// Written as a script (rather than committing binary art) so the artwork is
// reviewable, tweakable and reproducible with `npm run icon`. No image
// libraries are involved: PNG chunks are built with zlib, and the .ico
// container is assembled by hand.
//
//   npm run icon
//
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

/* ------------------------------------------------------------------ */
/* PNG encoding                                                        */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer) {
  let crc = -1
  for (let i = 0; i < buffer.length; i++) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ -1) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeBuffer = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0)
  return Buffer.concat([length, typeBuffer, data, crc])
}

/** Encodes RGBA pixel data (Uint8Array, 4 bytes per pixel) as a PNG. */
function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  ihdr[10] = 0 // deflate
  ihdr[11] = 0 // adaptive filtering
  ihdr[12] = 0 // no interlace

  // Each scanline is prefixed with its filter byte (0 = none).
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1)
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/* ------------------------------------------------------------------ */
/* Tiny software renderer                                              */
/* ------------------------------------------------------------------ */

/** Supersampling factor: draw big, then box-filter down for smooth edges. */
const SS = 4

class Canvas {
  constructor(size) {
    this.size = size
    this.data = new Float32Array(this.size * this.size * 4)
  }

  /** Composites a colour over the canvas at (x, y) with coverage `alpha`. */
  blend(x, y, [r, g, b], alpha) {
    if (alpha <= 0 || x < 0 || y < 0 || x >= this.size || y >= this.size) return
    const index = (y * this.size + x) * 4
    const a = Math.min(1, alpha)
    const dst = this.data

    const dstA = dst[index + 3]
    const outA = a + dstA * (1 - a)
    if (outA <= 0) return

    dst[index] = (r * a + dst[index] * dstA * (1 - a)) / outA
    dst[index + 1] = (g * a + dst[index + 1] * dstA * (1 - a)) / outA
    dst[index + 2] = (b * a + dst[index + 2] * dstA * (1 - a)) / outA
    dst[index + 3] = outA
  }
}

const hex = (value) => [
  parseInt(value.slice(1, 3), 16),
  parseInt(value.slice(3, 5), 16),
  parseInt(value.slice(5, 7), 16)
]

/** Signed distance to a rounded rectangle, used for anti-aliased fills. */
function roundedRectDistance(px, py, x, y, width, height, radius) {
  const halfW = width / 2
  const halfH = height / 2
  const cx = px - (x + halfW)
  const cy = py - (y + halfH)
  const qx = Math.abs(cx) - (halfW - radius)
  const qy = Math.abs(cy) - (halfH - radius)
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0))
  return outside + Math.min(Math.max(qx, qy), 0) - radius
}

/** Coverage of a shape given its signed distance (1px anti-aliasing). */
const coverage = (distance) => Math.min(1, Math.max(0, 0.5 - distance))

/**
 * Draws the Local Note mark: an audio waveform on the left that flattens into
 * a ruled line on the right — sound becoming written notes. A single amber dot
 * at the terminus stands for the recording indicator.
 */
function drawMark(canvas, options) {
  const {
    scale = 1,
    strokeColor = '#f5f7fa',
    accentColor = '#ffab3d',
    inset = 0.2,
    showBackground = true,
    backgroundTop = '#1d2836',
    backgroundBottom = '#0b1118'
  } = options

  const size = canvas.size
  const pad = size * inset
  const innerW = size - pad * 2
  const strokeRadius = size * 0.042 * scale
  const midY = size * 0.5

  // Background plate.
  if (showBackground) {
    const radius = size * 0.22
    const top = hex(backgroundTop)
    const bottom = hex(backgroundBottom)
    for (let y = 0; y < size; y++) {
      // Subtle vertical gradient reads as depth without looking glossy.
      const t = y / (size - 1)
      const colour = [0, 1, 2].map((i) => top[i] + (bottom[i] - top[i]) * t)
      for (let x = 0; x < size; x++) {
        const d = roundedRectDistance(x + 0.5, y + 0.5, 0, 0, size, size, radius)
        canvas.blend(x, y, colour, coverage(d))
      }
    }
  }

  const stroke = hex(strokeColor)
  const accent = hex(accentColor)

  // Waveform decaying into a flat line.
  const steps = Math.ceil(innerW * 2)
  const cycles = 2.6
  const startX = pad
  const endX = size - pad

  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const x = startX + t * innerW

    // Amplitude decays to zero across the mark.
    const decay = Math.pow(1 - t, 1.7)
    const y = midY + Math.sin(t * Math.PI * 2 * cycles) * innerW * 0.17 * decay

    // Round pen: stamp a disc, which yields a smooth variable-width stroke.
    const radius = strokeRadius * (0.55 + 0.45 * decay)
    const x0 = Math.max(0, Math.floor(x - radius - 1))
    const x1 = Math.min(size - 1, Math.ceil(x + radius + 1))
    const y0 = Math.max(0, Math.floor(y - radius - 1))
    const y1 = Math.min(size - 1, Math.ceil(y + radius + 1))

    for (let py = y0; py <= y1; py++) {
      for (let px = x0; px <= x1; px++) {
        const distance = Math.hypot(px + 0.5 - x, py + 0.5 - y) - radius
        canvas.blend(px, py, stroke, coverage(distance))
      }
    }
  }

  // Recording dot at the flat end of the line.
  if (accentColor) {
    const dotRadius = strokeRadius * 1.5
    const dotX = endX - strokeRadius * 0.2
    for (let py = 0; py < size; py++) {
      for (let px = 0; px < size; px++) {
        const distance = Math.hypot(px + 0.5 - dotX, py + 0.5 - midY) - dotRadius
        canvas.blend(px, py, accent, coverage(distance))
      }
    }
  }
}

/** Box-filters the supersampled canvas down to the target size. */
function resolve(canvas, targetSize) {
  const factor = canvas.size / targetSize
  const out = new Uint8Array(targetSize * targetSize * 4)

  for (let y = 0; y < targetSize; y++) {
    for (let x = 0; x < targetSize; x++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let count = 0

      for (let sy = 0; sy < factor; sy++) {
        for (let sx = 0; sx < factor; sx++) {
          const index = ((y * factor + sy) * canvas.size + (x * factor + sx)) * 4
          const alpha = canvas.data[index + 3]
          // Weight colour by alpha so transparent pixels do not darken edges.
          r += canvas.data[index] * alpha
          g += canvas.data[index + 1] * alpha
          b += canvas.data[index + 2] * alpha
          a += alpha
          count++
        }
      }

      const outIndex = (y * targetSize + x) * 4
      if (a > 0) {
        out[outIndex] = Math.round(Math.min(255, r / a))
        out[outIndex + 1] = Math.round(Math.min(255, g / a))
        out[outIndex + 2] = Math.round(Math.min(255, b / a))
      }
      out[outIndex + 3] = Math.round((a / count) * 255)
    }
  }
  return out
}

function render(size, options) {
  const canvas = new Canvas(size * SS)
  drawMark(canvas, options)
  return resolve(canvas, size)
}

/* ------------------------------------------------------------------ */
/* ICO container                                                       */
/* ------------------------------------------------------------------ */

/**
 * Builds a Windows .ico holding PNG-compressed images. Vista and later accept
 * PNG payloads directly, which keeps the file small.
 */
function encodeIco(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(images.length, 4)

  const entries = []
  const payloads = []
  let offset = 6 + images.length * 16

  for (const image of images) {
    const entry = Buffer.alloc(16)
    entry[0] = image.size >= 256 ? 0 : image.size // 0 means 256
    entry[1] = image.size >= 256 ? 0 : image.size
    entry[2] = 0 // palette colours
    entry[3] = 0 // reserved
    entry.writeUInt16LE(1, 4) // colour planes
    entry.writeUInt16LE(32, 6) // bits per pixel
    entry.writeUInt32LE(image.png.length, 8) // bytes in resource
    entry.writeUInt32LE(offset, 12)
    entries.push(entry)
    payloads.push(image.png)
    offset += image.png.length
  }

  return Buffer.concat([header, ...entries, ...payloads])
}

/* ------------------------------------------------------------------ */
/* Build                                                               */
/* ------------------------------------------------------------------ */

const assetsDir = join(root, 'assets')
const buildDir = join(root, 'build')
mkdirSync(assetsDir, { recursive: true })
mkdirSync(buildDir, { recursive: true })

const written = []
const write = (path, buffer) => {
  writeFileSync(path, buffer)
  written.push([path.replace(root + '\\', '').replace(root + '/', ''), buffer.length])
}

// Main app icon at the sizes Electron and Windows ask for.
write(join(assetsDir, 'icon.png'), encodePng(512, 512, render(512, {})))
write(join(assetsDir, 'icon-256.png'), encodePng(256, 256, render(256, {})))

// Tray icons: transparent background so Windows can theme them, and the
// recording state swaps the accent to amber.
const trayIdle = render(32, {
  showBackground: false,
  inset: 0.08,
  strokeColor: '#e9edf3',
  accentColor: '#7186a0'
})
const trayRecording = render(32, {
  showBackground: false,
  inset: 0.08,
  strokeColor: '#ffab3d',
  accentColor: '#ffab3d'
})

write(join(assetsDir, 'tray.png'), encodePng(32, 32, trayIdle))
write(join(assetsDir, 'tray-recording.png'), encodePng(32, 32, trayRecording))

// Windows .ico for the installer and window chrome.
write(
  join(buildDir, 'icon.ico'),
  encodeIco(
    [256, 128, 64, 48, 32, 16].map((size) => ({
      size,
      png: encodePng(size, size, render(size, {}))
    }))
  )
)
// electron-builder also looks for build/icon.png when generating icons.
write(join(buildDir, 'icon.png'), encodePng(512, 512, render(512, {})))

console.log('Generated:')
for (const [path, size] of written) {
  console.log(`  ${path.padEnd(26)} ${(size / 1024).toFixed(1)} KB`)
}
