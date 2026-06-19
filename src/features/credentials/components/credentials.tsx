"use client";

import { formatDistanceToNow } from "date-fns";
import {
  EmptyView,
  EntityContainer,
  EntityHeader,
  EntityItem,
  EntityList,
  EntityPagination,
  EntitySearch,
  ErrorView,
  LoadingView,
} from "@/components/entity-components";
import {
  useDisconnectInstagram,
  useDisconnectYoutube,
  useInstagramCredential,
  useRemoveCredential,
  useSuspenseCredentials,
  useYoutubeCredential,
} from "../hooks/use-credentials";
import { useRouter, useSearchParams } from "next/navigation";
import { useCredentialsParams } from "../hooks/use-credentials-params";
import { useEntitySearch } from "@/hooks/use-entity-search";
import type { Credential } from "@/generated/prisma";
import { CredentialType } from "@/generated/prisma";
import Image from "next/image";
import { useEffect } from "react";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MoreVerticalIcon, TrashIcon } from "lucide-react";
import Link from "next/link";

export const CredentialsInstagramAuthErrorToast = () => {
  const searchParams = useSearchParams();
  const router = useRouter();

  useEffect(() => {
    if (searchParams.get("error") !== "instagram_auth_failed") {
      return;
    }

    toast.error("Instagram connection failed. Please try again.");

    const next = new URLSearchParams(searchParams.toString());
    next.delete("error");
    const qs = next.toString();
    router.replace(qs ? `/credentials?${qs}` : "/credentials");
  }, [searchParams, router]);

  return null;
};

const INSTAGRAM_TOKEN_WARNING_MS = 10 * 24 * 60 * 60 * 1000;

