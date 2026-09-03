import { describe, it, expect, vi, beforeEach } from "vitest";

const apiFetch = vi.hoisted(() => vi.fn());

vi.mock("web/lib/api-client", () => ({ apiFetch }));
vi.mock("web/lib/api", () => ({ apiUrl: (p: string) => `API:${p}` }));

import {
  getMediaUploadUrl,
  uploadMedia,
  getMediaDownloadUrl,
  deleteMedia,
  confirmMediaUpload,
  uploadAvatar,
  getAvatarUrl,
} from "web/lib/media-api";

describe("avatar (B2) media helpers", () => {
  beforeEach(() => {
    apiFetch.mockReset();
  });

  it("uploadAvatar requests a presigned avatar upload then confirms", async () => {
    apiFetch
      .mockResolvedValueOnce({
        mediaId: "m-avatar",
        objectKey: "users/u1/avatar/abc.png",
        category: "avatar",
        uploadUrl: "https://s3/avatar-upload",
        contentType: "image/png",
        expiresIn: 900,
      })
      .mockResolvedValueOnce({ mediaId: "m-avatar", status: "ready" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));

    const file = new File(["x"], "me.png", { type: "image/png" });
    const result = await uploadAvatar(file);
    expect(result.mediaId).toBe("m-avatar");
    expect(result.objectKey).toContain("avatar");
    expect(apiFetch).toHaveBeenCalledWith("/media/upload-url", expect.anything());
    expect(apiFetch).toHaveBeenLastCalledWith("/media/confirm", {
      method: "POST",
      body: JSON.stringify({ mediaId: "m-avatar" }),
    });
    vi.unstubAllGlobals();
  });

  it("uploadAvatar rejects files over 2MB", async () => {
    const big = new File([new Uint8Array(2 * 1024 * 1024 + 1)], "big.png", { type: "image/png" });
    await expect(uploadAvatar(big)).rejects.toThrow(/2MB/);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("getAvatarUrl requests the owner-only avatar URL endpoint URL-encoded", async () => {
    apiFetch.mockResolvedValue({ url: "https://b2/avatar?sig=1", mediaId: "m1", expiresIn: 900 });
    await getAvatarUrl("m1");
    expect(apiFetch).toHaveBeenCalledWith("/media/avatar-url?mediaId=m1");
  });
});

describe("media-api", () => {
  beforeEach(() => {
    apiFetch.mockReset();
  });

  it("getMediaUploadUrl posts to /media/upload-url with validated args", async () => {
    apiFetch.mockResolvedValue({
      mediaId: "m1",
      objectKey: "users/u1/avatar/abc.png",
      category: "avatar",
      uploadUrl: "https://s3/presigned",
      expiresIn: 900,
    });
    const result = await getMediaUploadUrl({
      category: "avatar",
      filename: "me.png",
      contentType: "image/png",
      size: 1000,
    });
    expect(apiFetch).toHaveBeenCalledWith("/media/upload-url", {
      method: "POST",
      body: JSON.stringify({
        category: "avatar",
        filename: "me.png",
        contentType: "image/png",
        size: 1000,
      }),
    });
    expect(result.uploadUrl).toContain("s3");
  });

  it("getMediaDownloadUrl passes the object key URL-encoded", async () => {
    apiFetch.mockResolvedValue({ url: "https://s3/download?x=1", objectKey: "k", expiresIn: 900 });
    await getMediaDownloadUrl("users/u1/avatar/a b.png");
    expect(apiFetch).toHaveBeenCalledWith(
      "/media/download-url?key=users%2Fu1%2Favatar%2Fa%20b.png",
    );
  });

  it("deleteMedia issues an authorized DELETE", async () => {
    apiFetch.mockResolvedValue({ objectKey: "k", status: "deleted" });
    await deleteMedia("media/u1/abc/img.png");
    expect(apiFetch).toHaveBeenCalledWith("/media/", {
      method: "DELETE",
      body: JSON.stringify({ key: "media/u1/abc/img.png" }),
    });
  });

  it("confirmMediaUpload marks the record ready", async () => {
    apiFetch.mockResolvedValue({ mediaId: "m1", status: "ready" });
    await confirmMediaUpload("m1");
    expect(apiFetch).toHaveBeenCalledWith("/media/confirm", {
      method: "POST",
      body: JSON.stringify({ mediaId: "m1" }),
    });
  });

  it("uploadMedia PUTs bytes to the presigned URL then confirms", async () => {
    apiFetch
      .mockResolvedValueOnce({
        mediaId: "m1",
        objectKey: "users/u1/avatar/abc.png",
        category: "avatar",
        uploadUrl: "https://s3/presigned-upload",
        contentType: "image/png",
        expiresIn: 900,
      })
      .mockResolvedValueOnce({ mediaId: "m1", status: "ready" });

    const putMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", putMock);

    const file = new File(["x"], "me.png", { type: "image/png" });
    await uploadMedia({ category: "avatar", filename: "me.png", file });

    expect(fetch).toHaveBeenCalledWith(
      "https://s3/presigned-upload",
      expect.objectContaining({ method: "PUT", body: file }),
    );
    // confirm endpoint called after successful PUT
    expect(apiFetch).toHaveBeenLastCalledWith("/media/confirm", {
      method: "POST",
      body: JSON.stringify({ mediaId: "m1" }),
    });
    vi.unstubAllGlobals();
  });

  it("uploadMedia throws when the direct PUT fails and skips confirm", async () => {
    apiFetch.mockResolvedValueOnce({
      mediaId: "m1",
      objectKey: "k",
      category: "image",
      uploadUrl: "https://s3/presigned-upload",
      expiresIn: 900,
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 403 }));

    const file = new File(["x"], "a.png", { type: "image/png" });
    await expect(
      uploadMedia({ category: "image", filename: "a.png", file }),
    ).rejects.toThrow(/403/);
    expect(apiFetch).toHaveBeenCalledTimes(1); // confirm never called
    vi.unstubAllGlobals();
  });
});