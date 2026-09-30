import path from 'node:path';
import fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { Storage } from '@google-cloud/storage';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { validationError } from '../lib/errors.js';

/**
 * Object storage for user-uploaded images.
 *
 * Two drivers behind one interface. GCS is the real one; the local-disk driver
 * exists so a developer without Google credentials can still run the upload
 * path end to end, rather than the feature being untestable off a cloud box.
 * Which one runs is decided by GCS_BUCKET being set, not by NODE_ENV — a
 * staging box may legitimately want either.
 *
 * Authentication is Application Default Credentials: `gcloud auth
 * application-default login` locally, the attached service account on a Google
 * host. Deliberately no key file — this project's org policy forbids creating
 * service-account keys (constraints/iam.disableServiceAccountKeyCreation), and
 * a long-lived key committed by accident is exactly what that policy prevents.
 */

// A doctor's card shows a small round portrait. 512px square is enough for a
// retina @2x render of a 256px avatar and keeps objects well under 100kB.
const AVATAR_SIZE = 512;
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
// JPEG and PNG only. Both are universally produced by phone cameras and photo
// tools, and both are what the UI promises — an accept list wider than the
// promise means a file the picker happily offers is rejected after upload.
// HEIC is deliberately excluded: sharp cannot decode it without libheif, so
// accepting it here would fail later with a far less clear error.
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png']);
export const ALLOWED_EXTENSIONS = '.jpg, .jpeg, .png';

const LOCAL_ROOT = path.resolve('uploads');
const localPublicBase = () => `${env.BASE_URL.replace(/\/$/, '')}/uploads`;

const useGcs = () => Boolean(env.GCS_BUCKET);

/**
 * Credentials, in the order a deploy is likely to supply them.
 *
 * GCS_CREDENTIALS_JSON carries the key's CONTENTS in an env var. That is the
 * option for a non-Google host such as Hostinger: ADC has nothing to discover
 * there, and passing the JSON inline means no secret is ever written to that
 * machine's filesystem where a stray backup or a shell user could read it.
 *
 * Falling through to {} lets the library do its normal ADC lookup —
 * GOOGLE_APPLICATION_CREDENTIALS, then the metadata server on a Google host,
 * then the developer's `gcloud auth application-default login`.
 */
const gcsOptions = () => {
  const opts = env.GCS_PROJECT_ID ? { projectId: env.GCS_PROJECT_ID } : {};
  if (!env.GCS_CREDENTIALS_JSON) return opts;
  try {
    const creds = JSON.parse(env.GCS_CREDENTIALS_JSON);
    return { ...opts, credentials: creds, projectId: opts.projectId || creds.project_id };
  } catch {
    // A malformed value must not silently fall back to some other identity —
    // that would upload to the wrong place, or fail much later with a confusing
    // permissions error.
    logger.error('GCS_CREDENTIALS_JSON is not valid JSON — refusing to guess an identity');
    throw new Error('GCS_CREDENTIALS_JSON is not valid JSON');
  }
};

// One client per process. Constructing a Storage() per request would re-resolve
// credentials and leak sockets.
let gcsClient = null;
const bucket = () => {
  if (!gcsClient) gcsClient = new Storage(gcsOptions());
  return gcsClient.bucket(env.GCS_BUCKET);
};

/**
 * Normalise whatever the browser sent into one predictable object.
 *
 * Always re-encodes rather than trusting the upload: it strips EXIF (which can
 * carry the photographer's GPS location), flattens transparency onto white so a
 * PNG does not render as a black square, and guarantees the stored file really
 * is the image type we claim. A malicious file renamed .jpg does not survive
 * a sharp round-trip.
 */
export const processAvatar = async (buffer, { size = AVATAR_SIZE } = {}) => {
  try {
    const out = await sharp(buffer)
      .rotate() // honour EXIF orientation BEFORE the metadata is stripped
      .resize(size, size, { fit: 'cover', position: 'attention' })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 86, progressive: true, mozjpeg: true })
      .toBuffer();
    return { buffer: out, contentType: 'image/jpeg', ext: 'jpg' };
  } catch (err) {
    logger.warn({ err: err.message }, 'avatar processing failed');
    throw validationError([{ path: 'photo', message: 'That file could not be read as an image' }]);
  }
};

