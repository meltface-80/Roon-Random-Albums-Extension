/*
 * sharecard.js — render an album share card as a PNG, in the browser.
 *
 * Copyright (c) 2026 Lewis Menzies (Music Duck / MusicD)
 * Released under the MIT License. See the LICENSE file for details.
 *
 * Layout (1200 × 600, fixed):
 *
 *   +---------------------+-----------------------------+
 *   |                     |                             |
 *   |                     |   RELEASED 2009             |
 *   |  album art 600×600  |   Album Title               |
 *   |   (full bleed left) |   by Artist                 |
 *   |                     |                  [MusicD]   |
 *   +---------------------+-----------------------------+
 *
 *  Art fills the entire left half edge-to-edge.
 *  Year, title, and artist are vertically centred in the right half.
 *  Wordmark is pinned to the bottom-right corner.
 */

const ShareCard = (() => {
  const CARD_W    = 1200;
  const CARD_H    = 600;
  const ART_W     = 600;   // fills left half exactly
  const ART_H     = 600;
  const DIVIDER   = 40;    // gap between art edge and text start
  const TEXT_X    = ART_W + DIVIDER;
  const TEXT_PAD_R = 48;
  const TEXT_W    = CARD_W - TEXT_X - TEXT_PAD_R;
  const WORDMARK_W = 110;
  const WORDMARK_PAD = 36;

  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  function formatReleaseDate(raw) {
    if (!raw) return null;
    const s = String(raw).trim();
    if (!s) return null;
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (m) {
      const y = +m[1], mo = +m[2], d = +m[3];
      if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return `${d} ${MONTHS[mo-1]} ${y}`;
    }
    m = s.match(/^(\d{4})-(\d{1,2})$/);
    if (m) { const mo = +m[2]; if (mo>=1&&mo<=12) return `${MONTHS[mo-1]} ${m[1]}`; }
    m = s.match(/^(\d{4})$/);
    if (m) return m[1];
    return s;
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload  = () => resolve(img);
      img.onerror = () => reject(new Error('image load failed: ' + src));
      img.src = src;
    });
  }

  // Word-wrap text to maxWidth. Returns { lines, overflow } — overflow is true
  // when the text didn't fully fit in maxLines (or a single word is wider than
  // the column). Ellipsis is NOT applied here: fitText() first tries smaller
  // font sizes and only ellipsizes as the final fallback.
  function wrapText(ctx, text, maxWidth, maxLines) {
    if (!text) return { lines: [], overflow: false };
    const words = String(text).split(/\s+/);
    const lines = [];
    let cur = '';
    let overflow = false;
    for (const w of words) {
      const candidate = cur ? cur + ' ' + w : w;
      if (ctx.measureText(candidate).width <= maxWidth) {
        cur = candidate;
      } else {
        if (cur) lines.push(cur);
        if (lines.length >= maxLines) { cur = ''; overflow = true; break; }
        cur = w;
        if (ctx.measureText(w).width > maxWidth) overflow = true;  // single over-wide word
      }
    }
    if (cur && lines.length < maxLines) lines.push(cur);
    else if (cur) overflow = true;
    return { lines, overflow };
  }

  // Fit text into maxLines within maxWidth by stepping the font size down until
  // it fits; only when even the smallest size overflows is the last line
  // ellipsized. Returns { lines, size, lh } for the chosen size.
  function fitText(ctx, text, maxWidth, maxLines, weight, sizes, lhRatio) {
    let r = null, size = sizes[0];
    for (const s of sizes) {
      size = s;
      ctx.font = `${weight} ${s}px "Manrope", sans-serif`;
      r = wrapText(ctx, text, maxWidth, maxLines);
      if (!r.overflow) break;
    }
    if (r.overflow && r.lines.length) {
      // Final fallback at the smallest size: trim the last line to an ellipsis.
      let last = r.lines[r.lines.length - 1];
      while (last.length && ctx.measureText(last + '…').width > maxWidth) last = last.slice(0, -1);
      r.lines[r.lines.length - 1] = last.replace(/\s+$/, '') + '…';
    }
    return { lines: r.lines, size, lh: Math.round(size * lhRatio) };
  }

  async function render(data) {
    const cover = await loadImage(data.coverUrl).catch(() => null);
    const wm    = await loadImage(data.wordmarkUrl).catch(() => null);

    const canvas = document.createElement('canvas');
    canvas.width  = CARD_W;
    canvas.height = CARD_H;
    const ctx = canvas.getContext('2d');
    ctx.textBaseline = 'top';
    ctx.textAlign    = 'left';

    // --- Background (right half; art covers the left) ---
    ctx.fillStyle = '#0e1012';
    ctx.fillRect(0, 0, CARD_W, CARD_H);

    // --- Cover art — full-bleed left half ---
    if (cover) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, ART_W, ART_H);
      ctx.clip();
      drawCover(ctx, cover, 0, 0, ART_W, ART_H);
      ctx.restore();
    } else {
      ctx.fillStyle = '#1a1a1a';
      ctx.fillRect(0, 0, ART_W, ART_H);
    }

    // Subtle vertical gradient on the right edge of the art to
    // ease the hard split (optional — remove if too heavy).
    const fade = ctx.createLinearGradient(ART_W - 40, 0, ART_W, 0);
    fade.addColorStop(0, 'rgba(14,16,18,0)');
    fade.addColorStop(1, 'rgba(14,16,18,0.55)');
    ctx.fillStyle = fade;
    ctx.fillRect(ART_W - 40, 0, 40, CARD_H);

    // --- Measure text blocks ---
    const releaseStr = formatReleaseDate(data.releaseRaw);
    const metaText   = releaseStr ? 'Released ' + releaseStr : null;
    const META_SIZE  = 26;
    const META_H     = META_SIZE + 4;
    const META_GAP   = 24;   // gap below the year line

    // Title and artist are adaptive: up to 4 lines each, stepping the font size
    // down until the text fits (56→36px title, 37→24px artist); only when even
    // the smallest size overflows is the last line ellipsized. Worst case
    // (meta + 4 title lines @36 + 4 artist lines @24 ≈ 426px) fits the 600px card.
    const title  = fitText(ctx, data.title || '', TEXT_W, 4, 700, [56, 48, 42, 36, 31, 27], 68 / 56);
    const titleH = title.lines.length * title.lh;

    const artist  = fitText(ctx, 'by ' + (data.artist || ''), TEXT_W, 4, 400, [37, 32, 28, 24, 21], 48 / 37);
    const artistH = artist.lines.length * artist.lh;

    const BLOCK_GAP  = 18;   // gap between title and artist

    // Total height of the text block
    const blockH = (metaText ? META_H + META_GAP : 0) + titleH + BLOCK_GAP + artistH;

    // Vertically centre the block in the right pane, with a slight upward nudge
    // (optical centre sits a little above mathematical centre).
    const startY = Math.round((CARD_H - blockH) / 2) - 10;
    let ry = Math.max(40, startY);

    // --- Year / release date ---
    if (metaText) {
      ctx.fillStyle = '#7f868d';
      ctx.font = `600 ${META_SIZE}px "Manrope", sans-serif`;
      ctx.fillText(metaText.toUpperCase(), TEXT_X, ry);
      ry += META_H + META_GAP;
    }

    // --- Album title ---
    ctx.fillStyle = '#ffffff';
    ctx.font = `700 ${title.size}px "Manrope", sans-serif`;
    title.lines.forEach((line, i) => ctx.fillText(line, TEXT_X, ry + i * title.lh));
    ry += titleH + BLOCK_GAP;

    // --- Artist ---
    ctx.fillStyle = '#c0c6cc';
    ctx.font = `400 ${artist.size}px "Manrope", sans-serif`;
    artist.lines.forEach((line, i) => ctx.fillText(line, TEXT_X, ry + i * artist.lh));

    // --- Wordmark pinned bottom-right (only if a wordmark image was supplied) ---
    if (wm) {
      const wmH = Math.round(WORDMARK_W * (wm.height / wm.width));
      ctx.globalAlpha = 0.88;
      ctx.drawImage(
        wm,
        CARD_W - WORDMARK_PAD - WORDMARK_W,
        CARD_H - WORDMARK_PAD - wmH,
        WORDMARK_W, wmH
      );
      ctx.globalAlpha = 1;
    }

    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => blob ? resolve(blob) : reject(new Error('toBlob failed')),
        'image/png'
      );
    });
  }

  function drawCover(ctx, img, dx, dy, dw, dh) {
    const ir = img.width / img.height;
    const dr = dw / dh;
    let sx, sy, sw, sh;
    if (ir > dr) { sh = img.height; sw = sh * dr; sx = (img.width - sw) / 2; sy = 0; }
    else         { sw = img.width;  sh = sw / dr; sx = 0; sy = (img.height - sh) / 2; }
    ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
  }

  return { render };
})();
