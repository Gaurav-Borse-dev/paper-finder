// Utilities for handling Google Drive share links.

const FILE_ID_RE = [
  /\/file\/d\/([a-zA-Z0-9_-]+)/,
  /[?&]id=([a-zA-Z0-9_-]+)/,
  /\/d\/([a-zA-Z0-9_-]+)/,
];

export function extractDriveId(url: string): string | null {
  if (!url) return null;
  for (const re of FILE_ID_RE) {
    const m = url.match(re);
    if (m) return m[1];
  }
  return null;
}

export function drivePreviewUrl(url: string): string | null {
  const id = extractDriveId(url);
  return id ? `https://drive.google.com/file/d/${id}/preview` : null;
}

export function driveDownloadUrl(url: string): string {
  const id = extractDriveId(url);
  return id ? `https://drive.google.com/uc?export=download&id=${id}` : url;
}

export function driveOpenUrl(url: string): string {
  const id = extractDriveId(url);
  return id ? `https://drive.google.com/file/d/${id}/view` : url;
}

export function isValidDriveUrl(url: string): boolean {
  return extractDriveId(url) !== null;
}
