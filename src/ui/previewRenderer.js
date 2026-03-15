// File: src/ui/previewRenderer.js
//
// ── Data flow ────────────────────────────────────────────────────────────────
// This is a pure rendering module. Both functions take a canvas and a function,
// draw onto the canvas, and return nothing.
//
// drawSDFPreview:
//   INPUT:  HTMLCanvasElement, sdfFn: ({x,y}) → number, bounds: [minX,minY,maxX,maxY]
//   OUTPUT: Canvas filled with a hot/cold colourmap of the distance field.
//           Negative values (inside) → blue gradient
//           Zero crossing            → white
//           Positive values (outside)→ red/orange gradient
//           The zero contour is drawn as a bright white line.
//
// drawMapperCurve:
//   INPUT:  HTMLCanvasElement, mapperFn: (d:number) → number,
//           domain: [dMin, dMax], range: [rMin, rMax] (auto-computed if null)
//   OUTPUT: Canvas filled with a curve plot of f(d) over the domain.
//           Includes axis lines, zero line, and grid.
//
// Neither function allocates persistent state. They can be called repeatedly
// on the same canvas and will clear it each time.
// ─────────────────────────────────────────────────────────────────────────────

// ── SDF field preview ─────────────────────────────────────────────────────────

/**
 * Draw a signed distance field as a colourmap onto a canvas.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {Function}          sdfFn    ({x,y}) → number
 * @param {number[]}          bounds   [minX, minY, maxX, maxY] in world space
 */
export function drawSDFPreview(canvas, sdfFn, bounds = [-3, -3, 3, 3]) {
  const ctx = canvas.getContext('2d');
  const W   = canvas.width;
  const H   = canvas.height;

  ctx.clearRect(0, 0, W, H);

  const [minX, minY, maxX, maxY] = bounds;
  const rangeX = maxX - minX;
  const rangeY = maxY - minY;

  // Sample the SDF at each pixel
  const imageData = ctx.createImageData(W, H);
  const data      = imageData.data;

  // Two-pass: first collect all values to find the range for normalisation
  const values = new Float32Array(W * H);
  let vMin =  Infinity;
  let vMax = -Infinity;

  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const x = minX + (px / W) * rangeX;
      const y = maxY - (py / H) * rangeY;   // flip Y so +y is up
      const v = sdfFn({ x, y });
      values[py * W + px] = isFinite(v) ? v : 0;
      if (isFinite(v)) {
        vMin = Math.min(vMin, v);
        vMax = Math.max(vMax, v);
      }
    }
  }

  // Colour scale: use a fixed symmetric range around 0 for stable visuals
  // If both signs are present, use max(|vMin|, |vMax|) as the scale.
  const absMax = Math.max(Math.abs(vMin), Math.abs(vMax), 0.001);

  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    const t = v / absMax;   // −1 to +1

    let r, g, b;

    if (t < 0) {
      // Inside — blue to white as t goes from −1 to 0
      const s = -t;  // 0 at zero, 1 deep inside
      r = Math.round(255 * (1 - s * 0.8));
      g = Math.round(255 * (1 - s * 0.5));
      b = 255;
    } else {
      // Outside — white to deep red as t goes from 0 to +1
      r = 255;
      g = Math.round(255 * (1 - t * 0.85));
      b = Math.round(255 * (1 - t * 0.95));
    }

    const idx = i * 4;
    data[idx]     = r;
    data[idx + 1] = g;
    data[idx + 2] = b;
    data[idx + 3] = 255;
  }

  ctx.putImageData(imageData, 0, 0);

  // Draw a bright contour line at zero crossing
  _drawZeroContour(ctx, values, W, H, absMax);

  // Draw a subtle border
  ctx.strokeStyle = 'rgba(255,255,255,0.15)';
  ctx.lineWidth   = 1;
  ctx.strokeRect(0.5, 0.5, W - 1, H - 1);
}

/**
 * Draw the zero-crossing contour line by finding sign changes between
 * horizontally and vertically adjacent pixels.
 */
function _drawZeroContour(ctx, values, W, H, absMax) {
  ctx.beginPath();
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth   = 1.5;

  for (let py = 0; py < H - 1; py++) {
    for (let px = 0; px < W - 1; px++) {
      const v  = values[py * W + px];
      const vR = values[py * W + px + 1];
      const vD = values[(py + 1) * W + px];

      // Horizontal zero crossing
      if ((v < 0) !== (vR < 0)) {
        const fx = px + Math.abs(v) / (Math.abs(v) + Math.abs(vR));
        ctx.moveTo(fx, py + 0.5);
        ctx.lineTo(fx, py + 1.5);
      }
      // Vertical zero crossing
      if ((v < 0) !== (vD < 0)) {
        const fy = py + Math.abs(v) / (Math.abs(v) + Math.abs(vD));
        ctx.moveTo(px + 0.5, fy);
        ctx.lineTo(px + 1.5, fy);
      }
    }
  }

  ctx.stroke();
}


