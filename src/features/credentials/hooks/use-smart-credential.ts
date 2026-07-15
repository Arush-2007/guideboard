"use client";

import type { CredentialType } from "@/generated/prisma";
import { useCredentialsByType } from "./use-credentials";

export const useSmartCredential = (credentialType: CredentialType) => {
  const { data: credentials = [], isLoading } =
    useCredentialsByType(credentialType);
  const autoSelected = credentials.length === 1 ? credentials[0] : null;

  return {
    credentials,
    isLoading,
    autoSelected,
  };
};
