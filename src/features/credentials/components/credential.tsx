"use client";

import { CredentialType } from "@/generated/prisma";
import Image from "next/image";
import { useRouter } from "next/navigation";
import {
  useCreateCredential,
  useUpdateCredential,
  useSuspenseCredential,
} from "../hooks/use-credentials";
import { useUpgradeModal } from "@/hooks/use-upgrade-modal";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import z from "zod";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { cn } from "@/lib/utils";

const formSchema = z
  .object({
    name: z.string().min(1, "Name is required"),
    type: z.nativeEnum(CredentialType),
    value: z.string().optional(),
    accessToken: z.string().optional(),
    instagramAccountId: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.type === CredentialType.INSTAGRAM) {
      if (!data.accessToken?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Access token is required",
          path: ["accessToken"],
        });
      }
      if (!data.instagramAccountId?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Instagram Account ID is required",
          path: ["instagramAccountId"],
        });
      }
    } else if (!data.value?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "API key is required",
        path: ["value"],
      });
    }
  });

type FormValues = z.infer<typeof formSchema>;

const credentialTypeOptions = [
  {
    value: CredentialType.OPENAI,
    label: "OpenAI",
    logo: "/logos/openai.svg",
  },
  {
    value: CredentialType.ANTHROPIC,
    label: "Anthropic",
    logo: "/logos/anthropic.svg",
  },
  {
    value: CredentialType.GEMINI,
    label: "Gemini",
    logo: "/logos/gemini.svg",
  },
  {
    value: CredentialType.INSTAGRAM,
    label: "Instagram",
    logo: "/logos/instagram.svg",
  },
  {
    value: CredentialType.NOTION,
    label: "Notion",
    logo: "/logos/notion.svg",
  },
  {
    value: CredentialType.TELEGRAM,
    label: "Telegram",
    logo: "/logos/telegram.svg",
  },
  {
    value: CredentialType.WHATSAPP,
    label: "WhatsApp",
    logo: "/logos/whatsapp.svg",
  },
  {
    value: CredentialType.XAI,
    label: "xAI (Grok)",
    logo: "/logos/xai.svg",
  },
  {
    value: CredentialType.GROQ,
    label: "Groq",
    logo: "/logos/groq.svg",
  },
];

interface CredentialFormProps {
  initialData?: {
    id?: string;
    name: string;
    type: CredentialType;
    value: string;
    accessToken?: string;
    instagramAccountId?: string;
  };
}