// ── Mapper curve preview ──────────────────────────────────────────────────────

/**
 * Draw a curve plot of a mapper function f(d) for d in [dMin, dMax].
 *
 * @param {HTMLCanvasElement} canvas
 * @param {Function}          mapperFn  d → number
 * @param {number}            dMin      left edge of domain (default 0)
 * @param {number}            dMax      right edge of domain (default 3)
 */
export function drawMapperCurve(canvas, mapperFn, dMin = 0, dMax = 3) {
  const ctx = canvas.getContext('2d');
  const W   = canvas.width;
  const H   = canvas.height;

  ctx.clearRect(0, 0, W, H);

  // Fill background
  ctx.fillStyle = 'rgba(20, 20, 25, 0.95)';
  ctx.fillRect(0, 0, W, H);

  const PAD = 10;
  const plotW = W - PAD * 2;
  const plotH = H - PAD * 2;

  // Sample the function
  const N      = plotW;
  const ys     = new Array(N);
  let yMin =  Infinity;
  let yMax = -Infinity;

  for (let i = 0; i < N; i++) {
    const d = dMin + (i / (N - 1)) * (dMax - dMin);
    const y = mapperFn(d);
    ys[i] = isFinite(y) ? y : 0;
    yMin  = Math.min(yMin, ys[i]);
    yMax  = Math.max(yMax, ys[i]);
  }

  // Expand range symmetrically if needed so zero is visible
  const rng = Math.max(Math.abs(yMin), Math.abs(yMax), 0.1);
  yMin = -rng * 1.1;
  yMax =  rng * 1.1;

  const toX = (d) => PAD + ((d - dMin) / (dMax - dMin)) * plotW;
  const toY = (v) => PAD + plotH - ((v - yMin) / (yMax - yMin)) * plotH;

  // Grid lines
  ctx.strokeStyle = 'rgba(255,255,255,0.07)';
  ctx.lineWidth   = 1;
  for (let i = 1; i <= 4; i++) {
    const x = PAD + (i / 4) * plotW;
    ctx.beginPath(); ctx.moveTo(x, PAD); ctx.lineTo(x, PAD + plotH); ctx.stroke();
  }
  for (let i = 1; i <= 3; i++) {
    const y = PAD + (i / 4) * plotH;
    ctx.beginPath(); ctx.moveTo(PAD, y); ctx.lineTo(PAD + plotW, y); ctx.stroke();
  }

  // Zero axis
  const zeroY = toY(0);
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.lineWidth   = 1;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(PAD, zeroY);
  ctx.lineTo(PAD + plotW, zeroY);
  ctx.stroke();
  ctx.setLineDash([]);

  // Identity reference line (d = f(d)) in subtle grey
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth   = 1;
  ctx.beginPath();
  ctx.moveTo(toX(dMin), toY(dMin));
  ctx.lineTo(toX(dMax), toY(dMax > yMax ? yMax : dMax));
  ctx.stroke();

  // The curve itself
  ctx.strokeStyle = '#EF9F27';  // amber — matches mapper port colour
  ctx.lineWidth   = 2;
  ctx.beginPath();
  for (let i = 0; i < N; i++) {
    const x = PAD + (i / (N - 1)) * plotW;
    const y = toY(ys[i]);
    if (i === 0) ctx.moveTo(x, y);
    else         ctx.lineTo(x, y);
  }
  ctx.stroke();

  // Axis labels (tiny)
  ctx.fillStyle   = 'rgba(255,255,255,0.4)';
  ctx.font        = '9px monospace';
  ctx.textAlign   = 'left';
  ctx.fillText(`d=${dMin.toFixed(0)}`, PAD, H - 2);
  ctx.textAlign   = 'right';
  ctx.fillText(`${dMax.toFixed(0)}`, W - PAD, H - 2);
  ctx.textAlign   = 'right';
  ctx.fillText(rng.toFixed(1), W - PAD, PAD + 8);
  ctx.fillText((-rng).toFixed(1), W - PAD, PAD + plotH);

  // Border
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth   = 1;
  ctx.strokeRect(PAD, PAD, plotW, plotH);
}