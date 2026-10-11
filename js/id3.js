// Minimal ID3v2 reader: pulls title, artist and cover art out of MP3 files added from the device.
export async function readTags(file) {
  try {
    const head = new Uint8Array(await file.slice(0, 10).arrayBuffer());
    if (head[0] !== 0x49 || head[1] !== 0x44 || head[2] !== 0x33) return {};
    const version = head[3];
    const size = syncsafe(head, 6);
    const buf = new Uint8Array(await file.slice(10, 10 + Math.min(size, 4 * 1024 * 1024)).arrayBuffer());
    const tags = {};
    let p = 0;
    if (head[5] & 0x40) p += version === 4 ? syncsafe(buf, 0) : (readU32(buf, 0) + 4); // extended header
    while (p + 10 <= buf.length) {
      const id = String.fromCharCode(buf[p], buf[p + 1], buf[p + 2], buf[p + 3]);
      if (!/^[A-Z0-9]{4}$/.test(id)) break;
      const len = version === 4 ? syncsafe(buf, p + 4) : readU32(buf, p + 4);
      const body = buf.subarray(p + 10, p + 10 + len);
      if (id === 'TIT2') tags.title = text(body);
      else if (id === 'TPE1') tags.artist = text(body);
      else if (id === 'TALB') tags.album = text(body);
      else if (id === 'APIC' && !tags.picture) tags.picture = picture(body);
      p += 10 + len;
    }
    if (tags.picture) {
      tags.artwork = await thumbnail(tags.picture).catch(() => '');
      delete tags.picture;
    }
    return tags;
  } catch {
    return {};
  }
}

function syncsafe(b, o) { return (b[o] << 21) | (b[o + 1] << 14) | (b[o + 2] << 7) | b[o + 3]; }
function readU32(b, o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }

function decode(bytes, enc) {
  const label = enc === 0 ? 'latin1' : enc === 1 ? 'utf-16' : enc === 2 ? 'utf-16be' : 'utf-8';
  return new TextDecoder(label).decode(bytes).replace(/\0+$/g, '').replace(/^﻿/, '').trim();
}

function text(body) { return decode(body.subarray(1), body[0]).split('\0')[0]; }

function picture(body) {
  const enc = body[0];
  let p = 1;
  let mimeEnd = p;
  while (mimeEnd < body.length && body[mimeEnd] !== 0) mimeEnd++;
  const mime = new TextDecoder('latin1').decode(body.subarray(p, mimeEnd)) || 'image/jpeg';
  p = mimeEnd + 2; // skip null + picture type byte
  // Skip the description, which is null-terminated (two null bytes for UTF-16).
  if (enc === 1 || enc === 2) {
    while (p + 1 < body.length && !(body[p] === 0 && body[p + 1] === 0)) p += 2;
    p += 2;
  } else {
    while (p < body.length && body[p] !== 0) p++;
    p += 1;
  }
  return new Blob([body.subarray(p)], { type: mime.includes('/') ? mime : `image/${mime.toLowerCase()}` });
}

// Shrink cover art so it can be stored alongside track metadata cheaply.
async function thumbnail(blob, size = 300) {
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, size / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.82);
}

export function guessFromFilename(name) {
  const base = name.replace(/\.[^.]+$/, '').replace(/_/g, ' ').trim();
  const m = base.match(/^(.+?)\s+-\s+(.+)$/);
  if (!m) return { title: base };
  const [left, right] = [m[1].trim(), m[2].trim()];
  if (/^\d{1,3}$/.test(left)) return guessFromFilename(right);            // "01 - Song"
  if (/\.(com|net|org|info|in|co|me|io|cc|site|xyz)\b/i.test(right) || /\b(mp3|kbps)\b/i.test(right)) {
    return { title: left };                                                  // "Song - SiteName.com"
  }
  return { artist: left, title: right };
}

export function probeDuration(file) {
  return new Promise((resolve) => {
    const a = new Audio();
    const url = URL.createObjectURL(file);
    const done = (d) => { URL.revokeObjectURL(url); resolve(isFinite(d) ? d : 0); };
    a.preload = 'metadata';
    a.onloadedmetadata = () => done(a.duration);
    a.onerror = () => done(0);
    setTimeout(() => done(0), 8000);
    a.src = url;
  });
}
