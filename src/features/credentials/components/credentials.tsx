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
import { cn } from "@/lib/utils";
import { useEffect } from "react";
import { toast } from "sonner";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
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

export const CredentialsInstagramSection = () => {
  const { data, isPending } = useInstagramCredential();
  const disconnect = useDisconnectInstagram();

  return (
    <Card className="rounded-3xl border border-[#E1306C]/25 bg-card/90 shadow-sm">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-lg">
          <span className="flex size-9 items-center justify-center rounded-xl bg-[#E1306C]/15">
            <Image
              src="/logos/instagram.svg"
              alt="Instagram"
              width={22}
              height={22}
            />
          </span>
          Instagram
        </CardTitle>
        <CardDescription>
          Connect your Instagram account with OAuth to use Instagram features.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        {isPending ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : data ? (
          <>
            <p className="text-sm text-foreground">
              Connected as{" "}
              <span className="font-medium">
                @{data.instagramUsername}
              </span>
            </p>
            <Button
              type="button"
              variant="outline"
              className="w-full shrink-0 border-[#E1306C]/30 sm:w-auto"
              disabled={disconnect.isPending}
              onClick={() => disconnect.mutate()}
            >
              Disconnect
            </Button>
          </>
        ) : (
          <Button
            asChild
            className="w-full border-[#E1306C]/30 bg-[#E1306C] text-white hover:bg-[#E1306C]/90 sm:w-auto"
          >
            <Link href="/api/auth/instagram">Connect Instagram</Link>
          </Button>
        )}
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
    <Card className="rounded-3xl border border-[#FF0000]/25 bg-card/90 shadow-sm">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-lg">
          <span className="flex size-9 items-center justify-center rounded-xl bg-[#FF0000]/10">
            <Image
              src="/logos/youtube.svg"
              alt="YouTube"
              width={22}
              height={22}
            />
          </span>
          YouTube
        </CardTitle>
        <CardDescription>
          Connect your YouTube channel with OAuth to use YouTube features.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        {isPending ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : data ? (
          <>
            <p className="text-sm text-foreground">
              Connected as{" "}
              <span className="font-medium">{data.channelTitle}</span>
            </p>
            <Button
              type="button"
              variant="outline"
              className="w-full shrink-0 border-[#FF0000]/30 sm:w-auto"
              disabled={disconnect.isPending}
              onClick={() => disconnect.mutate()}
            >
              Disconnect
            </Button>
          </>
        ) : (
          <Button
            asChild
            className="w-full border-[#FF0000]/30 bg-[#FF0000] text-white hover:bg-[#FF0000]/90 sm:w-auto"
          >
            <Link href="/api/auth/youtube">Connect YouTube</Link>
          </Button>
        )}
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
  [CredentialType.XAI]: "/logos/xai.svg",
};

export const CredentialItem = ({ data }: { data: Credential }) => {
  const removeCredential = useRemoveCredential();

  const handleRemove = () => {
    removeCredential.mutate({ id: data.id });
  };

  const logo = credentialLogos[data.type] || "/logos/openai.svg";
  const isInstagram = data.type === CredentialType.INSTAGRAM;

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
        <div
          className={cn(
            "flex size-9 items-center justify-center rounded-xl",
            isInstagram ? "bg-[#E1306C]/15" : "bg-primary/10",
          )}
        >
          <Image src={logo} alt={data.type} width={20} height={20} />
        </div>
      }
      onRemove={handleRemove}
      isRemoving={removeCredential.isPending}
    />
  );
};
