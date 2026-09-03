import { apiFetch } from "web/lib/api-client";
import type {
  AvatarUrlResult,
  DownloadUrlResult,
  MediaCategory,
  UploadUrlResult,
} from "@strumm/types";

/**
 * Direct upload/download helpers for object-storage (Backblaze B2) media.
 *
 * The B2 bucket is private: the backend never sends credentials to the
 * browser. These functions request short-lived presigned URLs from the
 * backend, then the browser talks to B2 directly (no media proxied through
 * the API for large files).
 *
 * Upload flow:
 *   1. getMediaUploadUrl({...}) -> { mediaId, objectKey, uploadUrl }
 *   2. PUT the file bytes to uploadUrl with a `Content-Type` header.
 *   3. confirmMediaUpload(mediaId) to mark the record "ready".
 *
 * Access flow:
 *   getMediaDownloadUrl(objectKey) -> { url, expiresIn }
 *   Use `url` as the src of an <img>/<video>/<audio> (Range requests are
 *   respected by B2 for media playback).
 */

export interface GetUploadUrlArgs {
  category: MediaCategory;
  filename: string;
  contentType?: string;
  size: number;
  mediaId?: string;
}

/** Request a presigned PUT URL from the backend for a direct upload to B2. */
export async function getMediaUploadUrl(
  args: GetUploadUrlArgs,
): Promise<UploadUrlResult> {
  return apiFetch<UploadUrlResult>("/media/upload-url", {
    method: "POST",
    body: JSON.stringify(args),
  });
}

/** Mark a just-uploaded media record as "ready". */
export async function confirmMediaUpload(mediaId: string): Promise<void> {
  await apiFetch<{ mediaId: string; status: string }>("/media/confirm", {
    method: "POST",
    body: JSON.stringify({ mediaId }),
  });
}

/** Request a short-lived presigned GET URL for a private object. */
export async function getMediaDownloadUrl(
  objectKey: string,
): Promise<DownloadUrlResult> {
  return apiFetch<DownloadUrlResult>(
    `/media/download-url?key=${encodeURIComponent(objectKey)}`,
  );
}

/**
 * Resolve the *current user's* avatar media to a short-lived GET URL.
 * The owner-only endpoint authorizes access; callers should cache the result
 * and refresh it before `expiresIn` elapses (see `useUserAvatar`).
 */
export async function getAvatarUrl(mediaId: string): Promise<AvatarUrlResult> {
  return apiFetch<AvatarUrlResult>(
    `/media/avatar-url?mediaId=${encodeURIComponent(mediaId)}`,
  );
}

/** Authorized delete of an object owned by the current user. */
export async function deleteMedia(objectKey: string): Promise<void> {
  await apiFetch<{ objectKey: string; status: string }>("/media/", {
    method: "DELETE",
    body: JSON.stringify({ key: objectKey }),
  });
}

/**
 * Upload `file` directly to B2 using the presigned-upload flow, then confirm
 * the media record. Resolves with the upload result (mediaId + objectKey).
 * `size` is derived from the file blob, so it does not need to be passed.
 */
export async function uploadMedia(
  args: Omit<GetUploadUrlArgs, "size"> & { file: Blob | File },
): Promise<UploadUrlResult> {
  const { category, filename, file, mediaId } = args;
  const contentType = args.contentType || file.type || undefined;
  const size = file.size;

  const upload = await getMediaUploadUrl({
    category,
    filename,
    contentType,
    size,
    mediaId,
  });

  const putRes = await fetch(upload.uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": contentType || "application/octet-stream" },
    body: file,
  });
  if (!putRes.ok) {
    throw new Error(`Upload to storage failed with status ${putRes.status}`);
  }

  await confirmMediaUpload(upload.mediaId);
  return upload;
}

/**
 * Upload an avatar image to B2 and return the mediaId to attach to the user.
 * Validate size client-side (max 2MB) before the presigned request.
 */
export async function uploadAvatar(
  file: Blob | File,
  opts?: { maxBytes?: number },
): Promise<{ mediaId: string; objectKey: string }> {
  const maxBytes = opts?.maxBytes ?? 2 * 1024 * 1024;
  if (file.size > maxBytes) {
    throw new Error("File size must be less than 2MB.");
  }
  const upload = await uploadMedia({
    category: "avatar",
    filename: file instanceof File ? file.name : "avatar",
    file,
  });
  return { mediaId: upload.mediaId, objectKey: upload.objectKey };
}