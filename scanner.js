(() => {
  const MAX_SOURCE = 2600;
  const MAX_OUTPUT = 2000;
  const $ = (id) => document.getElementById(id);

  function toGray(data, n) {
    const g = new Float32Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) g[i] = 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2];
    return g;
  }

  function boxBlur(src, w, h, r) {
    const tmp = new Float32Array(w * h);
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      let acc = 0;
      const row = y * w;
      for (let x = -r; x <= r; x++) acc += src[row + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) {
        tmp[row + x] = acc / (2 * r + 1);
        acc += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
      }
    }
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) {
        out[y * w + x] = acc / (2 * r + 1);
        acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
      }
    }
    return out;
  }

  function otsu(g) {
    const hist = new Uint32Array(256);
    for (let i = 0; i < g.length; i++) hist[Math.min(255, Math.max(0, g[i] | 0))]++;
    const total = g.length;
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0;
    let wB = 0;
    let best = 0;
    let thr = 127;
    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (!wB) continue;
      const wF = total - wB;
      if (!wF) break;
      sumB += t * hist[t];
      const mB = sumB / wB;
      const mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; thr = t; }
    }
    return thr;
  }

  function polyArea(q) {
    let a = 0;
    for (let i = 0; i < 4; i++) {
      const p = q[i];
      const n = q[(i + 1) % 4];
      a += p.x * n.y - n.x * p.y;
    }
    return Math.abs(a) / 2;
  }

  function isConvex(q) {
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const a = q[i];
      const b = q[(i + 1) % 4];
      const c = q[(i + 2) % 4];
      const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
      if (Math.abs(cross) < 1e-6) continue;
      const s = Math.sign(cross);
      if (sign && s !== sign) return false;
      sign = s;
    }
    return true;
  }

  function defaultQuad(w, h) {
    const mx = w * 0.06;
    const my = h * 0.06;
    return [{ x: mx, y: my }, { x: w - mx, y: my }, { x: w - mx, y: h - my }, { x: mx, y: h - my }];
  }

  function detect(canvas) {
    const W = canvas.width;
    const H = canvas.height;
    const s = Math.min(1, 360 / Math.max(W, H));
    const w = Math.max(8, Math.round(W * s));
    const h = Math.max(8, Math.round(H * s));
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(canvas, 0, 0, w, h);
    const g = boxBlur(toGray(ctx.getImageData(0, 0, w, h).data, w * h), w, h, 2);
    const thr = otsu(g);
    const mask = new Uint8Array(w * h);
    for (let i = 0; i < mask.length; i++) mask[i] = g[i] > thr ? 1 : 0;

    const label = new Int32Array(w * h);
    const stack = new Int32Array(w * h);
    let bestLabel = 0;
    let bestSize = 0;
    let next = 1;
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i] || label[i]) continue;
      let sp = 0;
      stack[sp++] = i;
      label[i] = next;
      let size = 0;
      while (sp) {
        const p = stack[--sp];
        size++;
        const x = p % w;
        const y = (p - x) / w;
        if (x > 0 && mask[p - 1] && !label[p - 1]) { label[p - 1] = next; stack[sp++] = p - 1; }
        if (x < w - 1 && mask[p + 1] && !label[p + 1]) { label[p + 1] = next; stack[sp++] = p + 1; }
        if (y > 0 && mask[p - w] && !label[p - w]) { label[p - w] = next; stack[sp++] = p - w; }
        if (y < h - 1 && mask[p + w] && !label[p + w]) { label[p + w] = next; stack[sp++] = p + w; }
      }
      if (size > bestSize) { bestSize = size; bestLabel = next; }
      next++;
    }
    if (!bestLabel) return { quad: defaultQuad(W, H), found: false };

    let tl = null, tr = null, br = null, bl = null;
    let minSum = Infinity, maxSum = -Infinity, minDiff = Infinity, maxDiff = -Infinity;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (label[y * w + x] !== bestLabel) continue;
        const sum = x + y;
        const diff = x - y;
        if (sum < minSum) { minSum = sum; tl = { x, y }; }
        if (sum > maxSum) { maxSum = sum; br = { x, y }; }
        if (diff > maxDiff) { maxDiff = diff; tr = { x, y }; }
        if (diff < minDiff) { minDiff = diff; bl = { x, y }; }
      }
    }
    const quad = [tl, tr, br, bl].map((p) => ({ x: (p.x + 0.5) / s, y: (p.y + 0.5) / s }));
    const ratio = polyArea(quad) / (W * H);
    if (ratio < 0.12 || ratio > 0.985 || !isConvex(quad)) return { quad: defaultQuad(W, H), found: false };
    return { quad, found: true };
  }

  function solve(A, b) {
    const n = b.length;
    const M = A.map((row, i) => [...row, b[i]]);
    for (let col = 0; col < n; col++) {
      let piv = col;
      for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
      [M[col], M[piv]] = [M[piv], M[col]];
      const d = M[col][col];
      if (Math.abs(d) < 1e-12) return null;
      for (let c = col; c <= n; c++) M[col][c] /= d;
      for (let r = 0; r < n; r++) {
        if (r === col) continue;
        const f = M[r][col];
        if (!f) continue;
        for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
      }
    }
    return M.map((row) => row[n]);
  }

  function homography(dst, src) {
    const A = [];
    const b = [];
    for (let i = 0; i < 4; i++) {
      const { x: u, y: v } = dst[i];
      const { x, y } = src[i];
      A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]); b.push(x);
      A.push([0, 0, 0, u, v, 1, -u * y, -v * y]); b.push(y);
    }
    return solve(A, b);
  }

  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  function warp(canvas, quad) {
    const [tl, tr, br, bl] = quad;
    let ow = Math.max(dist(tl, tr), dist(bl, br));
    let oh = Math.max(dist(tl, bl), dist(tr, br));
    const ratio = oh / ow;
    for (const target of [Math.SQRT2, 11 / 8.5, 1 / Math.SQRT2, 8.5 / 11]) {
      if (Math.abs(ratio - target) / target < 0.12) {
        oh = ow * target;
        break;
      }
    }
    const k = Math.min(1, MAX_OUTPUT / Math.max(ow, oh));
    ow = Math.max(16, Math.round(ow * k));
    oh = Math.max(16, Math.round(oh * k));
    const Hm = homography([{ x: 0, y: 0 }, { x: ow, y: 0 }, { x: ow, y: oh }, { x: 0, y: oh }], quad);
    const W = canvas.width;
    const H = canvas.height;
    const src = canvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, W, H).data;
    const out = new ImageData(ow, oh);
    const o = out.data;
    const [a, b, c, d, e, f, g, h] = Hm;
    for (let v = 0; v < oh; v++) {
      for (let u = 0; u < ow; u++) {
        const den = g * u + h * v + 1;
        let x = (a * u + b * v + c) / den;
        let y = (d * u + e * v + f) / den;
        x = Math.min(W - 1.001, Math.max(0, x));
        y = Math.min(H - 1.001, Math.max(0, y));
        const x0 = x | 0;
        const y0 = y | 0;
        const fx = x - x0;
        const fy = y - y0;
        const i00 = (y0 * W + x0) * 4;
        const i10 = i00 + 4;
        const i01 = i00 + W * 4;
        const i11 = i01 + 4;
        const oi = (v * ow + u) * 4;
        for (let ch = 0; ch < 3; ch++) {
          const top = src[i00 + ch] + (src[i10 + ch] - src[i00 + ch]) * fx;
          const bot = src[i01 + ch] + (src[i11 + ch] - src[i01 + ch]) * fx;
          o[oi + ch] = top + (bot - top) * fy;
        }
        o[oi + 3] = 255;
      }
    }
    const result = document.createElement("canvas");
    result.width = ow;
    result.height = oh;
    result.getContext("2d").putImageData(out, 0, 0);
    return result;
  }

  function background(lum, w, h) {
    const B = Math.max(8, Math.round(Math.max(w, h) / 36));
    const gw = Math.ceil(w / B);
    const gh = Math.ceil(h / B);
    const grid = new Float32Array(gw * gh);
    for (let gy = 0; gy < gh; gy++) {
      for (let gx = 0; gx < gw; gx++) {
        const vals = [];
        const x1 = Math.min(w, (gx + 1) * B);
        const y1 = Math.min(h, (gy + 1) * B);
        const step = Math.max(1, (B / 6) | 0);
        for (let y = gy * B; y < y1; y += step) for (let x = gx * B; x < x1; x += step) vals.push(lum[y * w + x]);
        vals.sort((p, q) => p - q);
        grid[gy * gw + gx] = vals[Math.floor(vals.length * 0.9)] || 255;
      }
    }
    const smooth = boxBlur(grid, gw, gh, 1);
    for (let i = 0; i < smooth.length; i++) smooth[i] = Math.max(smooth[i], grid[i] * 0.85, 40);
    const bg = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const gyf = Math.min(gh - 1.001, Math.max(0, y / B - 0.5));
      const gy0 = gyf | 0;
      const ty = gyf - gy0;
      const gy1 = Math.min(gh - 1, gy0 + 1);
      for (let x = 0; x < w; x++) {
        const gxf = Math.min(gw - 1.001, Math.max(0, x / B - 0.5));
        const gx0 = gxf | 0;
        const tx = gxf - gx0;
        const gx1 = Math.min(gw - 1, gx0 + 1);
        const top = smooth[gy0 * gw + gx0] * (1 - tx) + smooth[gy0 * gw + gx1] * tx;
        const bot = smooth[gy1 * gw + gx0] * (1 - tx) + smooth[gy1 * gw + gx1] * tx;
        bg[y * w + x] = top * (1 - ty) + bot * ty;
      }
    }
    return bg;
  }

  function applyFilter(canvas, mode) {
    const w = canvas.width;
    const h = canvas.height;
    const img = canvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, w, h);
    const d = img.data;
    const n = w * h;
    const lum = toGray(d, n);
    const bg = background(lum, w, h);
    const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const k = 255 / bg[i];
      if (mode === "colour") {
        d[j] = clamp(d[j] * k * 1.02);
        d[j + 1] = clamp(d[j + 1] * k * 1.02);
        d[j + 2] = clamp(d[j + 2] * k * 1.02);
      } else {
        const norm = lum[i] / bg[i];
        let v;
        if (mode === "bw") v = ((norm - 0.66) / 0.14) * 255;
        else v = Math.pow(Math.min(1, Math.max(0, (norm - 0.2) / 0.74)), 1.25) * 255;
        v = clamp(v);
        d[j] = d[j + 1] = d[j + 2] = v;
      }
    }
    const out = document.createElement("canvas");
    out.width = w;
    out.height = h;
    out.getContext("2d").putImageData(img, 0, 0);
    return out;
  }

  function buildPdf(pages) {
    const enc = new TextEncoder();
    const parts = [];
    const offsets = [];
    let pos = 0;
    const push = (chunk) => {
      const bytes = typeof chunk === "string" ? enc.encode(chunk) : chunk;
      parts.push(bytes);
      pos += bytes.length;
    };
    push("%PDF-1.4\n");
    push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
    const objStart = (n) => { offsets[n] = pos; push(`${n} 0 obj\n`); };
    const kids = pages.map((_, i) => `${3 + i * 3} 0 R`).join(" ");
    objStart(1);
    push("<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
    objStart(2);
    push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>\nendobj\n`);
    pages.forEach((p, i) => {
      const pageNo = 3 + i * 3;
      const pw = 595.28;
      const ph = +(pw * p.h / p.w).toFixed(2);
      const content = `q\n${pw} 0 0 ${ph} 0 0 cm\n/Im0 Do\nQ\n`;
      objStart(pageNo);
      push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im0 ${pageNo + 2} 0 R >> >> /Contents ${pageNo + 1} 0 R >>\nendobj\n`);
      objStart(pageNo + 1);
      push(`<< /Length ${enc.encode(content).length} >>\nstream\n${content}endstream\nendobj\n`);
      objStart(pageNo + 2);
      push(`<< /Type /XObject /Subtype /Image /Width ${p.w} /Height ${p.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`);
      push(p.jpeg);
      push("\nendstream\nendobj\n");
    });
    const count = 3 + pages.length * 3;
    const xref = pos;
    let table = `xref\n0 ${count}\n0000000000 65535 f \n`;
    for (let n = 1; n < count; n++) table += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
    push(table);
    push(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    return new Blob(parts, { type: "application/pdf" });
  }

  async function canvasToJpeg(canvas, quality) {
    const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", quality));
    return new Uint8Array(await blob.arrayBuffer());
  }

  async function loadSource(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const k = Math.min(1, MAX_SOURCE / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement("canvas");
      c.width = Math.round(img.naturalWidth * k);
      c.height = Math.round(img.naturalHeight * k);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      return c;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  let pages = [];
  let mode = "bw";
  let source = null;
  let quad = null;
  let view = null;
  let onDone = null;
  let notify = () => {};

  const tick = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

  function busy(on) { $("scanBusy").hidden = !on; }

  function showAdjust() {
    $("scanTitle").textContent = "Adjust corners";
    $("scanKeep").hidden = false;
    $("scanCanvas").hidden = false;
    $("scanOverlay").style.display = "";
    $("scanPages").hidden = true;
    $("scanStage").hidden = false;
    $("scanFilter").hidden = true;
    $("scanAdjustActions").hidden = false;
    $("scanPageActions").hidden = true;
    layout();
  }

  function showPages() {
    $("scanTitle").textContent = `${pages.length} ${pages.length === 1 ? "page" : "pages"}`;
    $("scanKeep").hidden = true;
    $("scanStage").hidden = true;
    $("scanPages").hidden = false;
    $("scanFilter").hidden = false;
    $("scanAdjustActions").hidden = true;
    $("scanPageActions").hidden = false;
    renderPages();
  }

  function layout() {
    if (!source) return;
    const stage = $("scanStage");
    const sw = stage.clientWidth;
    const sh = stage.clientHeight;
    const pad = 24;
    const k = Math.min((sw - pad * 2) / source.width, (sh - pad * 2) / source.height);
    const dw = source.width * k;
    const dh = source.height * k;
    const ox = (sw - dw) / 2;
    const oy = (sh - dh) / 2;
    view = { k, ox, oy };
    const c = $("scanCanvas");
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(dw * dpr);
    c.height = Math.round(dh * dpr);
    c.style.width = `${dw}px`;
    c.style.height = `${dh}px`;
    c.style.left = `${ox}px`;
    c.style.top = `${oy}px`;
    c.getContext("2d").drawImage(source, 0, 0, c.width, c.height);
    drawOverlay();
  }

  function drawOverlay() {
    const svg = $("scanOverlay");
    const pts = quad.map((p) => ({ x: view.ox + p.x * view.k, y: view.oy + p.y * view.k }));
    const poly = pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
    svg.innerHTML = `<polygon class="quad" points="${poly}"/>` + pts.map((p, i) =>
      `<circle class="handle" cx="${p.x}" cy="${p.y}" r="11"/><circle class="hit" data-i="${i}" cx="${p.x}" cy="${p.y}" r="28"/>`
    ).join("");
  }

  let dragging = -1;
  function bindDrag() {
    const svg = $("scanOverlay");
    svg.addEventListener("pointerdown", (e) => {
      const hit = e.target.closest(".hit");
      if (!hit) return;
      dragging = Number(hit.dataset.i);
      svg.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    svg.addEventListener("pointermove", (e) => {
      if (dragging < 0) return;
      const r = svg.getBoundingClientRect();
      const x = (e.clientX - r.left - view.ox) / view.k;
      const y = (e.clientY - r.top - view.oy) / view.k;
      quad[dragging] = { x: Math.min(source.width, Math.max(0, x)), y: Math.min(source.height, Math.max(0, y)) };
      drawOverlay();
    });
    const end = () => { dragging = -1; };
    svg.addEventListener("pointerup", end);
    svg.addEventListener("pointercancel", end);
  }

  async function takePhoto(file) {
    $("scanner").hidden = false;
    $("scanStage").hidden = false;
    $("scanPages").hidden = true;
    busy(true);
    await tick();
    try {
      source = await loadSource(file);
      quad = detect(source).quad;
      busy(false);
      showAdjust();
    } catch {
      busy(false);
      notify("Couldn't read that photo");
      if (!pages.length) close();
      else showPages();
    }
  }

  async function keep() {
    busy(true);
    await tick();
    const warped = warp(source, quad);
    const page = { warped, out: applyFilter(warped, mode) };
    pages.push(page);
    source = null;
    busy(false);
    showPages();
  }

  function renderPages() {
    const grid = $("pageGrid");
    grid.replaceChildren();
    pages.forEach((p, i) => {
      const card = document.createElement("div");
      card.className = "page-card";
      const img = document.createElement("img");
      const t = document.createElement("canvas");
      const k = 480 / Math.max(p.out.width, p.out.height);
      t.width = Math.round(p.out.width * k);
      t.height = Math.round(p.out.height * k);
      t.getContext("2d").drawImage(p.out, 0, 0, t.width, t.height);
      img.src = t.toDataURL("image/jpeg", 0.75);
      img.alt = `Page ${i + 1}`;
      const num = document.createElement("span");
      num.className = "num";
      num.textContent = String(i + 1);
      const del = document.createElement("button");
      del.type = "button";
      del.className = "del";
      del.setAttribute("aria-label", `Remove page ${i + 1}`);
      del.innerHTML = '<svg viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/></svg>';
      del.addEventListener("click", () => {
        pages.splice(i, 1);
        if (!pages.length) { close(); return; }
        showPages();
      });
      card.append(img, num, del);
      grid.append(card);
    });
    $("scanSend").textContent = `Send PDF · ${pages.length} ${pages.length === 1 ? "page" : "pages"}`;
  }

  async function setMode(m) {
    mode = m;
    $("scanFilter").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.f === m));
    if (!pages.length) return;
    $("scanPages").style.opacity = "0.5";
    await tick();
    pages.forEach((p) => { p.out = applyFilter(p.warped, mode); });
    $("scanPages").style.opacity = "";
    renderPages();
  }

  async function send() {
    if (!pages.length) return;
    $("scanSend").textContent = "Making PDF…";
    await tick();
    const quality = mode === "colour" ? 0.8 : 0.78;
    const list = [];
    for (const p of pages) list.push({ jpeg: await canvasToJpeg(p.out, quality), w: p.out.width, h: p.out.height });
    const pdf = buildPdf(list);
    const d = new Date();
    const name = `Scan ${d.toLocaleDateString([], { day: "numeric", month: "short" })} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }).replace(":", ".")}.pdf`;
    const cb = onDone;
    close();
    if (cb) cb(pdf, name);
  }

  function close() {
    $("scanner").hidden = true;
    pages = [];
    source = null;
    quad = null;
  }

  function start(done, toastFn) {
    onDone = done;
    notify = toastFn || notify;
    pages = [];
    $("scanInput").click();
  }

  let bound = false;
  function bind() {
    if (bound || !$("scanner")) return;
    bound = true;
    bindDrag();
    $("scanInput").addEventListener("change", (e) => {
      const f = e.target.files[0];
      e.target.value = "";
      if (f) takePhoto(f);
    });
    $("scanKeep").addEventListener("click", keep);
    $("scanRetake").addEventListener("click", () => $("scanInput").click());
    $("scanAddPage").addEventListener("click", () => $("scanInput").click());
    $("scanSend").addEventListener("click", send);
    $("scanCancel").addEventListener("click", () => {
      if (pages.length) notify("Scan discarded");
      close();
    });
    $("scanFilter").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-f]");
      if (b) setMode(b.dataset.f);
    });
    addEventListener("resize", () => { if (!$("scanner").hidden && source) layout(); });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind);
  else bind();

  window.DropScanner = { start, detect, warp, applyFilter, buildPdf, takePhoto, keep, send, setMode, _state: () => ({ pages, quad, mode }) };
})();
