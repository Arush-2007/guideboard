"use client";

import { CameraIcon, Loader2Icon, TrashIcon } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { AVATAR_MAX_BYTES } from "../lib/avatar-storage";
import { resizeAvatar } from "../lib/resize-image";
import { UserAvatar } from "./user-avatar";

/**
 * Picks, resizes and uploads an avatar.
 *
 * The upload goes to `/api/profile/avatar` rather than through tRPC because it
 * carries binary; see that route's header. Everything the user sees here is
 * optimistic-free on purpose — the round trip is short, and showing a face that
 * didn't actually store would be worse than a second of spinner.
 */

/** Generous: the picker filters to these, this catches a dragged oddity. */
const ACCEPTED = "image/png,image/jpeg,image/webp";

export const AvatarUploader = ({
  name,
  email,
  image,
  uploadEnabled,
  onChanged,
}: {
  name: string;
  email: string;
  image: string | null;
  uploadEnabled: boolean;
  /** Awaited before the success toast, so the new photo is on screen first. */
  onChanged: () => Promise<unknown>;
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const send = async (init: RequestInit) => {
    const response = await fetch("/api/profile/avatar", init);
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      throw new Error(body?.error ?? "Something went wrong. Try again.");
    }
  };

  const handleFile = async (file: File) => {
    setBusy(true);
    try {
      // Resize first: it both normalises the crop and puts almost every input
      // comfortably under the cap, so the size check below rarely fires.
      const resized = await resizeAvatar(file);
      if (resized.size > AVATAR_MAX_BYTES) {
        throw new Error("That image is too large — the limit is 2 MB.");
      }

      const form = new FormData();
      form.append("file", resized, "avatar");
      await send({ method: "POST", body: form });

      await onChanged();
      toast.success("Profile photo updated");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Couldn't update your photo",
      );
    } finally {
      setBusy(false);
      // Clear the input so re-picking the same file still fires a change event.
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const handleRemove = async () => {
    setBusy(true);
    try {
      await send({ method: "DELETE" });
      await onChanged();
      toast.success("Profile photo removed");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Couldn't remove your photo",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-4">
      <div className="relative">
        <UserAvatar
          name={name}
          email={email}
          image={image}
          className="size-20 ring-2 ring-primary/15"
          fallbackClassName="text-xl"
        />
        {busy ? (
          <span className="absolute inset-0 flex items-center justify-center rounded-full bg-background/70">
            <Loader2Icon className="size-5 animate-spin text-primary" />
          </span>
        ) : null}
      </div>

      {uploadEnabled ? (
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={inputRef}
              type="file"
              accept={ACCEPTED}
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void handleFile(file);
              }}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => inputRef.current?.click()}
            >
              <CameraIcon className="size-4" />
              {image ? "Change photo" : "Upload photo"}
            </Button>
            {image ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => void handleRemove()}
              >
                <TrashIcon className="size-4" />
                Remove
              </Button>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            PNG, JPEG or WebP. Cropped to a square automatically.
          </p>
        </div>
      ) : (
        <p className="max-w-xs text-xs text-muted-foreground">
          Photo uploads are unavailable — object storage isn&apos;t configured
          for this deployment.
        </p>
      )}
    </div>
  );
};
