// Project I/O — export/import projects as zip files and shareable URLs.
// Uses JSZip-compatible manual zip creation (no dependencies).

/**
 * Export a project as a downloadable .zip file.
 * Uses the browser's Compression Streams API (widely supported).
 */
export async function exportProjectZip(project) {
  const files = {};

  // Add all project files
  for (const [path, file] of Object.entries(project.files)) {
    files[path] = file.content;
  }

  // Add a project manifest
  files['daisy-project.json'] = JSON.stringify({
    name: project.name,
    board: project.board,
    activeFile: project.activeFile,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  }, null, 2);

  // Build a simple ZIP using the DeflateRaw stream
  const zipBlob = await buildZip(files);

  // Trigger download
  const url = URL.createObjectURL(zipBlob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${project.name || 'daisy-project'}.zip`;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Import a project from a .zip file.
 * @param {File} file - The zip file to import
 * @returns {Object} project
 */
export async function importProjectZip(file) {
  const buffer = await file.arrayBuffer();
  const entries = await readZip(buffer);

  // Look for manifest
  let manifest = null;
  if (entries['daisy-project.json']) {
    try {
      manifest = JSON.parse(entries['daisy-project.json']);
    } catch { /* ignore */ }
  }

  // Build project from files
  const project = {
    name: manifest?.name || file.name.replace(/\.zip$/i, ''),
    board: manifest?.board || 'patch',
    activeFile: manifest?.activeFile || 'main.cpp',
    openTabs: [],
    files: {},
    createdAt: manifest?.createdAt || Date.now(),
    updatedAt: Date.now(),
  };

  // Add all source files
  for (const [path, content] of Object.entries(entries)) {
    if (path === 'daisy-project.json') continue;
    // Only include source files
    if (path.match(/\.(cpp|cc|c|h|hpp|hxx)$/i)) {
      project.files[path] = { content, dirty: false };
    }
  }

  // Ensure at least one file
  if (Object.keys(project.files).length === 0) {
    throw new Error('No source files found in zip');
  }

  // Set active file
  if (!project.files[project.activeFile]) {
    project.activeFile = Object.keys(project.files)[0];
  }
  project.openTabs = [project.activeFile];

  return project;
}

/**
 * Export project as a shareable base64 URL (for small projects only).
 */
export function exportProjectURL(project) {
  const data = {
    n: project.name,
    b: project.board,
    a: project.activeFile,
    f: {},
  };
  for (const [path, file] of Object.entries(project.files)) {
    data.f[path] = file.content;
  }
  const json = JSON.stringify(data);
  const encoded = btoa(unescape(encodeURIComponent(json)));

  // Check size — URLs should be < 2000 chars for broad compatibility
  if (encoded.length > 8000) {
    throw new Error('Project too large for URL sharing. Use zip export instead.');
  }

  return `${window.location.origin}${window.location.pathname}#project=${encoded}`;
}

/**
 * Import project from a URL hash parameter.
 */
export function importProjectURL(hash) {
  const match = hash.match(/project=([A-Za-z0-9+/=]+)/);
  if (!match) return null;

  try {
    const json = decodeURIComponent(escape(atob(match[1])));
    const data = JSON.parse(json);

    const project = {
      name: data.n || 'shared-project',
      board: data.b || 'patch',
      activeFile: data.a || 'main.cpp',
      openTabs: [data.a || 'main.cpp'],
      files: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    for (const [path, content] of Object.entries(data.f || {})) {
      project.files[path] = { content, dirty: false };
    }

    if (Object.keys(project.files).length === 0) return null;
    return project;
  } catch {
    return null;
  }
}

/**
 * Download a single file as .cpp.
 */
export function downloadFile(filename, content) {
  const blob = new Blob([content], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── ZIP Utilities (no dependencies) ─────────────────────────────

/**
 * Build a ZIP file from a {filename: string_content} object.
 * Uses the Compression Streams API for deflate.
 */
async function buildZip(files) {
  const entries = [];
  let offset = 0;

  for (const [name, content] of Object.entries(files)) {
    const encoded = new TextEncoder().encode(content);

    // Try to compress, fall back to stored if CompressionStream unavailable
    let compressed;
    let method = 0; // 0 = stored
    try {
      if (typeof CompressionStream !== 'undefined') {
        const cs = new CompressionStream('deflate-raw');
        const writer = cs.writable.getWriter();
        const reader = cs.readable.getReader();
        writer.write(encoded);
        writer.close();

        const chunks = [];
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
        }
        compressed = concatArrays(chunks);
        method = 8; // deflate
      } else {
        compressed = encoded;
      }
    } catch {
      compressed = encoded;
    }

    const crc = crc32(encoded);
    const nameBytes = new TextEncoder().encode(name);

    entries.push({
      name: nameBytes,
      compressed,
      uncompressed: encoded,
      crc,
      method,
      offset,
    });

    // Local file header: 30 + nameLen + compressedLen
    offset += 30 + nameBytes.length + compressed.length;
  }

  // Build the zip
  const parts = [];

  // Local file headers + data
  for (const e of entries) {
    const header = new ArrayBuffer(30);
    const view = new DataView(header);
    view.setUint32(0, 0x04034b50, true);  // Local file header signature
    view.setUint16(4, 20, true);           // Version needed
    view.setUint16(6, 0, true);            // Flags
    view.setUint16(8, e.method, true);     // Compression method
    view.setUint16(10, 0, true);           // Mod time
    view.setUint16(12, 0, true);           // Mod date
    view.setUint32(14, e.crc, true);       // CRC-32
    view.setUint32(18, e.compressed.length, true);   // Compressed size
    view.setUint32(22, e.uncompressed.length, true); // Uncompressed size
    view.setUint16(26, e.name.length, true);         // Filename length
    view.setUint16(28, 0, true);           // Extra field length

    parts.push(new Uint8Array(header), e.name, e.compressed);
  }

  // Central directory
  const cdStart = offset;
  for (const e of entries) {
    const cd = new ArrayBuffer(46);
    const view = new DataView(cd);
    view.setUint32(0, 0x02014b50, true);   // Central directory header
    view.setUint16(4, 20, true);           // Version made by
    view.setUint16(6, 20, true);           // Version needed
    view.setUint16(8, 0, true);            // Flags
    view.setUint16(10, e.method, true);    // Compression method
    view.setUint16(12, 0, true);           // Mod time
    view.setUint16(14, 0, true);           // Mod date
    view.setUint32(16, e.crc, true);       // CRC-32
    view.setUint32(20, e.compressed.length, true);   // Compressed size
    view.setUint32(24, e.uncompressed.length, true); // Uncompressed size
    view.setUint16(28, e.name.length, true);         // Filename length
    view.setUint16(30, 0, true);           // Extra field length
    view.setUint16(32, 0, true);           // Comment length
    view.setUint16(34, 0, true);           // Disk number
    view.setUint16(36, 0, true);           // Internal attributes
    view.setUint32(38, 0, true);           // External attributes
    view.setUint32(42, e.offset, true);    // Local header offset

    parts.push(new Uint8Array(cd), e.name);
    offset += 46 + e.name.length;
  }

  const cdSize = offset - cdStart;

  // End of central directory
  const eocd = new ArrayBuffer(22);
  const eocdView = new DataView(eocd);
  eocdView.setUint32(0, 0x06054b50, true);  // EOCD signature
  eocdView.setUint16(4, 0, true);           // Disk number
  eocdView.setUint16(6, 0, true);           // CD disk number
  eocdView.setUint16(8, entries.length, true);  // Entries on this disk
  eocdView.setUint16(10, entries.length, true); // Total entries
  eocdView.setUint32(12, cdSize, true);      // CD size
  eocdView.setUint32(16, cdStart, true);     // CD offset
  eocdView.setUint16(20, 0, true);           // Comment length

  parts.push(new Uint8Array(eocd));

  return new Blob(parts, { type: 'application/zip' });
}

/**
 * Read a ZIP file and return {filename: string_content}.
 * Simple reader — handles stored and deflate methods.
 */
async function readZip(buffer) {
  const view = new DataView(buffer);
  const files = {};
  let pos = 0;

  while (pos < buffer.byteLength - 4) {
    const sig = view.getUint32(pos, true);
    if (sig !== 0x04034b50) break; // Not a local file header

    const method = view.getUint16(pos + 8, true);
    const compSize = view.getUint32(pos + 18, true);
    const uncompSize = view.getUint32(pos + 22, true);
    const nameLen = view.getUint16(pos + 26, true);
    const extraLen = view.getUint16(pos + 28, true);

    const nameBytes = new Uint8Array(buffer, pos + 30, nameLen);
    const name = new TextDecoder().decode(nameBytes);

    const dataStart = pos + 30 + nameLen + extraLen;
    const compressedData = new Uint8Array(buffer, dataStart, compSize);

    let content;
    if (method === 0) {
      // Stored
      content = new TextDecoder().decode(compressedData);
    } else if (method === 8) {
      // Deflate
      try {
        if (typeof DecompressionStream !== 'undefined') {
          const ds = new DecompressionStream('deflate-raw');
          const writer = ds.writable.getWriter();
          const reader = ds.readable.getReader();
          writer.write(compressedData);
          writer.close();

          const chunks = [];
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
          }
          content = new TextDecoder().decode(concatArrays(chunks));
        } else {
          content = new TextDecoder().decode(compressedData);
        }
      } catch {
        content = new TextDecoder().decode(compressedData);
      }
    } else {
      // Unknown method — skip
      pos = dataStart + compSize;
      continue;
    }

    files[name] = content;
    pos = dataStart + compSize;
  }

  return files;
}

function concatArrays(arrays) {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    result.set(a, offset);
    offset += a.length;
  }
  return result;
}

/**
 * CRC-32 computation.
 */
function crc32(data) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