export const CredentialsInstagramSection = () => {
  const { data, isPending } = useInstagramCredential();
  const disconnect = useDisconnectInstagram();

  const isExpiringSoon =
    data?.tokenExpiresAt != null &&
    new Date(data.tokenExpiresAt).getTime() < Date.now() + INSTAGRAM_TOKEN_WARNING_MS;

  return (
    <Card className="rounded-2xl border-border/70 p-4 shadow-sm">
      <CardContent className="flex flex-row items-center justify-between p-0">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/10">
            <Image src="/logos/instagram.svg" alt="Instagram" width={20} height={20} />
          </div>
          <div className="min-w-0">
            <p className="truncate text-base font-medium">Instagram</p>
            <p className="truncate text-xs text-muted-foreground">
              {isPending
                ? "Loading…"
                : data
                  ? `Connected as @${data.instagramUsername}${isExpiringSoon ? " · Token expiring soon — reconnect to refresh" : ""}`
                  : "Connect your Instagram account via OAuth"}
            </p>
          </div>
        </div>
        <div className="ml-4 shrink-0">
          {!isPending && !data && (
            <Button variant="outline" size="sm" className="rounded-full px-4" asChild>
              <Link href="/api/auth/instagram">Connect</Link>
            </Button>
          )}
          {!isPending && data && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="icon" variant="ghost" className="rounded-full">
                  <MoreVerticalIcon className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem asChild>
                  <Link href="/api/auth/instagram">Reconnect</Link>
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={disconnect.isPending}
                  onClick={() => disconnect.mutate()}
                >
                  <TrashIcon className="size-4" />
                  Disconnect
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </CardContent>
    </Card>
  );
};

export const CredentialsYoutubeAuthErrorToast = () => {
  const searchParams = useSearchParams();
  const router = useRouter();

  useEffect(() => {
    if (searchParams.get("error") !== "youtube_auth_failed") {
      return;
    }

    toast.error("YouTube connection failed. Please try again.");

    const next = new URLSearchParams(searchParams.toString());
    next.delete("error");
    const qs = next.toString();
    router.replace(qs ? `/credentials?${qs}` : "/credentials");
  }, [searchParams, router]);

  return null;
};

export const CredentialsYoutubeSection = () => {
  const { data, isPending } = useYoutubeCredential();
  const disconnect = useDisconnectYoutube();

  return (
    <Card className="rounded-2xl border-border/70 p-4 shadow-sm">
      <CardContent className="flex flex-row items-center justify-between p-0">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/10">
            <Image src="/logos/youtube.svg" alt="YouTube" width={20} height={20} />
          </div>
          <div className="min-w-0">
            <p className="truncate text-base font-medium">YouTube</p>
            <p className="truncate text-xs text-muted-foreground">
              {isPending
                ? "Loading…"
                : data
                  ? `Connected as ${data.channelTitle}`
                  : "Connect your YouTube channel via OAuth"}
            </p>
          </div>
        </div>
        <div className="ml-4 shrink-0">
          {!isPending && !data && (
            <Button variant="outline" size="sm" className="rounded-full px-4" asChild>
              <Link href="/api/auth/youtube">Connect</Link>
            </Button>
          )}
          {!isPending && data && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="icon" variant="ghost" className="rounded-full">
                  <MoreVerticalIcon className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem asChild>
                  <Link href="/api/auth/youtube">Reconnect</Link>
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={disconnect.isPending}
                  onClick={() => disconnect.mutate()}
                >
                  <TrashIcon className="size-4" />
                  Disconnect
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </CardContent>
    </Card>
  );
};

export const CredentialsSearch = () => {
  const [params, setParams] = useCredentialsParams();
  const { searchValue, onSearchChange } = useEntitySearch({
    params,
    setParams,
  });

  return (
    <EntitySearch
      value={searchValue}
      onChange={onSearchChange}
      placeholder="Search credentials"
    />
  );
};

export const CredentialsList = () => {
  const credentials = useSuspenseCredentials();

  return (
    <EntityList
      items={credentials.data.items}
      getKey={(credential) => credential.id}
      renderItem={(credential) => <CredentialItem data={credential} />}
      emptyView={<CredentialsEmpty />}
    />
  );
};

export const CredentialsHeader = ({ disabled }: { disabled?: boolean }) => {
  return (
    <EntityHeader
      title="Credentials"
      description="Create and manage your credentials"
      newButtonHref="/credentials/new"
      newButtonLabel="New credential"
      disabled={disabled}
    />
  );
};

export const CredentialsPagination = () => {
  const credentials = useSuspenseCredentials();
  const [params, setParams] = useCredentialsParams();

  return (
    <EntityPagination
      disabled={credentials.isFetching}
      totalPages={credentials.data.totalPages}
      page={credentials.data.page}
      onPageChange={(page) => setParams({ ...params, page })}
    />
  );
};

export const CredentialsContainer = ({
  children,
}: {
  children: React.ReactNode;
}) => {
  return (
    <EntityContainer
      header={<CredentialsHeader />}
      search={<CredentialsSearch />}
      pagination={<CredentialsPagination />}
    >
      {children}
    </EntityContainer>
  );
};

export const CredentialsLoading = () => {
  return <LoadingView message="Loading credentials..." />;
};

export const CredentialsError = () => {
  return <ErrorView message="Error loading credentials" />;
};

export const CredentialsEmpty = () => {
  const router = useRouter();

  const handleCreate = () => {
    router.push(`/credentials/new`);
  };

  return (
    <EmptyView
      onNew={handleCreate}
      message="You haven't created any credentials yet. Get started by creating your first credential"
    />
  );
};

const credentialLogos: Record<CredentialType, string> = {
  [CredentialType.OPENAI]: "/logos/openai.svg",
  [CredentialType.ANTHROPIC]: "/logos/anthropic.svg",
  [CredentialType.GEMINI]: "/logos/gemini.svg",
  [CredentialType.INSTAGRAM]: "/logos/instagram.svg",
  [CredentialType.NOTION]: "/logos/notion.svg",
  [CredentialType.TELEGRAM]: "/logos/telegram.svg",
  [CredentialType.WHATSAPP]: "/logos/whatsapp.svg",
  [CredentialType.XAI]: "/logos/xai.svg",
  [CredentialType.GROQ]: "/logos/groq.svg",
};

export const CredentialItem = ({ data }: { data: Credential }) => {
  const removeCredential = useRemoveCredential();

  const handleRemove = () => {
    removeCredential.mutate({ id: data.id });
  };

  const logo = credentialLogos[data.type] || "/logos/openai.svg";

  return (
    <EntityItem
      href={`/credentials/${data.id}`}
      title={data.name}
      subtitle={
        <>
          Updated {formatDistanceToNow(data.updatedAt, { addSuffix: true })}{" "}
          &bull; Created{" "}
          {formatDistanceToNow(data.createdAt, { addSuffix: true })}
        </>
      }
      image={
        <div className="flex size-9 items-center justify-center rounded-xl bg-primary/10">
          <Image src={logo} alt={data.type} width={20} height={20} />
        </div>
      }
      onRemove={handleRemove}
      isRemoving={removeCredential.isPending}
    />
  );
};
