"use client";

import { format } from "date-fns";
import { BadgeCheckIcon, CheckIcon, PencilIcon, XIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";
import { useProfile, useRefreshProfile } from "../hooks/use-profile";
import { AvatarUploader } from "./avatar-uploader";

const MAX_NAME_LENGTH = 60;

/**
 * Identity at a glance: photo, name, address. The name is edited in place
 * rather than behind a dialog — it's a single field, and a modal for one input
 * is ceremony.
 */
export const ProfileHeader = () => {
  const { data: profile } = useProfile();
  const refreshProfile = useRefreshProfile();
  const router = useRouter();

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(profile.name);
  const [saving, setSaving] = useState(false);

  const startEditing = () => {
    setDraft(profile.name);
    setEditing(true);
  };

  /**
   * Refreshes both caches after a change. The tRPC query backs this page; the
   * router refresh is what makes the sidebar's server-rendered session catch
   * up, which it otherwise wouldn't for up to the session cookie cache's five
   * minutes.
   */
  const syncEverywhere = async () => {
    await refreshProfile();
    router.refresh();
  };

  const saveName = async () => {
    const name = draft.trim();
    if (!name) {
      toast.error("Your name can't be empty");
      return;
    }
    if (name === profile.name) {
      setEditing(false);
      return;
    }

    setSaving(true);
    const { error } = await authClient.updateUser({ name });
    setSaving(false);

    if (error) {
      toast.error(error.message ?? "Couldn't save your name");
      return;
    }

    setEditing(false);
    await syncEverywhere();
    toast.success("Name updated");
  };

  return (
    <Card className="rounded-3xl border border-primary/20 bg-card/90 shadow-sm">
      <CardContent className="flex flex-col gap-6 pt-6 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-center">
          <AvatarUploader
            name={profile.name}
            email={profile.email}
            image={profile.image}
            uploadEnabled={profile.avatarUploadEnabled}
            onChanged={syncEverywhere}
          />

          <div className="min-w-0 space-y-1">
            {editing ? (
              <div className="flex items-center gap-2">
                <Input
                  autoFocus
                  value={draft}
                  maxLength={MAX_NAME_LENGTH}
                  disabled={saving}
                  className="h-9 max-w-64"
                  aria-label="Your name"
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void saveName();
                    if (event.key === "Escape") setEditing(false);
                  }}
                />
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-8"
                  disabled={saving}
                  aria-label="Save name"
                  onClick={() => void saveName()}
                >
                  <CheckIcon className="size-4" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-8"
                  disabled={saving}
                  aria-label="Cancel"
                  onClick={() => setEditing(false)}
                >
                  <XIcon className="size-4" />
                </Button>
              </div>
            ) : (
              <div className="flex items-center gap-1.5">
                <h2 className="truncate text-xl font-semibold tracking-tight">
                  {profile.name}
                </h2>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7 text-muted-foreground"
                  aria-label="Edit name"
                  onClick={startEditing}
                >
                  <PencilIcon className="size-3.5" />
                </Button>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <p className="truncate text-sm text-muted-foreground">
                {profile.email}
              </p>
              {profile.emailVerified ? (
                <Badge
                  variant="secondary"
                  className="gap-1 text-emerald-600 dark:text-emerald-400"
                >
                  <BadgeCheckIcon className="size-3.5" />
                  Verified
                </Badge>
              ) : (
                <Badge variant="outline" className="text-muted-foreground">
                  Unverified
                </Badge>
              )}
            </div>
          </div>
        </div>

        <div className="text-sm text-muted-foreground sm:text-right">
          <p className="text-xs uppercase tracking-wide">Member since</p>
          <p className="font-medium text-foreground">
            {format(profile.createdAt, "d MMMM yyyy")}
          </p>
        </div>
      </CardContent>
    </Card>
  );
};
