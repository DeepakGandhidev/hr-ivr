/**
 * Bulk CV import limits.
 *
 * Deliberately dependency-free: the upload UI is a client component, and
 * importing these through the package barrel would pull zod into the browser
 * bundle to deliver three integers. Both the route and the UI read them from
 * here, so the button's copy cannot drift from what the server enforces.
 */

/** CVs a recruiter may select, and a single request may carry, at one time. */
export const MAX_CV_UPLOAD_FILES = 100;

/**
 * How many of those go in one HTTP request.
 *
 * A hundred CVs is roughly 30MB of multipart body. nginx defaults
 * `client_max_body_size` to 1MB and most hosting platforms cap a request body
 * well below 30MB, so sending the selection in one piece fails in deployment
 * even though it passes locally. Splitting it also means the progress counter
 * moves every few seconds instead of showing one dead spinner for minutes.
 *
 * The server still accepts up to MAX_CV_UPLOAD_FILES in a single request, so an
 * API caller is not forced to batch — this is the UI's choice, not the contract.
 */
export const CV_UPLOAD_BATCH_SIZE = 20;

/** Mirrors the worker extractor's own per-attachment ceiling. */
export const MAX_CV_FILE_BYTES = 15 * 1024 * 1024;

/**
 * Byte budget for one request, applied alongside CV_UPLOAD_BATCH_SIZE.
 *
 * The count alone is not enough: twenty CVs are usually about 5MB but could be
 * twenty scans at the per-file ceiling, which is 300MB in one request. Closing
 * a batch on whichever limit is reached first keeps every request small enough
 * to survive a proxy, whatever the mix of files happens to be.
 *
 * Kept at or above MAX_CV_FILE_BYTES so a single largest-permitted file always
 * fits in a batch by itself rather than being unsendable.
 */
export const CV_UPLOAD_BATCH_BYTES = 20 * 1024 * 1024;

/**
 * Ceiling on one request's worth of CVs. Without it, MAX_CV_UPLOAD_FILES at the
 * per-file limit is a 1.5GB request the route would happily buffer into memory.
 */
export const MAX_CV_UPLOAD_TOTAL_BYTES = 100 * 1024 * 1024;

/**
 * Split a selection into requests that respect both batch limits.
 *
 * A file at or over the byte budget goes in a batch of its own rather than
 * being dropped — the server's per-file check is what rejects an oversized one,
 * and it reports that against the filename where the recruiter can see it.
 */
export function planCvUploadBatches<T extends { size: number }>(files: T[]): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let bytes = 0;

  for (const file of files) {
    const wouldExceed =
      current.length >= CV_UPLOAD_BATCH_SIZE || bytes + file.size > CV_UPLOAD_BATCH_BYTES;

    if (current.length > 0 && wouldExceed) {
      batches.push(current);
      current = [];
      bytes = 0;
    }

    current.push(file);
    bytes += file.size;
  }

  if (current.length > 0) batches.push(current);
  return batches;
}