export const CredentialForm = ({ initialData }: CredentialFormProps) => {
  const router = useRouter();
  const createCredential = useCreateCredential();
  const updateCredential = useUpdateCredential();
  const { handleError, modal } = useUpgradeModal();

  const isEdit = !!initialData?.id;

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: initialData
      ? {
          name: initialData.name,
          type: initialData.type,
          value:
            initialData.type === CredentialType.INSTAGRAM
              ? ""
              : initialData.value,
          accessToken: initialData.accessToken ?? "",
          instagramAccountId: initialData.instagramAccountId ?? "",
        }
      : {
          name: "",
          type: CredentialType.OPENAI,
          value: "",
          accessToken: "",
          instagramAccountId: "",
        },
  });

  const onSubmit = async (values: FormValues) => {
    const base = {
      name: values.name,
      type: values.type,
    };

    if (isEdit && initialData?.id) {
      if (values.type === CredentialType.INSTAGRAM) {
        await updateCredential.mutateAsync({
          id: initialData.id,
          ...base,
          accessToken: values.accessToken,
          instagramAccountId: values.instagramAccountId,
        });
      } else {
        await updateCredential.mutateAsync({
          id: initialData.id,
          ...base,
          value: values.value,
        });
      }
    } else if (values.type === CredentialType.INSTAGRAM) {
      await createCredential.mutateAsync(
        {
          ...base,
          accessToken: values.accessToken,
          instagramAccountId: values.instagramAccountId,
        },
        {
          onSuccess: (data) => {
            router.push(`/credentials/${data.id}`);
          },
          onError: (error) => {
            handleError(error);
          },
        },
      );
    } else {
      await createCredential.mutateAsync(
        {
          ...base,
          value: values.value,
        },
        {
          onSuccess: (data) => {
            router.push(`/credentials/${data.id}`);
          },
          onError: (error) => {
            handleError(error);
          },
        },
      );
    }
  };

  const watchedType = form.watch("type");
  const isInstagram = watchedType === CredentialType.INSTAGRAM;

  return (
    <>
      {modal}
      <Card className="shadow-none">
        <CardHeader>
          <CardTitle>
            {isEdit ? "Edit Credential" : "Create Credential"}
          </CardTitle>
          <CardDescription>
            {isEdit
              ? "Update your API key or credential details"
              : "Add a new API key or credential to your account"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form
              onSubmit={form.handleSubmit(onSubmit)}
              className="space-y-6"
            >
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Name</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="My API key"
                        autoComplete="off"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="type"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Type</FormLabel>
                    <Select
                      onValueChange={field.onChange}
                      value={field.value}
                    >
                      <FormControl>
                        <SelectTrigger
                          className={cn(
                            "w-full",
                            isInstagram &&
                              "border-[#E1306C]/40 ring-[#E1306C]/20 focus-visible:ring-[#E1306C]/30",
                          )}
                        >
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {credentialTypeOptions.map((option) => (
                          <SelectItem
                            key={option.value}
                            value={option.value}
                          >
                            <div className="flex items-center gap-2">
                              <Image
                                src={option.logo}
                                alt={option.label}
                                width={16}
                                height={16}
                              />
                              {option.label}
                            </div>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {isInstagram ? (
                <>
                  <FormField
                    control={form.control}
                    name="accessToken"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Access Token</FormLabel>
                        <FormControl>
                          <Input
                            type="password"
                            autoComplete="off"
                            placeholder="Long-lived access token"
                            className="border-[#E1306C]/25 focus-visible:ring-[#E1306C]/25"
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="instagramAccountId"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Instagram Account ID</FormLabel>
                        <FormControl>
                          <Input
                            placeholder="Instagram-scoped account ID"
                            className="border-[#E1306C]/25 focus-visible:ring-[#E1306C]/25"
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </>
              ) : (
                <FormField
                  control={form.control}
                  name="value"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        {watchedType === CredentialType.TELEGRAM
                          ? "Bot token"
                          : watchedType === CredentialType.NOTION
                            ? "Internal integration token"
                            : watchedType === CredentialType.WHATSAPP
                              ? "Credential JSON"
                            : "API Key"}
                      </FormLabel>
                      <FormControl>
                        <Input
                          type="password"
                          placeholder={
                            watchedType === CredentialType.TELEGRAM
                              ? "123456789:AAH..."
                              : watchedType === CredentialType.NOTION
                                ? "secret_..."
                                : watchedType === CredentialType.WHATSAPP
                                  ? "{\"accessToken\":\"EA...\",\"phoneNumberId\":\"123456789012345\"}"
                                : watchedType === CredentialType.XAI
                                  ? "xai-..."
                                  : watchedType === CredentialType.GROQ
                                    ? "gsk_..."
                                    : "sk-..."
                          }
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}

              <div className="flex gap-4">
                <Button
                  type="submit"
                  disabled={
                    createCredential.isPending || updateCredential.isPending
                  }
                >
                  {isEdit ? "Update" : "Create"}
                </Button>
                <Button type="button" variant="outline" asChild>
                  <Link href="/credentials" prefetch>
                    Cancel
                  </Link>
                </Button>
              </div>
            </form>
          </Form>
        </CardContent>
      </Card>
    </>
  );
};

export const CredentialView = ({
  credentialId,
}: {
  credentialId: string;
}) => {
  const { data: credential } = useSuspenseCredential(credentialId);

  return <CredentialForm initialData={credential} />;
};