export const assertUploadable = (file) => {
  if (!file) throw validationError([{ path: 'photo', message: 'No file was uploaded' }]);
  if (file.size > MAX_UPLOAD_BYTES) {
    const mb = (file.size / (1024 * 1024)).toFixed(1);
    // Name the actual size: "too large" leaves the uploader guessing whether
    // they need to crop, compress, or pick a different photo entirely.
    throw validationError([{
      path: 'photo',
      message: `That image is ${mb}MB. Please upload a JPEG or PNG under ${MAX_UPLOAD_MB}MB.`,
    }]);
  }
  // The mimetype is the browser's claim, not proof — processAvatar is what
  // actually verifies the bytes. This just rejects the obvious cases early.
  if (file.mimetype && !ALLOWED_MIME.has(file.mimetype)) {
    // Name the format only when it is a recognisable image type — telling
    // someone "APPLICATION/OCTET-STREAM is not supported" explains nothing.
    // Generic types arrive whenever a client cannot identify the file, so fall
    // back to plain language rather than echoing the header at the user.
    const raw = String(file.mimetype);
    const named = raw.startsWith('image/') ? raw.slice('image/'.length).toUpperCase() : null;
    throw validationError([{
      path: 'photo',
      message: named
        ? `${named} images are not supported. Please upload a JPEG or PNG.`
        : 'That file is not a supported image. Please upload a JPEG or PNG.',
    }]);
  }
  return file;
};

/**
 * Store bytes and return a public URL plus the key needed to delete them later.
 *
 * The key carries a uuid so re-uploading never collides with a cached copy of
 * the previous photo — CDNs and browsers key on URL, so reusing a path would
 * show the old image until the cache expired.
 */
export const putObject = async ({ buffer, contentType, ext, prefix }) => {
  const objectPath = `${prefix}/${randomUUID()}.${ext}`;

  if (!useGcs()) {
    const full = path.join(LOCAL_ROOT, objectPath);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, buffer);
    return { url: `${localPublicBase()}/${objectPath}`, objectPath, driver: 'local' };
  }

  const file = bucket().file(objectPath);
  await file.save(buffer, {
    contentType,
    resumable: false, // a 100kB avatar in one request beats a resumable session
    metadata: {
      // Immutable because the uuid in the path changes on every upload, so a
      // given URL's bytes can never change.
      cacheControl: 'public, max-age=31536000, immutable',
      contentDisposition: 'inline',
      metadata: { sha256: createHash('sha256').update(buffer).digest('hex') },
    },
  });

  return {
    url: `https://storage.googleapis.com/${env.GCS_BUCKET}/${objectPath}`,
    objectPath,
    driver: 'gcs',
  };
};

/**
 * Delete a previously stored object. Never throws: a failed cleanup must not
 * fail the request that replaced the photo — the new image is already live, and
 * an orphaned object costs fractions of a cent.
 */
export const deleteObject = async (objectPath) => {
  if (!objectPath) return false;
  try {
    if (!useGcs()) {
      await fs.unlink(path.join(LOCAL_ROOT, objectPath));
      return true;
    }
    await bucket().file(objectPath).delete({ ignoreNotFound: true });
    return true;
  } catch (err) {
    logger.warn({ err: err.message, objectPath }, 'could not delete old object');
    return false;
  }
};

export const storageInfo = () => ({
  driver: useGcs() ? 'gcs' : 'local',
  bucket: env.GCS_BUCKET || null,
  localRoot: useGcs() ? null : LOCAL_ROOT,
});

export const LOCAL_UPLOAD_ROOT = LOCAL_ROOT;
export const AVATAR_PIXELS = AVATAR_SIZE;
export const MAX_UPLOAD_MB = MAX_UPLOAD_BYTES / (1024 * 1024);
