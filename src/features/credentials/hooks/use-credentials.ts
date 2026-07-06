import { useTRPC } from "@/trpc/client"
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { useCredentialsParams } from "./use-credentials-params";
import { CredentialType } from "@/generated/prisma";

/**
 * Hook to fetch all credentials using suspense
 */
export const useSuspenseCredentials = () => {
  const trpc = useTRPC();
  const [params] = useCredentialsParams();
  
  return useSuspenseQuery(trpc.credentials.getMany.queryOptions(params));
};

/**
 * Hook to create a new credentials
 */
export const useCreateCredential = () => {
  const queryClient = useQueryClient();
  const trpc = useTRPC();

  return useMutation(
    trpc.credentials.create.mutationOptions({
      onSuccess: (data) => {
        toast.success(`Credential "${data.name}" created`);
        queryClient.invalidateQueries(
          trpc.credentials.getMany.queryOptions({}),
        );
        queryClient.invalidateQueries(trpc.credentials.getByType.queryFilter());
      },
      onError: (error) => {
        toast.error(`Failed to create credential: ${error.message}`);
      },
    }),
  );
};

/**
 * Hook to remove a credential
 */
export const useRemoveCredential = () => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  return useMutation(
    trpc.credentials.remove.mutationOptions({
      onSuccess: (data) => {
        toast.success(`Credential "${data.name}" removed`);
        queryClient.invalidateQueries(trpc.credentials.getMany.queryOptions({}));
        queryClient.invalidateQueries(
          trpc.credentials.getOne.queryFilter({ id: data.id }),
        );
        queryClient.invalidateQueries(trpc.credentials.getByType.queryFilter());
      }
    })
  )
}

/**
 * Hook to fetch a single credential using suspense
 */
export const useSuspenseCredential = (id: string) => {
  const trpc = useTRPC();
  return useSuspenseQuery(trpc.credentials.getOne.queryOptions({ id }));
};

/**
 * Hook to update a credential
 */
export const useUpdateCredential = () => {
  const queryClient = useQueryClient();
  const trpc = useTRPC();

  return useMutation(
    trpc.credentials.update.mutationOptions({
      onSuccess: (data) => {
        toast.success(`Credential "${data.name}" saved`);
        queryClient.invalidateQueries(
          trpc.credentials.getMany.queryOptions({}),
        );
        queryClient.invalidateQueries(
          trpc.credentials.getOne.queryOptions({ id: data.id }),
        );
        queryClient.invalidateQueries(trpc.credentials.getByType.queryFilter());
      },
      onError: (error) => {
        toast.error(`Failed to save credential: ${error.message}`);
      },
    }),
  );
};

/**
 * Hook to fetch credentials by type
 */
export const useCredentialsByType = (type: CredentialType) => {
  const trpc = useTRPC();
  return useQuery(trpc.credentials.getByType.queryOptions({ type }));
};

/**
 * Linked Instagram account (OAuth), without sensitive fields
 */
export const useInstagramCredential = () => {
  const trpc = useTRPC();
  return useQuery(trpc.credentials.getInstagram.queryOptions());
};

/**
 * Remove linked Instagram account for the current user
 */
export const useDisconnectInstagram = () => {
  const queryClient = useQueryClient();
  const trpc = useTRPC();

  return useMutation(
    trpc.credentials.disconnectInstagram.mutationOptions({
      onSuccess: () => {
        toast.success("Instagram disconnected");
        queryClient.invalidateQueries(
          trpc.credentials.getInstagram.queryOptions(),
        );
      },
      onError: (error) => {
        toast.error(error.message);
      },
    }),
  );
};

/**
 * Linked YouTube channel (OAuth), without sensitive fields
 */
export const useYoutubeCredential = () => {
  const trpc = useTRPC();
  return useQuery(trpc.credentials.getYoutube.queryOptions());
};

/**
 * Remove linked YouTube channel for the current user
 */
export const useDisconnectYoutube = () => {
  const queryClient = useQueryClient();
  const trpc = useTRPC();

  return useMutation(
    trpc.credentials.disconnectYoutube.mutationOptions({
      onSuccess: () => {
        toast.success("YouTube disconnected");
        queryClient.invalidateQueries(
          trpc.credentials.getYoutube.queryOptions(),
        );
      },
      onError: (error) => {
        toast.error(error.message);
      },
    }),
  );
};

/**
 * Linked Microsoft account (OAuth), without sensitive fields
 */
export const useMicrosoftCredential = () => {
  const trpc = useTRPC();
  return useQuery(trpc.credentials.getMicrosoft.queryOptions());
};

/**
 * Remove linked Microsoft account for the current user
 */
export const useDisconnectMicrosoft = () => {
  const queryClient = useQueryClient();
  const trpc = useTRPC();

  return useMutation(
    trpc.credentials.disconnectMicrosoft.mutationOptions({
      onSuccess: () => {
        toast.success("Microsoft disconnected");
        queryClient.invalidateQueries(
          trpc.credentials.getMicrosoft.queryOptions(),
        );
      },
      onError: (error) => {
        toast.error(error.message);
      },
    }),
  );
};

/**
 * Linked Google account (OAuth via sign-in), without sensitive fields
 */
export const useGoogleCredential = () => {
  const trpc = useTRPC();
  return useQuery(trpc.credentials.getGoogle.queryOptions());
};
