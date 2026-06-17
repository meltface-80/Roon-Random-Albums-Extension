/*
 * sharecard.js — render an album share card as a PNG, in the browser.
 *
 * Copyright (c) 2026 Lewis Menzies (Music Duck / MusicD)
 * Released under the MIT License. See the LICENSE file for details.
 *
 * Layout (1200 × 592, fixed):
 *
 *   +---------------------+-----------------------------+
 *   |                     |  RELEASED DD Mon YYYY       |
 *   |   cover 480×480     |  Album Title (wraps ×3)     |
 *   |                     |  by Artist (wraps ×3)       |
 *   |                     |              [MusicD logo]  |
 *   +---------------------+-----------------------------+
 *
 *  The three text items are distributed space-evenly within the cover height.
 */

const ShareCard = (() => {
  const CARD_W     = 1200;
  const PAD        = 56;
  const COVER      = 480;
  const COVER_X    = PAD;
  const COVER_Y    = PAD;
  const CARD_H     = PAD * 2 + COVER;   // 592, fixed
  const RIGHT_X    = PAD + COVER + 44;
  const RIGHT_W    = CARD_W - RIGHT_X - PAD;
  const WORDMARK_W = 120;

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
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('image load failed: ' + src));
      img.src = src;
    });
  }

  function wrapText(ctx, text, maxWidth, maxLines) {
    if (!text) return [];
    const words = String(text).split(/\s+/);
    const lines = [];
    let cur = '';
    for (const w of words) {
      const candidate = cur ? cur + ' ' + w : w;
      if (ctx.measureText(candidate).width <= maxWidth) {
        cur = candidate;
      } else {
        if (cur) lines.push(cur);
        if (lines.length >= maxLines) { cur = ''; break; }
        cur = w;
      }
    }
    if (cur && lines.length < maxLines) lines.push(cur);
    if (lines.length === maxLines) {
      let last = lines[maxLines - 1];
      const joined = lines.join(' ');
      if (joined.length < String(text).length) {
        while (last.length && ctx.measureText(last + '…').width > maxWidth) last = last.slice(0, -1);
        lines[maxLines - 1] = last.replace(/\s+$/, '') + '…';
      }
    }
    return lines;
  }

  async function render(data) {
    const cover = await loadImage(data.coverUrl).catch(() => null);
    const wm    = await loadImage(data.wordmarkUrl).catch(() => null);

    const canvas = document.createElement('canvas');
    canvas.width  = CARD_W;
    canvas.height = CARD_H;
    const ctx = canvas.getContext('2d');
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';

    // --- Measure text blocks ---
    const releaseStr = formatReleaseDate(data.releaseRaw);
    const metaText   = releaseStr ? 'Released ' + releaseStr : null;
    const META_H     = 28;

    const TITLE_LH = 56;
    ctx.font = '700 46px "Manrope", sans-serif';
    const titleLines = wrapText(ctx, data.title || '', RIGHT_W, 3);
    const titleH = titleLines.length * TITLE_LH;

    const ARTIST_LH = 40;
    ctx.font = '400 30px "Manrope", sans-serif';
    const artistLines = wrapText(ctx, 'by ' + (data.artist || ''), RIGHT_W, 3);
    const artistH = artistLines.length * ARTIST_LH;

    // --- Space-evenly within cover height ---
    const nSections = (metaText ? 1 : 0) + 1 + 1;
    const contentH  = (metaText ? META_H : 0) + titleH + artistH;
    const gap = Math.max(8, (COVER - contentH) / (nSections + 1));

    // --- Background ---
    const bg = ctx.createLinearGradient(0, 0, 0, CARD_H);
    bg.addColorStop(0, '#121417');
    bg.addColorStop(1, '#0a0a0b');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, CARD_W, CARD_H);

    // --- Cover image ---
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = 36;
    ctx.shadowOffsetY = 14;
    roundRect(ctx, COVER_X, COVER_Y, COVER, COVER, 18);
    ctx.fillStyle = '#1a1a1a';
    ctx.fill();
    ctx.restore();
    ctx.save();
    roundRect(ctx, COVER_X, COVER_Y, COVER, COVER, 18);
    ctx.clip();
    if (cover) drawCover(ctx, cover, COVER_X, COVER_Y, COVER, COVER);
    else { ctx.fillStyle = '#1a1a1a'; ctx.fillRect(COVER_X, COVER_Y, COVER, COVER); }
    ctx.restore();

    // --- Info column: space-evenly within COVER area ---
    let ry = COVER_Y + gap;

    if (metaText) {
      ctx.fillStyle = '#7f868d';
      ctx.font = '600 22px "Manrope", sans-serif';
      ctx.fillText(metaText.toUpperCase(), RIGHT_X, ry);
      ry += META_H + gap;
    }

    ctx.fillStyle = '#ffffff';
    ctx.font = '700 46px "Manrope", sans-serif';
    titleLines.forEach((line, i) => ctx.fillText(line, RIGHT_X, ry + i * TITLE_LH));
    ry += titleH + gap;

    ctx.fillStyle = '#cdd2d8';
    ctx.font = '400 30px "Manrope", sans-serif';
    artistLines.forEach((line, i) => ctx.fillText(line, RIGHT_X, ry + i * ARTIST_LH));

    // --- Wordmark, bottom-right ---
    if (wm) {
      const wmH = Math.round(WORDMARK_W * (wm.height / wm.width));
      ctx.globalAlpha = 0.85;
      ctx.drawImage(wm, CARD_W - PAD - WORDMARK_W, CARD_H - PAD - wmH, WORDMARK_W, wmH);
      ctx.globalAlpha = 1;
    }

    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('toBlob failed')), 'image/png');
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

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  return { render };
})();
