"use client";

import { formatDistanceToNow } from "date-fns";
import { MoreVerticalIcon, TrashIcon } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { toast } from "sonner";
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
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Credential } from "@/generated/prisma";
import { CredentialType } from "@/generated/prisma";
import { authClient } from "@/lib/auth-client";
import { useEntitySearch } from "@/hooks/use-entity-search";
import {
  useDisconnectInstagram,
  useDisconnectYoutube,
  useGoogleCredential,
  useInstagramCredential,
  useRemoveCredential,
  useSuspenseCredentials,
  useYoutubeCredential,
} from "../hooks/use-credentials";
import { useCredentialsParams } from "../hooks/use-credentials-params";

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

const SectionHeading = ({ children }: { children: React.ReactNode }) => (
  <h2 className="px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
    {children}
  </h2>
);

// Shared row for the "Connected apps" section: logo tile + name + status on the
// left, a caller-supplied action (Connect button or overflow menu) on the right.
const ConnectedAppRow = ({
  logo,
  name,
  status,
  action,
}: {
  logo: string;
  name: string;
  status: React.ReactNode;
  action: React.ReactNode;
}) => {
  return (
    <Card className="rounded-2xl border-border/70 p-4 shadow-sm">
      <CardContent className="flex flex-row items-center justify-between p-0">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/10">
            <Image src={logo} alt={name} width={20} height={20} unoptimized />
          </div>
          <div className="min-w-0">
            <p className="truncate text-base font-medium">{name}</p>
            <p className="truncate text-xs text-muted-foreground">{status}</p>
          </div>
        </div>
        <div className="ml-4 shrink-0">{action}</div>
      </CardContent>
    </Card>
  );
};

// Connect / Reconnect+Disconnect controls for the OAuth apps whose connect flow
// is a plain link to an /api/auth/* route (Instagram, YouTube).
const OAuthAppActions = ({
  connected,
  authHref,
  onDisconnect,
  isDisconnecting,
}: {
  connected: boolean;
  authHref: string;
  onDisconnect: () => void;
  isDisconnecting: boolean;
}) => {
  if (!connected) {
    return (
      <Button variant="outline" size="sm" className="rounded-full px-4" asChild>
        <Link href={authHref}>Connect</Link>
      </Button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="icon" variant="ghost" className="rounded-full">
          <MoreVerticalIcon className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem asChild>
          <Link href={authHref}>Reconnect</Link>
        </DropdownMenuItem>
        <DropdownMenuItem disabled={isDisconnecting} onClick={onDisconnect}>
          <TrashIcon className="size-4" />
          Disconnect
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
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

// Google connect/reconnect goes through Better Auth account-linking (not a
// dedicated /api/auth route). Linking re-runs Google OAuth with the offline
// Sheets/Gmail/Drive/Forms scopes, and the account DB hook mirrors the tokens
// into GoogleCredential (see src/lib/auth.ts).
const connectGoogle = () => {
  authClient.linkSocial({ provider: "google", callbackURL: "/credentials" });
};

const GoogleAppActions = ({ connected }: { connected: boolean }) => {
  if (!connected) {
    return (
      <Button
        variant="outline"
        size="sm"
        className="rounded-full px-4"
        onClick={connectGoogle}
      >
        Connect
      </Button>
    );
  }

  // No Disconnect: Google may be the user's sign-in method, so removing the
  // credential from here would silently break Google nodes and is surprising.
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="icon" variant="ghost" className="rounded-full">
          <MoreVerticalIcon className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={connectGoogle}>Reconnect</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export const CredentialsConnectedAppsSection = () => {
  const instagram = useInstagramCredential();
  const youtube = useYoutubeCredential();
  const google = useGoogleCredential();
  const disconnectInstagram = useDisconnectInstagram();
  const disconnectYoutube = useDisconnectYoutube();

  const instagramExpiringSoon =
    instagram.data?.tokenExpiresAt != null &&
    new Date(instagram.data.tokenExpiresAt).getTime() <
      Date.now() + INSTAGRAM_TOKEN_WARNING_MS;

  return (
    <div className="flex flex-col gap-3">
      <SectionHeading>Connected apps</SectionHeading>

      <ConnectedAppRow
        logo="/logos/instagram.svg"
        name="Instagram"
        status={
          instagram.isPending
            ? "Loading…"
            : instagram.data
              ? `Connected as @${instagram.data.instagramUsername}${instagramExpiringSoon ? " · Token expiring soon — reconnect to refresh" : ""}`
              : "Connect your Instagram account via OAuth"
        }
        action={
          instagram.isPending ? null : (
            <OAuthAppActions
              connected={!!instagram.data}
              authHref="/api/auth/instagram"
              onDisconnect={() => disconnectInstagram.mutate()}
              isDisconnecting={disconnectInstagram.isPending}
            />
          )
        }
      />

      <ConnectedAppRow
        logo="/logos/youtube.svg"
        name="YouTube"
        status={
          youtube.isPending
            ? "Loading…"
            : youtube.data
              ? `Connected as ${youtube.data.channelTitle}`
              : "Connect your YouTube channel via OAuth"
        }
        action={
          youtube.isPending ? null : (
            <OAuthAppActions
              connected={!!youtube.data}
              authHref="/api/auth/youtube"
              onDisconnect={() => disconnectYoutube.mutate()}
              isDisconnecting={disconnectYoutube.isPending}
            />
          )
        }
      />

      <ConnectedAppRow
        logo="/logos/google.svg"
        name="Google"
        status={
          google.isPending
            ? "Loading…"
            : google.data
              ? `Connected as ${google.data.email}`
              : "Powers the Gmail, Sheets, Drive & Forms nodes — connect via Google"
        }
        action={
          google.isPending ? null : (
            <GoogleAppActions connected={!!google.data} />
          )
        }
      />
    </div>
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

// Wraps the DB-backed credential list under an "API keys" heading so it reads as
// a distinct group from the OAuth "Connected apps" section above it.
export const CredentialsApiKeysSection = ({
  children,
}: {
  children: React.ReactNode;
}) => {
  return (
    <div className="flex flex-col gap-3">
      <SectionHeading>API keys</SectionHeading>
      {children}
    </div>
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
      title="No API keys yet"
      newLabel="New credential"
      message="Add an API key to use the AI, messaging, and integration nodes (OpenAI, Anthropic, Telegram, Notion, and more)."
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
  [CredentialType.AFFINDA]: "/logos/affinda.svg",
  [CredentialType.LEVER]: "/logos/lever.svg",
  [CredentialType.TYPEFORM]: "/logos/typeform.svg",
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
